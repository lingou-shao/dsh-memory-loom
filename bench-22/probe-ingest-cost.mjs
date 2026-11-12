#!/usr/bin/env node
/**
 * 一轮入库到底花在哪，以及那 60 ms 到底是不是白等（2026-11-12）。
 *
 * 自然榜 76 题跑了 43 分钟，`probe-natural-cost.py` 拆出来：`mark` / 取面 /
 * `rewind` 全是几十毫秒，**入库占 100%**，一轮 78 ms。这里再往里拆一层：
 * `loom-e2e/harness.mjs` 的 `turn_` 结尾有 `await settle()`——四轮 15 ms 的
 * `setTimeout`，纯睡眠 60 ms。
 *
 * 断言两件事：
 *
 * 1. `settleRounds: 0` 时一轮能降到二十毫秒级；
 * 2. **取到的东西一字不差**——省掉的必须是睡眠，不是整合。
 *
 *     node bench-22/probe-ingest-cost.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

/* 题库位置：环境变量 > 仓库旁边 > 桌面上那份（和 `probe_natural.py` 的 `_pick` 同一套）。 */
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));

const TURNS = 120;
const rows = fs
	.readFileSync(path.join(DATA, 'histories', 'M01.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.slice(0, TURNS)
	.map((line) => JSON.parse(line));

/**
 * 等到库不再变。
 *
 * `settle()` 是「睡 60 ms，赌异步活干完了」——赌注按轮付，一万两千轮就是十二分钟。
 * 库里有 `l0.consolidated`、`facts`、`events` 三个能观测的量，直接看它们静没静，
 * 比赌准：每 20 ms 采一次，连续三次一模一样就认为干完了（上限 10 秒）。
 */
async function quiesce(dbPath, quiet = 3, capMs = 30_000) {
	const { DatabaseSync } = await import('node:sqlite');
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const sample = () => {
		const one = (sql) => db.prepare(sql).get();
		return JSON.stringify([
			one('SELECT COUNT(*) AS n FROM l0').n,
			one('SELECT COUNT(*) AS n FROM l0 WHERE consolidated = 0').n,
			one('SELECT COUNT(*) AS n FROM facts').n,
			one('SELECT COUNT(*) AS n FROM events').n,
		]);
	};
	const began = Date.now();
	let last = null;
	let steady = 0;
	try {
		while (Date.now() - began < capMs) {
			const now = sample();
			if (now === last) {
				steady += 1;
				if (steady >= quiet) break;
			} else {
				last = now;
				steady = 0;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (process.env.PROBE_TRACE && (Date.now() - began) % 1000 < 40) console.log(`    quiesce ${Date.now() - began}ms ${last}`);
		}
	} finally {
		db.close();
	}
	return Date.now() - began;
}

async function run(settleRounds) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-cost-${settleRounds}-`));
	const dbPath = path.join(dir, 'loom.db');
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } }, settleRounds });
	const spent = [];
	for (const row of rows) {
		const at = Date.parse(row['逻辑时间']);
		const began = performance.now();
		await loom.turn('M01', row['用户消息'], row['助手回复'], { at });
		spent.push(performance.now() - began);
	}
	const drained = await quiesce(dbPath);
	const block = loom.memoryBlock('M01');
	const counts = await (async () => {
		const { DatabaseSync } = await import('node:sqlite');
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const one = (sql) => db.prepare(sql).get().n;
			return { l0: one('SELECT COUNT(*) AS n FROM l0'), pend: one('SELECT COUNT(*) AS n FROM l0 WHERE consolidated = 0'), facts: one('SELECT COUNT(*) AS n FROM facts'), events: one('SELECT COUNT(*) AS n FROM events') };
		} finally { db.close(); }
	})();
	const found = await loom.call('memory_search', { query: '上次说的那件事后来怎么样了', limit: 10 }, 'M01');
	loom.dispose();
	fs.rmSync(dir, { recursive: true, force: true });
	spent.sort((a, b) => a - b);
	return { median: spent[Math.floor(spent.length / 2)], total: spent.reduce((s, x) => s + x, 0), drained, block, counts, found: String(found) };
}

const base = await run(4);
console.log(`settleRounds 4  一轮中位 ${base.median.toFixed(1)} ms，库 ${JSON.stringify(base.counts)}`);
let bad = 0;
for (const rounds of [2, 1]) {
	const arm = await run(rounds);
	const same = arm.block === base.block && arm.found === base.found && JSON.stringify(arm.counts) === JSON.stringify(base.counts);
	console.log(
		`settleRounds ${rounds}  一轮中位 ${arm.median.toFixed(1)} ms  省 ${(((base.median - arm.median) / base.median) * 100).toFixed(0)}%` +
			`  与 4 轮${same ? '逐字一致' : '**不一致**'}  库 ${JSON.stringify(arm.counts)}`,
	);
	if (!same) {
		bad += 1;
		const a = base.block.split('\n');
		const b = arm.block.split('\n');
		for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
			if (a[i] !== b[i]) {
				console.log(`  第一处不同 @${i}:\n    4: ${a[i] ?? '(无)'}\n    ${rounds}: ${b[i] ?? '(无)'}`);
				break;
			}
		}
	}
}
process.exit(bad === 0 ? 0 : 1);
