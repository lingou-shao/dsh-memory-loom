#!/usr/bin/env node
/**
 * 把 `memory_search` 内部真正跑的 SQL 抓出来，连同每条语句的耗时。
 *
 * `--cpu-prof` 只能告诉你「time 花在 `searchEvents` 这个 JS 帧里」，而那一帧里
 * 唯一的活是 `stmt.all()`——具体是哪条 SQL、绑了什么参数、扫了多少行，profile 看不见。
 * 这里在 `DatabaseSync.prototype.prepare` 上挂一层，凡带 `MATCH` 的语句都记下来。
 *
 *   node bench-22/probe_sql_trace.mjs --db <已灌好的库> --persona M01 --n 3
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const arg = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
};
const DATA = process.env.BENCH22_DATA ?? 'C:/Users/shaoz/Desktop/cmb-2.2/benchmark-2.2/dataset';
const dbPath = arg('db', '');
const persona = arg('persona', 'M01');
const n = Number(arg('n', 3));
const hr = () => Number(process.hrtime.bigint()) / 1e6;

const trace = [];
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function patched(sql) {
	const stmt = origPrepare.call(this, sql);
	if (!sql.includes('MATCH')) return stmt;
	const origAll = stmt.all.bind(stmt);
	const wrapped = {
		all: (...args) => {
			const started = hr();
			const rows = origAll(...args);
			trace.push({ ms: hr() - started, rows: rows.length, sql, expr: args[0], limit: args.at(-1) });
			return rows;
		},
	};
	/* 其余方法原样透传：调用方还会用 get / run / iterate */
	for (const key of ['get', 'run', 'iterate', 'columns', 'setReadBigInts', 'sourceSQL', 'expandedSQL']) {
		const value = stmt[key];
		if (typeof value === 'function') wrapped[key] = value.bind(stmt);
		else if (value !== undefined) Object.defineProperty(wrapped, key, { get: () => stmt[key] });
	}
	return wrapped;
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-trace-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbPath, copy);
for (const suffix of ['-wal', '-shm']) {
	if (fs.existsSync(dbPath + suffix)) fs.copyFileSync(dbPath + suffix, copy + suffix);
}
const loom = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 } } });

const questions = fs
	.readFileSync(path.join(DATA, 'exam-inputs.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim() !== '')
	.map((line) => JSON.parse(line))
	.filter((row) => row.persona === persona)
	.slice(0, n);

for (const item of questions) {
	trace.length = 0;
	const started = hr();
	await loom.call('memory_search', { query: item.question, limit: 10 }, persona);
	const total = hr() - started;
	console.log(`\n=== ${item.id}  总计 ${total.toFixed(0)}ms  ${item.question.slice(0, 24)}`);
	for (const t of trace.sort((a, b) => b.ms - a.ms)) {
		console.log(`  ${t.ms.toFixed(0).padStart(5)}ms  ${t.rows} 行  expr=${String(t.expr).slice(0, 90)}`);
	}
}
loom.dispose?.();
