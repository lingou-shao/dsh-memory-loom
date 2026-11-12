/**
 * 一轮对话、一次检索各发多少条 SQL —— 用来判断「要不要做批量 / 分批 IN」。
 *
 * 朋友的建议里有一条是「IO 性能可以试分批/批量 IN 查询」。这条建议的前提是
 * **存在 N+1**：拿一批 id 之后逐条再查。所以先把语句条数量出来：
 *
 *   node bench-22/probe-sql-count.mjs [--turns 200]
 *
 * 量的三件事：
 *  - 每轮入库的语句条数，以及 `prepare` 占总时间的比例（prepare 也在计时里）；
 *  - 一次 `memory_search` 的语句条数与耗时（这是热路径，用户每次说话都走）；
 *  - 「重复编译同一条 SQL」的次数 —— 若是常数级（几十条固定模板），批量 IN
 *    没有收益；若是随行数增长，才值得动。
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
	return i >= 0 ? Number(argv[i + 1]) : fallback;
};
const TURNS = arg('turns', 200);

/* ── 打点：在 import harness 之前包一层 prototype ──────────────────────── */
const counter = { prepare: 0, run: 0, all: 0, get: 0, exec: 0, prepareMs: 0 };
const sqlSeen = new Map();
const proto = DatabaseSync.prototype;
const wrap = (name, bucket) => {
	const orig = proto[name];
	proto[name] = function (...a) {
		counter[bucket] += 1;
		return orig.apply(this, a);
	};
};
const origPrepare = proto.prepare;
proto.prepare = function (sql, ...rest) {
	const began = performance.now();
	const stmt = origPrepare.call(this, sql, ...rest);
	counter.prepareMs += performance.now() - began;
	counter.prepare += 1;
	const key = String(sql).replace(/\s+/g, ' ').trim().slice(0, 90);
	sqlSeen.set(key, (sqlSeen.get(key) ?? 0) + 1);
	return stmt;
};
wrap('exec', 'exec');
/* 执行语句的方法挂在 `StatementSync` 上，不在 `DatabaseSync` 上。 */
for (const name of ['run', 'all', 'get']) {
	const orig = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...a) {
		counter[name] += 1;
		return orig.apply(this, a);
	};
}
const reset = () => {
	for (const k of Object.keys(counter)) counter[k] = 0;
};

/* ── 数据 ──────────────────────────────────────────────────────────────── */
const rows = fs
	.readFileSync(path.join(DATA, 'histories', 'M01.jsonl'), 'utf8')
	.split('\n')
	.filter((l) => l.trim())
	.slice(0, TURNS)
	.map((l) => JSON.parse(l));

const { createLoom } = await import('../loom-e2e/harness.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sqlcount-'));
const loom = createLoom({
	dbPath: path.join(dir, 'loom.db'),
	config: { consolidation: { triggerTokens: 0 } },
	settleRounds: 1,
});

/* 前 20 轮当预热，不计入：建表、准备语句都在这一段。 */
for (const row of rows.slice(0, 20)) await loom.turn('M01', row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
sqlSeen.clear();

reset();
const began = performance.now();
for (const row of rows.slice(20)) await loom.turn('M01', row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
const ingestMs = performance.now() - began;
const n = rows.length - 20;

console.log(`\n=== 入库（${n} 轮，M01）===`);
console.log(`  每轮语句   prepare ${(counter.prepare / n).toFixed(1)}  run ${(counter.run / n).toFixed(1)}  all ${(counter.all / n).toFixed(1)}  get ${(counter.get / n).toFixed(1)}  exec ${(counter.exec / n).toFixed(1)}`);
console.log(`  每轮耗时   ${(ingestMs / n).toFixed(1)} ms，其中 prepare ${(counter.prepareMs / n).toFixed(2)} ms（${((counter.prepareMs / ingestMs) * 100).toFixed(1)}%）`);
console.log(`  不同 SQL 模板 ${sqlSeen.size} 条`);
const top = [...sqlSeen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
for (const [sql, c] of top) console.log(`    ${String(c).padStart(5)}×  ${sql}`);
console.log(`  出现次数最多的模板占 ${(((top[0]?.[1] ?? 0) / n) * 100).toFixed(0)}% 的轮`);

/* ── 检索 ──────────────────────────────────────────────────────────────── */
reset();
const q = '我拔的是哪颗牙';
const t0 = performance.now();
const hits = await loom.call('memory_search', { query: q }, 'M01');
const searchMs = performance.now() - t0;
const text = typeof hits === 'string' ? hits : JSON.stringify(hits);
console.log(`\n=== 检索 memory_search（"${q}"）===`);
console.log(`  语句       ${counter.prepare} 次 prepare / ${counter.run + counter.all + counter.get} 次执行  ${searchMs.toFixed(0)} ms  返回 ${text.length} 字`);

/* 一次 `memoryBlock`（自动注入的那一段，每步都要渲染） */
reset();
const tb = performance.now();
const block = loom.memoryBlock('M01');
console.log(`=== 渲染 memoryBlock ===`);
console.log(`  语句       ${counter.prepare} 次 prepare / ${counter.run + counter.all + counter.get} 次执行  ${(performance.now() - tb).toFixed(0)} ms  ${block.length} 字`);

/* ── 库形态 ────────────────────────────────────────────────────────────── */
const db = new DatabaseSync(path.join(dir, 'loom.db'), { readOnly: true });
const one = (sql) => db.prepare(sql).get();
console.log(`\n=== 库 ===`);
console.log(`  l0 ${one('SELECT COUNT(*) AS n FROM l0').n} 行  facts ${one('SELECT COUNT(*) AS n FROM facts').n}  events ${one('SELECT COUNT(*) AS n FROM events').n}`);
db.close();
loom.close();
fs.rmSync(dir, { recursive: true, force: true });
