#!/usr/bin/env node
/**
 * 量「长消息」的写入代价，并给出 CPU 热点。
 *
 * 背景：2.2 的 M02 是「写长信的用户」，一轮 150–200 字，整卷入库时单轮成本从
 * 310 ms 涨到 2350 ms。要分清两件事：
 *
 *   - 每轮固定开销（`loom-e2e/harness.mjs` 的 `settle()` 就是 4 × 15 ms = 60 ms）；
 *   - 随深度增长的扫描（这才是要吃掉的）。
 *
 * 用法：
 *   node bench-22/probe_ingest_profile.mjs --persona M02 --turns 600
 *   node --cpu-prof --cpu-prof-dir .tmp-bridge/prof bench-22/probe_ingest_profile.mjs ...
 *
 * `--cpu-prof` 产出的 `.cpuprofile` 用同目录的 `--top 20` 汇总（见文末）。
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
const persona = arg('persona', 'M02');
const turns = Number(arg('turns', 600));
const step = Number(arg('step', 50));

const rows = fs
	.readFileSync(path.join(DATA, 'histories', `${persona}.jsonl`), 'utf8')
	.split('\n')
	.filter((line) => line.trim() !== '')
	.slice(0, turns)
	.map((line) => JSON.parse(line));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prof-'));
const loom = createLoom({
	dbPath: path.join(dir, 'loom.db'),
	config: { consolidation: { triggerTokens: 0 } },
});

const chars = rows.reduce((sum, row) => sum + row['用户消息'].length + row['助手回复'].length, 0);
console.log(`persona ${persona}  ${rows.length} 轮  平均每轮 ${(chars / rows.length).toFixed(0)} 字`);

let start = process.hrtime.bigint();
let mark = start;
for (let i = 0; i < rows.length; i++) {
	const row = rows[i];
	const at = Date.parse(row['逻辑时间']);
	await loom.turn(persona, row['用户消息'], row['助手回复'], { at });
	if ((i + 1) % step === 0) {
		const now = process.hrtime.bigint();
		const seg = Number(now - mark) / 1e6;
		const total = Number(now - start) / 1e6;
		console.log(
			`  ${String(i + 1).padStart(4)} 轮  本段 ${(seg / step).toFixed(0)} ms/轮  ` +
				`累计 ${(total / 1000).toFixed(1)}s`,
		);
		mark = now;
	}
}
const total = Number(process.hrtime.bigint() - start) / 1e6;
console.log(`合计 ${(total / 1000).toFixed(1)}s（${(total / rows.length).toFixed(0)} ms/轮），库 ${(fs.statSync(path.join(dir, 'loom.db')).size / 1048576).toFixed(1)} MB`);
loom.dispose?.();
console.log(`工作目录 ${dir}`);
