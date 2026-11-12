#!/usr/bin/env node
/**
 * 入库的每轮代价随深度怎么变（2026-11-12：「怎么这么久」的第二层）。
 *
 * 200 轮上量到一轮 31 ms，按这个算一万两千轮只要六分钟，实际跑不完——说明
 * 代价不是常数。这个探针把 M01 的历史一次性灌到底，按 500 轮一段打中位数，
 * 看曲线是平的就说明是常数，往上翘就说明某处是 O(库大小)。
 *
 *     node bench-22/probe-ingest-depth.mjs [--turns 7000]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));

const capArg = process.argv.indexOf('--turns');
const TURNS = capArg > 0 ? Number(process.argv[capArg + 1]) : 7000;
const WIN = 500;

const rows = fs
	.readFileSync(path.join(DATA, 'histories', 'M01.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.slice(0, TURNS)
	.map((line) => JSON.parse(line));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-depth-'));
const loom = createLoom({
	dbPath: path.join(dir, 'loom.db'),
	config: { consolidation: { triggerTokens: 0 } },
	settleRounds: 1,
});

const windows = [];
const spent = [];
const beganAll = performance.now();
for (const [index, row] of rows.entries()) {
	const began = performance.now();
	await loom.turn('M01', row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
	spent.push(performance.now() - began);
	if ((index + 1) % WIN === 0) {
		const slice = spent.slice(-WIN).sort((a, b) => a - b);
		windows.push({ at: index + 1, median: slice[Math.floor(WIN / 2)], wall: (performance.now() - beganAll) / 1000 });
	}
}
if (spent.length % WIN !== 0) {
	const slice = spent.slice(-(spent.length % WIN)).sort((a, b) => a - b);
	windows.push({ at: spent.length, median: slice[Math.floor(slice.length / 2)], wall: (performance.now() - beganAll) / 1000 });
}

console.log(`M01 灌 ${spent.length} 轮，总耗时 ${((performance.now() - beganAll) / 1000).toFixed(0)} s`);
console.log(`  轮次段      中位/轮    累计`);
for (const one of windows) console.log(`  ${String(one.at).padStart(5)}  ${one.median.toFixed(1).padStart(8)} ms  ${one.wall.toFixed(0).padStart(5)} s`);
const first = windows[0].median;
const last = windows[windows.length - 1].median;
console.log(`  首段 ${first.toFixed(1)} ms → 末段 ${last.toFixed(1)} ms（×${(last / first).toFixed(1)}）`);
loom.dispose();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(last / first > 2 ? 1 : 0);
