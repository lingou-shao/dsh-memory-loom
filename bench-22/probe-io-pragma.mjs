/**
 * PRAGMA 调优在**我们真实的库规模**上能省多少 —— 把「听起来对」变成读数。
 *
 * 朋友的建议里有一条是「IO 性能可以试分批/批量 IN 查询和 PRAGMA 调优」。
 * 批量 IN 已经在 `probe-sql-count.mjs` 里量过（37 条模板、没有 id 集合的逐条查）。
 * 这里只量 PRAGMA：在 6,000 行的库上，同一条 bm25 查询用产品默认设置跑一遍，
 * 再用「文档里常见的调优组合」跑一遍，看差多少。
 *
 *   node bench-22/probe-io-pragma.mjs
 *
 * 结论如果差得出来才有意义；差不出来就说明这条路在我们这个规模上是空的，
 * 别再花第二次时间。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));

const { createLoom } = await import('../loom-e2e/harness.mjs');
const rows = fs
	.readFileSync(path.join(DATA, 'histories', 'M01.jsonl'), 'utf8')
	.split('\n')
	.filter((l) => l.trim())
	.slice(0, 400)
	.map((l) => JSON.parse(l));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-iopragma-'));
const dbFile = path.join(dir, 'loom.db');
const loom = createLoom({ dbPath: dbFile, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
for (const row of rows) await loom.turn('M01', row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
loom.dispose();

/* 复制到自然榜的规模（M01 全程 7,043 轮 ≈ 14,000 行；这里做到 ~6,000 行，
 * 和 76 题那批的库同一量级）。FTS 是 external content，复制完要 rebuild。 */
{
	const db = new DatabaseSync(dbFile);
	const before = db.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
	for (let i = 0; i < 7; i += 1) {
		db.exec(
			`INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, consolidated)
			 SELECT session_id, identity_id, turn + ${(i + 1) * 10000}, role, text, tokens, created_at, 1 FROM l0
			 WHERE id <= ${before}`,
		);
	}
	db.exec("INSERT INTO l0_fts(l0_fts) VALUES('rebuild')");
	const after = db.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
	db.close();
	console.log(`库：${before} → ${after} 行，文件 ${(fs.statSync(dbFile).size / 1024 / 1024).toFixed(2)} MB`);
}

const sql = `SELECT l.id, l.text FROM l0_fts CROSS JOIN l0 l
	WHERE l0_fts MATCH ? AND l.id = l0_fts.rowid AND l.identity_id = ?
	ORDER BY bm25(l0_fts) LIMIT 10`;
const queries = ['拔牙', '奶茶', '加班', '胃疼', '周末', '手机', '医院', '下雨'];

function time(label, pragmas) {
	const db = new DatabaseSync(dbFile, { readOnly: true });
	for (const p of pragmas) db.exec(`PRAGMA ${p}`);
	console.log(`  ${label}`);
	for (const p of pragmas) console.log(`      ${p} → ${JSON.stringify(Object.values(db.prepare(`PRAGMA ${p.split('=')[0]}`).get() ?? {})[0])}`);
	const spent = [];
	for (let round = 0; round < 25; round += 1) {
		for (const q of queries) {
			const began = performance.now();
			db.prepare(sql).all(`"${q}"`, 'M01');
			spent.push(performance.now() - began);
		}
	}
	spent.sort((a, b) => a - b);
	db.close();
	const p50 = spent[Math.floor(spent.length / 2)];
	const p95 = spent[Math.floor(spent.length * 0.95)];
	console.log(`      查询 ${spent.length} 次：p50 ${p50.toFixed(2)} ms  p95 ${p95.toFixed(2)} ms  合计 ${spent.reduce((a, b) => a + b, 0).toFixed(0)} ms`);
	return p50;
}

console.log('\n=== 同一条 bm25 查询，两种 PRAGMA（各 200 次）===');
const base = time('产品默认（WAL / synchronous=NORMAL / 无 cache_size / 无 mmap）', []);
const tuned = time(
	'常见调优组合（cache_size 64MB / mmap 256MB / temp_store 内存）',
	['cache_size = -64000', 'mmap_size = 268435456', 'temp_store = MEMORY'],
);
console.log(`\n  p50 差 ${(tuned - base).toFixed(2)} ms（${(((tuned - base) / base) * 100).toFixed(1)}%）`);

/* ── 向量那一路：穷举汉明距离在我们这个规模要多久 ────────────────────── */
console.log('\n=== 二值向量的穷举扫描（不看模型，只看索引/距离本身）===');
const N = 14_000;
const DIM = 256; // bge-small 二值化后是 256 bit
const words = DIM / 32;
const bank = new Uint32Array(N * words);
for (let i = 0; i < bank.length; i += 1) bank[i] = (Math.random() * 2 ** 32) >>> 0;
const probe = new Uint32Array(words);
for (let i = 0; i < words; i += 1) probe[i] = (Math.random() * 2 ** 32) >>> 0;

function popcount(x) {
	let v = x - ((x >> 1) & 0x55555555);
	v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
	return (((v + (v >> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
}
const t0 = performance.now();
let best = 0;
let bestD = Infinity;
for (let i = 0; i < N; i += 1) {
	let d = 0;
	for (let w = 0; w < words; w += 1) d += popcount(bank[i * words + w] ^ probe[w]);
	if (d < bestD) {
		bestD = d;
		best = i;
	}
}
const scanMs = performance.now() - t0;
console.log(`  ${N} 条 × ${DIM} bit 全表穷举 + 取最近：${scanMs.toFixed(2)} ms（找到 #${best}，距离 ${bestD}）`);
console.log(`  索引内存 ${((N * DIM) / 8 / 1024).toFixed(0)} KB —— 全部塞进内存毫无压力`);

loom.dispose();
fs.rmSync(dir, { recursive: true, force: true });
