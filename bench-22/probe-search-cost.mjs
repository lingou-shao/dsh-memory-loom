#!/usr/bin/env node
/**
 * `memory_search` 一次到底花在哪几条 SQL 上（2026-11-13）。
 *
 * 起因：库到 5,458 行时单次检索 380 ms。用户的问题是「库变大是不是每次都要
 * 花更长时间」，所以这里要回答的不是「现在多慢」，而是**慢的那部分随什么增长**：
 *
 *   随「总行数」增长 → 结构问题，得换写法（每次都在全库上排序）
 *   随「命中行数」增长 → 查询问题，命中的就那么多，排序本来要付这个钱
 *   常数 → 只是语句数量多
 *
 * 做法：把 `StatementSync.run/all/get` 包一层，按 SQL 模板聚合**执行**时间
 * （不含 prepare），跑真实 dev 问句。再对四条 FTS 读路径各打一次
 * `EXPLAIN QUERY PLAN`——按行数退化的第一种形态就是「驱动表选错了」，
 * 那件事只能从计划里看见（§105.2）。
 *
 *   node bench-22/probe-search-cost.mjs --db bench-22/work/cmp-m02.db --persona M02 --n 12
 *   node bench-22/probe-search-cost.mjs --db <db> --plan
 *
 * 只读：库先复制到临时目录，原库不动；`lib/` 不动。
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
const dbIn = arg('db', path.join(HERE, 'work', 'cmp-m02.db'));
const PERSONA = arg('persona', 'M02');
const N = Number(arg('n', 12));
const PLAN_ONLY = argv.includes('--plan');

/* ── 打点 ──────────────────────────────────────────────────────────────── */
const stats = new Map();
let watching = false;
const label = (sql) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 120);
for (const name of ['run', 'all', 'get']) {
	const orig = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...a) {
		if (!watching) return orig.apply(this, a);
		const began = performance.now();
		try {
			return orig.apply(this, a);
		} finally {
			const key = label(this.sourceSQL ?? '?');
			const one = stats.get(key) ?? { n: 0, ms: 0, max: 0 };
			one.n += 1;
			one.ms += performance.now() - began;
			one.max = Math.max(one.max, performance.now() - began);
			stats.set(key, one);
		}
	};
}
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
	const stmt = origPrepare.call(this, sql, ...rest);
	try {
		Object.defineProperty(stmt, 'sourceSQL', { value: String(sql), enumerable: false });
	} catch {
		/* 不可写就算了 */
	}
	return stmt;
};

/* 复制一份：原库可能带 WAL，而且我们不想动它。 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-search-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, copy);
for (const suffix of ['-wal', '-shm']) {
	if (fs.existsSync(dbIn + suffix)) fs.copyFileSync(dbIn + suffix, copy + suffix);
}

const raw = new DatabaseSync(copy);
const one = (sql, ...a) => raw.prepare(sql).get(...a);
const size = {
	l0: one('SELECT COUNT(*) AS n FROM l0').n,
	facts: one('SELECT COUNT(*) AS n FROM facts').n,
	events: one('SELECT COUNT(*) AS n FROM events').n,
	prefs: one('SELECT COUNT(*) AS n FROM preferences').n,
};
console.log(`库：${dbIn}`);
console.log(`    l0 ${size.l0} 行 · facts ${size.facts} · events ${size.events} · preferences ${size.prefs}`);

/* ── 四条 FTS 读路径的计划 ─────────────────────────────────────────────── */
const PLAN = [
	['searchL0(严格)', 'SELECT l.id FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 40', ['"今天"', PERSONA]],
	['searchL0(OR 放宽)', 'SELECT l.id FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 40', ['"今天" OR "晚上" OR "明天"', PERSONA]],
	['searchFacts', 'SELECT f.id, bm25(facts_fts, 5.0, 1.0, 2.0, 1.0) AS bm25 FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ? AND f.identity_id = ? AND f.status IN (\'active\',\'disputed\') ORDER BY bm25 LIMIT 10', ['"今天"', PERSONA]],
	['searchEvents', 'SELECT e.id, bm25(events_fts, 5.0, 1.0, 1.0) AS bm25 FROM events_fts CROSS JOIN events e WHERE events_fts MATCH ? AND e.id = events_fts.rowid AND e.identity_id = ? AND e.status = \'active\' ORDER BY bm25 LIMIT 10', ['"今天"', PERSONA]],
];
console.log('\n=== EXPLAIN QUERY PLAN ===');
for (const [name, sql, params] of PLAN) {
	let rows;
	try {
		rows = raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params);
	} catch (error) {
		console.log(`\n${name}：计划取不到（${error.message}）`);
		continue;
	}
	console.log(`\n${name}`);
	for (const row of rows) console.log(`   ${row.detail}`);
}
/* 命中行数：排序要付的钱是它决定的，不是总行数。 */
console.log('\n=== 命中行数（决定排序代价的那个量）===');
for (const [name, expr] of [
	['"今天"', '"今天"'],
	['宽松三词 OR', '"今天" OR "晚上" OR "明天"'],
	['十个二元组 OR', Array.from({ length: 10 }, (_, i) => `"w${i}"`).slice(0, 0).join(' OR ') || '"今天" OR "明天" OR "晚上" OR "早上" OR "回来" OR "时候" OR "一个" OR "我们" OR "什么" OR "现在"'],
]) {
	try {
		const n = raw.prepare('SELECT COUNT(*) AS n FROM l0_fts WHERE l0_fts MATCH ?').get(expr).n;
		console.log(`  ${String(n).padStart(6)} 行  ${name}`);
	} catch (error) {
		console.log(`  取不到（${error.message}）  ${name}`);
	}
}
raw.close();

if (PLAN_ONLY) {
	fs.rmSync(work, { recursive: true, force: true });
	process.exit(0);
}

/* ── 真实问句跑 memory_search ──────────────────────────────────────────── */
const questions = fs
	.readFileSync(path.join(DATA, 'exam-inputs.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim() !== '')
	.map((line) => JSON.parse(line))
	.filter((row) => row.persona === PERSONA)
	.slice(0, N);

const { createLoom } = await import('../loom-e2e/harness.mjs');
const loom = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });

/* 预热：语句编译、页缓存。第一次调用的耗时混着这两件事。 */
await loom.call('memory_search', { query: questions[0].question, limit: 10 }, PERSONA);
stats.clear();
watching = true;
const began = performance.now();
for (const item of questions) await loom.call('memory_search', { query: item.question, limit: 10 }, PERSONA);
const total = performance.now() - began;
watching = false;

console.log(`\n=== memory_search ${questions.length} 次：合计 ${(total / 1000).toFixed(2)}s，均 ${(total / questions.length).toFixed(0)} ms ===`);
const top = [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms);
let sum = 0;
for (const [, s] of top) sum += s.ms;
console.log(`  语句合计 ${(sum / 1000).toFixed(2)}s（占 ${((sum / total) * 100).toFixed(0)}%），其余是在 JS 里算的`);
for (const [sql, s] of top.slice(0, 12)) {
	console.log(`  ${(s.ms / 1000).toFixed(2).padStart(6)}s  ${String(s.n).padStart(5)}次  均 ${(s.ms / s.n).toFixed(2).padStart(7)}ms  峰 ${s.max.toFixed(1).padStart(7)}ms  ${sql}`);
}

loom.dispose?.();
fs.rmSync(work, { recursive: true, force: true });
