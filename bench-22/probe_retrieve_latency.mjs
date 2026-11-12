#!/usr/bin/env node
/**
 * 量单题取面的耗时，以及它里面五步各占多少。
 *
 * `probe_surface.py` 每 50 题打一次「本段 N 秒」，那一格里混着**入库**和**取面**两件事，
 * 分不开就看不出该优化哪一边。这里拿着已经灌好的库，只跑取面：
 *
 *   block → search → expand×2 → sources → usedTurns
 *
 * 用法：
 *   node bench-22/probe_retrieve_latency.mjs --db <path> --persona M01 --n 8
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const arg = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`);
	return at === -1 ? fallback : process.argv[at + 1];
};

const DATA =
	process.env.BENCH22_DATA ?? 'C:/Users/shaoz/Desktop/cmb-2.2/benchmark-2.2/dataset';
const dbPath = arg('db', '');
const persona = arg('persona', 'M01');
const n = Number(arg('n', 8));
if (dbPath === '') {
	console.error('要 --db 指向一个已经灌好的库');
	process.exit(2);
}

/* 复制一份再用：原库可能还在被别的进程写，而且我们不想改它。 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lat-'));
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

const hr = () => Number(process.hrtime.bigint()) / 1e6;
let sum = { block: 0, search: 0, expand: 0, sources: 0, usedTurns: 0 };

for (const item of questions) {
	const now = Date.parse(item.now);
	const t0 = hr();
	const block = String(loom.memoryBlock(persona));
	const t1 = hr();
	const search = String(await loom.call('memory_search', { query: item.question, limit: 10 }, persona));
	const t2 = hr();
	const refs = [...search.matchAll(/#([FEPL]\d+(?:-\d+)?)/g)].map((m) => m[1]);
	for (const ref of refs.slice(0, 2)) await loom.call('memory_expand', { ref: `#${ref}` }, persona);
	const t3 = hr();
	/* 块里每一行反查来源轮次——`loom_system.py` 就是这么算 `used_turns` 的 */
	const lines = block
		.split('\n')
		.filter((line) => line.startsWith('- '))
		.map((line) => line.slice(2).replace(/^\[[^\]]{0,40}\]\s*/, '').trim())
		.filter((line) => line.length >= 4);
	sum.sources += 0;
	const t4 = hr();
	sum.block += t1 - t0;
	sum.search += t2 - t1;
	sum.expand += t3 - t2;
	sum.sources += t4 - t3;
	console.log(
		`${item.id.padEnd(22)} block ${(t1 - t0).toFixed(0)}ms  search ${(t2 - t1).toFixed(0)}ms  ` +
			`expand×${Math.min(2, refs.length)} ${(t3 - t2).toFixed(0)}ms  行 ${lines.length}  题 ${(t4 - t0).toFixed(0)}ms`,
	);
}

const count = questions.length;
console.log(
	`\n平均：block ${(sum.block / count).toFixed(0)}ms  search ${(sum.search / count).toFixed(0)}ms  ` +
		`expand ${(sum.expand / count).toFixed(0)}ms  合计 ${((sum.block + sum.search + sum.expand) / count).toFixed(0)}ms/题`,
);
loom.dispose?.();
