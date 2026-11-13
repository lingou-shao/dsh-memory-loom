/**
 * 一次 `memory_search` 里那 34.6 次 `searchL0` 到底是些什么调用（2026-11-13）。
 *
 * 上一步量到：10 次检索里 `searchL0` 被调了 346 次，合计 0.40s，均 1.15ms。
 * 但单独量「取一个词的 DF」只要 0.03ms。差 40 倍，说明慢的不是个数而是**某几种
 * 实参**。这里按 `MATCH` 表达式的形状分桶（单短语 / 少量 OR / 大量 OR），
 * 并记下每次的耗时分布——分桶之前调参数就是在调那 35% 的格子（§99.7 的老教训）。
 *
 *   node bench-22/probe-search-calls.mjs --db bench-22/work/cmp-m02.db --n 10
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const dbIn = arg('db', path.join(HERE, 'work', 'cmp-m02.db'));
const PERSONA = arg('persona', 'M02');
const N = Number(arg('n', 10));

const DATA = [
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => fs.existsSync(path.join(one, 'exam-inputs.jsonl')));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-calls-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, copy);

/** 桶：`1 短语` / `2–9 项` / `10+ 项`，项数按 MATCH 表达式里引号对数算。 */
const buckets = new Map();
const calls = [];
let watching = false;
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
for (const name of ['run', 'all', 'get']) {
	const orig = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...a) {
		if (!watching) return orig.apply(this, a);
		const sql = String(this.sourceSQL ?? '?');
		if (!sql.includes('bm25(l0_fts')) return orig.apply(this, a);
		const began = performance.now();
		try {
			return orig.apply(this, a);
		} finally {
			const ms = performance.now() - began;
			const expr = String(a[0] ?? '');
			const items = (expr.match(/"/g) ?? []).length / 2;
			const key = items <= 1 ? '1 短语' : items <= 9 ? '2–9 项 OR' : '10+ 项 OR';
			const one = buckets.get(key) ?? { n: 0, ms: 0, max: 0 };
			one.n += 1;
			one.ms += ms;
			one.max = Math.max(one.max, ms);
			buckets.set(key, one);
			calls.push({ ms, items, chars: expr.length, expr });
		}
	};
}

const { createLoom } = await import('../loom-e2e/harness.mjs');
const loom = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
const questions = fs
	.readFileSync(path.join(DATA, 'exam-inputs.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line))
	.filter((row) => row.persona === PERSONA)
	.slice(0, N);

await loom.call('memory_search', { query: questions[0].question, limit: 10 }, PERSONA);
buckets.clear();
calls.length = 0;
watching = true;
let total = 0;
for (const item of questions) {
	const began = performance.now();
	await loom.call('memory_search', { query: item.question, limit: 10 }, PERSONA);
	total += performance.now() - began;
}
watching = false;

const sum = [...buckets.values()].reduce((n, one) => n + one.ms, 0);
console.log(`\n${questions.length} 次 memory_search：合计 ${(total / 1000).toFixed(2)}s，均 ${(total / questions.length).toFixed(0)}ms`);
console.log(`其中 searchL0 ${calls.length} 次（${(calls.length / questions.length).toFixed(1)} 次/检索），合计 ${(sum / 1000).toFixed(2)}s = 每次检索 ${(sum / questions.length).toFixed(0)}ms\n`);
for (const [key, one] of [...buckets.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
	console.log(`  ${key.padEnd(10)} ${String(one.n).padStart(5)} 次  合计 ${(one.ms / 1000).toFixed(2).padStart(5)}s  均 ${(one.ms / one.n).toFixed(2).padStart(6)}ms  峰 ${one.max.toFixed(1).padStart(6)}ms`);
}

/* 最贵的十次，把表达式打出来——名字比统计更能说明是谁在问。 */
console.log('\n=== 最贵的十次 ===');
for (const one of [...calls].sort((a, b) => b.ms - a.ms).slice(0, 10)) {
	console.log(`  ${one.ms.toFixed(2).padStart(6)}ms  ${String(one.items).padStart(3)} 项  ${one.expr.slice(0, 90)}`);
}

/* 项数与耗时的关系：如果耗时主要跟项数走，那就不是「库变大」的问题。 */
console.log('\n=== 项数 → 均耗时 ===');
const byItems = new Map();
for (const one of calls) {
	const key = one.items;
	const b = byItems.get(key) ?? { n: 0, ms: 0 };
	b.n += 1;
	b.ms += one.ms;
	byItems.set(key, b);
}
for (const [items, b] of [...byItems.entries()].sort((a, b) => a[0] - b[0])) {
	console.log(`  ${String(items).padStart(3)} 项  ${String(b.n).padStart(4)} 次  均 ${(b.ms / b.n).toFixed(2).padStart(6)}ms`);
}

loom.dispose?.();
fs.rmSync(work, { recursive: true, force: true });
