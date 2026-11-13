/**
 * 自然榜「越跑越慢」定位到语句（2026-11-13）。
 *
 * `probe-run-cost.py` 量出两件事随库规模变差：每轮灌入 30 → 182 ms、每次取面
 * 1.0 → 4.9 s。两个数都只说明「有东西在按行数付费」，不说是哪一条。
 *
 * 这里把 `node:sqlite` 的 `prepare/run/all/get` 包一层，按 SQL 模板聚合
 * **累计执行时间**，分两个窗口报：早期（前 300 轮）与晚期（最后 300 轮）。
 * 如果某条模板的「每次耗时」在晚期变大，它就是随行数退化的那条。
 *
 *   node bench-22/probe-hot-path.mjs [--persona M02] [--turns 2500]
 *
 * 只读：不改 `lib/`，探针自己的库在临时目录，跑完删掉。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const PERSONA = arg('persona', 'M02');
const TURNS = Number(arg('turns', 2500));
const WARM = Number(arg('warm', 300));

/* ── 打点 ──────────────────────────────────────────────────────────────── */
/** 模板 → { n, ms, max }。`ms` 是**执行**时间，不含 prepare。 */
const stats = new Map();
let watching = false;
const label = (sql) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 110);
const bump = (sql, ms) => {
	if (!watching) return;
	const key = label(sql);
	const one = stats.get(key) ?? { n: 0, ms: 0, max: 0 };
	one.n += 1;
	one.ms += ms;
	one.max = Math.max(one.max, ms);
	stats.set(key, one);
};
for (const name of ['run', 'all', 'get']) {
	const orig = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...a) {
		if (!watching) return orig.apply(this, a);
		const began = performance.now();
		try {
			return orig.apply(this, a);
		} finally {
			bump(this.sourceSQL ?? this.sql ?? '?', performance.now() - began);
		}
	};
}
/* `StatementSync` 没暴露 SQL 文本，prepare 时塞一份到实例上。 */
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
	const stmt = origPrepare.call(this, sql, ...rest);
	try {
		Object.defineProperty(stmt, 'sourceSQL', { value: String(sql), enumerable: false });
	} catch {
		// 不可写就算了，聚合键会退化成 '?'
	}
	return stmt;
};

const rows = fs
	.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.slice(0, TURNS)
	.map((line) => JSON.parse(line));

const { createLoom } = await import('../loom-e2e/harness.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-hot-'));
const loom = createLoom({
	dbPath: path.join(dir, 'loom.db'),
	config: { consolidation: { triggerTokens: 0 } },
	settleRounds: 1,
});

const feed = async (row, n) => loom.turn(PERSONA, row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });

/* 预热：建表、语句编译。 */
for (const row of rows.slice(0, 20)) await feed(row);
stats.clear();

const windows = [
	{ name: '早期', from: 20, to: WARM },
	{ name: '晚期', from: rows.length - WARM, to: rows.length },
];
const report = {};
let pos = 20;
for (const win of windows) {
	/* 两个窗口之间那段也要真的灌进去：只灌窗口本身，晚期窗口面对的会是一个
	 * 六百轮的库，「随规模退化」就无从谈起（第一版就是这么错的）。 */
	while (pos < win.from) {
		await feed(rows[pos]);
		pos += 1;
	}
	stats.clear();
	watching = true;
	const began = performance.now();
	while (pos < win.to) {
		await feed(rows[pos]);
		pos += 1;
	}
	const total = performance.now() - began;
	watching = false;
	const top = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 8);
	report[win.name] = new Map(top.map(([sql, one]) => [sql, one]));
	console.log(`\n=== ${win.name}（第 ${win.from + 1}–${win.to} 轮，${win.to - win.from} 轮，合计 ${(total / 1000).toFixed(1)}s，${(total / (win.to - win.from)).toFixed(1)} ms/轮）===`);
	for (const [sql, one] of top) {
		console.log(`  ${(one.ms / 1000).toFixed(2).padStart(7)}s  ${String(one.n).padStart(6)}次  均 ${(one.ms / one.n).toFixed(2).padStart(7)}ms  峰 ${one.max.toFixed(1).padStart(7)}ms  ${sql}`);
	}
}

/* 同一条模板在早/晚两窗口的「每次耗时」之比：涨得最多的就是随行数退化的那条。 */
const growth = [];
for (const [sql, late] of report['晚期'] ?? []) {
	const early = report['早期']?.get(sql);
	if (!early) continue;
	growth.push({ sql, ratio: late.ms / late.n / (early.ms / early.n), earlyMs: early.ms / early.n, lateMs: late.ms / late.n, n: late.n });
}
growth.sort((a, b) => b.ratio - a.ratio);
console.log('\n=== 每次耗时涨得最多的模板 ===');
for (const one of growth.slice(0, 6)) {
	console.log(`  ×${one.ratio.toFixed(1).padStart(5)}  ${one.earlyMs.toFixed(2)} → ${one.lateMs.toFixed(2)} ms（${one.n} 次）  ${one.sql}`);
}

/* ── 取面三段 ──────────────────────────────────────────────────────────── */
const db = new DatabaseSync(path.join(dir, 'loom.db'), { readOnly: true });
const one = (sql) => db.prepare(sql).get();
console.log(`\n=== 库 ===  l0 ${one('SELECT COUNT(*) AS n FROM l0').n} 行  facts ${one('SELECT COUNT(*) AS n FROM facts').n}  events ${one('SELECT COUNT(*) AS n FROM events').n}`);
db.close();

const step = (name, fn) => {
	watching = true;
	stats.clear();
	const began = performance.now();
	const out = fn();
	const ms = performance.now() - began;
	watching = false;
	const top = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 4);
	console.log(`\n${name}：${ms.toFixed(0)} ms`);
	for (const [sql, s] of top) console.log(`  ${s.ms.toFixed(1).padStart(7)}ms  ${String(s.n).padStart(4)}次  ${sql}`);
	return out;
};

const now = Date.parse(rows[rows.length - 1]['逻辑时间']);
/* 连调三次：第一次是**冷**缓存（`rewind` 之后每题都要经历这一次），第二三次是
 * 温的。两者差多少，就是「每题重扫全库」的代价。 */
const blocks = [];
for (let i = 1; i <= 3; i += 1) {
	const text = step(`memoryBlock #${i}`, () => loom.memoryBlock(PERSONA, { at: now }));
	blocks.push(text.length);
}
console.log(`  块长度 ${blocks.join(' / ')} 字（三次应当一致）`);
const q = rows[rows.length - 1]['用户消息'];
const hits = step(`memory_search("${q.slice(0, 14)}")`, () => loom.call('memory_search', { query: q, limit: 10 }, PERSONA));
const refs = [...String(hits).matchAll(/#([FEPL]\d+(?:-\d+)?)/g)].map((m) => m[1]).slice(0, 2);
for (const ref of refs) step(`expand #${ref}`, () => loom.call('memory_expand', { ref: '#' + ref }, PERSONA));

loom.dispose?.();
/* 诊断完还想对着这个库跑 `EXPLAIN QUERY PLAN` 的话，`--keep` 拷贝到 work/。
 * 灌一轮要一分钟，有库在手就不用每次重灌。 */
if (argv.includes('--keep')) {
	const out = path.join(HERE, 'work', `loom-${PERSONA}-${rows.length}.db`);
	fs.rmSync(out, { force: true });
	const side = new DatabaseSync(path.join(dir, 'loom.db'));
	try {
		side.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
	} finally {
		side.close();
	}
	console.log(`\n库已保留：${out}`);
}
fs.rmSync(dir, { recursive: true, force: true });
