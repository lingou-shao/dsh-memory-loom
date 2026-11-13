/**
 * `ORDER BY bm25()` vs `ORDER BY rank`：同一条查询、同一个库，只换排序写法。
 *
 * SQLite 官方文档 5.2 节的原话是「using "rank" is faster than using bm25()」，
 * 理由是后者作为一个表达式求值，SQLite 必须把全部匹配行算出来再排序；而 `rank`
 * 是 FTS5 的隐藏列，可以带着 LIMIT 提前停。带列权重的等价写法是
 * `WHERE ... AND rank MATCH 'bm25(5.0, 1.0)'`。
 *
 * 这里要量三件事：
 *   1. 耗时差多少、随命中行数怎么变；
 *   2. 结果行**是否逐行相同**（含顺序）——换了写法而顺序变了就不是优化；
 *   3. 把 JOIN 到主表这一步也放进去，看提前退出会不会被 JOIN 挡住。
 *
 *   node bench-22/probe-rank-order.mjs --db bench-22/work/cmp-m02.db
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const dbIn = arg('db', path.join(HERE, 'work', 'cmp-m02.db'));
const PERSONA = arg('persona', 'M02');
const REPS = Number(arg('reps', 20));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rank-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, copy);
const db = new DatabaseSync(copy);
db.exec('PRAGMA cache_size = -32000');
const n0 = db.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
console.log(`库 ${n0} 行 l0\n`);

/* 宽窄两档：窄的命中几十行，宽的命中几千行——排序代价由后者决定。 */
const EXPRS = [
	['窄 "灯箱"', '"灯箱"'],
	['中 "今天" OR "晚上"', '"今天" OR "晚上"'],
	['宽 十个二元组 OR', '"今天" OR "明天" OR "晚上" OR "早上" OR "回来" OR "时候" OR "一个" OR "我们" OR "什么" OR "现在"'],
];
for (const [, expr] of EXPRS) {
	const n = db.prepare('SELECT COUNT(*) AS n FROM l0_fts WHERE l0_fts MATCH ?').get(expr).n;
	console.log(`  命中 ${String(n).padStart(5)} 行  ${expr.slice(0, 40)}`);
}

const time = (fn, reps) => {
	fn();
	const began = performance.now();
	for (let i = 0; i < reps; i++) fn();
	return (performance.now() - began) / reps;
};
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

console.log('\n=== A. 只读 FTS 表（不 JOIN 主表）===');
const bare = {
	slow: db.prepare('SELECT rowid, bm25(l0_fts, 1.0, 1.0) AS s FROM l0_fts WHERE l0_fts MATCH ? ORDER BY s LIMIT 40'),
	fast: db.prepare('SELECT rowid FROM l0_fts WHERE l0_fts MATCH ? ORDER BY rank LIMIT 40'),
};
for (const [name, expr] of EXPRS) {
	const a = bare.slow.all(expr);
	const b = bare.fast.all(expr);
	const msSlow = time(() => bare.slow.all(expr), REPS);
	const msFast = time(() => bare.fast.all(expr), REPS);
	console.log(
		`  ${name.padEnd(18)} bm25 ${msSlow.toFixed(2).padStart(7)}ms   rank ${msFast.toFixed(2).padStart(7)}ms  ` +
			`${(msSlow / msFast).toFixed(1)}×  ${same(a.map((r) => r.rowid), b.map((r) => r.rowid)) ? '行序相同' : '行序不同 ✗'}`,
	);
}

console.log('\n=== B. 带上 JOIN 主表（产品实际形状）===');
const joined = {
	slow: db.prepare(
		'SELECT l.id, l.turn, l.text, bm25(l0_fts, 1.0, 1.0) AS s FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY s LIMIT 40',
	),
	fast: db.prepare(
		'SELECT l.id, l.turn, l.text FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY rank LIMIT 40',
	),
	cross: db.prepare(
		'SELECT l.id, l.turn, l.text FROM l0_fts CROSS JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY rank LIMIT 40',
	),
};
for (const [name, expr] of EXPRS) {
	const a = joined.slow.all(expr, PERSONA);
	const b = joined.fast.all(expr, PERSONA);
	const c = joined.cross.all(expr, PERSONA);
	const msSlow = time(() => joined.slow.all(expr, PERSONA), REPS);
	const msFast = time(() => joined.fast.all(expr, PERSONA), REPS);
	const msCross = time(() => joined.cross.all(expr, PERSONA), REPS);
	console.log(
		`  ${name.padEnd(18)} bm25 ${msSlow.toFixed(2).padStart(7)}ms  rank ${msFast.toFixed(2).padStart(7)}ms  rank+CROSS ${msCross.toFixed(2).padStart(7)}ms  ` +
			`${same(a.map((r) => r.id), b.map((r) => r.id)) && same(a.map((r) => r.id), c.map((r) => r.id)) ? '行序相同' : '行序不同 ✗'}`,
	);
}
for (const [tag, sql] of [
	['JOIN + ORDER BY bm25', 'SELECT l.id FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 40'],
	['JOIN + ORDER BY rank', 'SELECT l.id FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY rank LIMIT 40'],
	['CROSS JOIN + ORDER BY rank', 'SELECT l.id FROM l0_fts CROSS JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY rank LIMIT 40'],
]) {
	console.log(`\n  ${tag}`);
	for (const row of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('"今天"', PERSONA)) console.log(`     ${row.detail}`);
}

console.log('\n=== C. 带列权重的 facts_fts（5.0, 1.0, 2.0, 5）===');
const factsSlow = db.prepare(
	'SELECT f.id, f.text, bm25(facts_fts, 5.0, 1.0, 2.0, 5.0) AS s FROM facts_fts CROSS JOIN facts f WHERE facts_fts MATCH ? AND f.id = facts_fts.rowid AND f.identity_id = ? AND f.status IN (\'active\',\'disputed\') ORDER BY s LIMIT 10',
);
const factsFast = db.prepare(
	'SELECT f.id, f.text FROM facts_fts CROSS JOIN facts f WHERE facts_fts MATCH ? AND rank MATCH \'bm25(5.0, 1.0, 2.0, 5.0)\' AND f.id = facts_fts.rowid AND f.identity_id = ? AND f.status IN (\'active\',\'disputed\') ORDER BY rank LIMIT 10',
);
for (const [name, expr] of [EXPRS[1], EXPRS[2]]) {
	const a = factsSlow.all(expr, PERSONA);
	const b = factsFast.all(expr, PERSONA);
	const msSlow = time(() => factsSlow.all(expr, PERSONA), REPS);
	const msFast = time(() => factsFast.all(expr, PERSONA), REPS);
	console.log(
		`  ${name.padEnd(18)} bm25 ${msSlow.toFixed(2).padStart(7)}ms   rank ${msFast.toFixed(2).padStart(7)}ms  ` +
			`${same(a.map((r) => r.id), b.map((r) => r.id)) ? '行序相同' : '行序不同 ✗'}`,
	);
}
console.log('  facts_fts + rank MATCH 的计划：');
for (const row of db.prepare(`EXPLAIN QUERY PLAN SELECT f.id FROM facts_fts CROSS JOIN facts f WHERE facts_fts MATCH ? AND rank MATCH 'bm25(5.0, 1.0, 2.0, 5.0)' AND f.id = facts_fts.rowid AND f.identity_id = ? AND f.status IN ('active','disputed') ORDER BY rank LIMIT 10`).all('"今天"', PERSONA)) {
	console.log(`     ${row.detail}`);
}

db.close();
fs.rmSync(work, { recursive: true, force: true });
