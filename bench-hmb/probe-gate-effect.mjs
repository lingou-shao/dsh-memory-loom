/**
 * 废案：运行时改 `loom.settings.retrieval` **不会**影响检索。
 *
 * `apply()` 里 `const engineConfig = toEngineConfig(config)` 在启动时新建对象，
 * 引擎拿到的是那个副本；事后改 `loom.settings` 只是改了个没人读的字段。
 * 实测：`minScore = 0.99` 也清空不了结果，`relaxMinOverlap = 0` 与默认逐字相同。
 *
 * 要改配置只能在 `createLoom({ config })` 时给（见 diag-21-gate.mjs）。
 * 这个脚本保留下来当证据，顺便提供一个快速对比入口。
 *
 *   node bench-hmb/probe-gate-effect.mjs [--q M01-G026/d000]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const ID = argOf('q', 'M01-G026/d000');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const one = jsonl(`${WORK}/prf-21-detail.jsonl`).find((row) => row.id === ID);
const persona = one.persona;

const dir = fs.mkdtempSync(`${WORK}/gate-probe-`);
const dbPath = path.join(dir, 'loom.db');
fs.copyFileSync(`${WORK}/db-0254/${persona}.db`, dbPath);

const realNow = Date.now;
const at = Date.parse(one.now);
Date.now = () => at;
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const refsOf = (text) => [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];

const run = async (label, mutate) => {
	const saved = { ...loom.settings.retrieval };
	mutate?.(loom.settings.retrieval);
	const out = String(await loom.call('memory_search', { query: one.question, limit: Number(process.env.LIMIT ?? 10) }, 'p'));
	Object.assign(loom.settings.retrieval, saved);
	console.log(`\n=== ${label} ===`);
	console.log(`  settings 现值 relaxMinOverlap=${loom.settings.retrieval.relaxMinOverlap} relaxBelow=${loom.settings.retrieval.relaxBelow} 之后已复原`);
	console.log(`  行数 ${String(out).split('\n').filter((l) => /^\s*\d+\./.test(l)).length}  refs ${refsOf(out).join(',')}`);
	console.log(
		String(out)
			.split('\n')
			.slice(0, 6)
			.map((l) => `    ${l.slice(0, 90)}`)
			.join('\n')
	);
};

console.log(`题 ${ID}  「${one.question}」`);
console.log(`锚点轮 ${one.coveringTurn}  子句「${one.coveringText}」`);
try {
	await run('默认配置', null);
	await run('relaxMinOverlap=0（只放开闸门）', (r) => { r.relaxMinOverlap = 0; });
	await run('relaxMinOverlap=0 + relaxBelow=999（强制走 loose）', (r) => { r.relaxMinOverlap = 0; r.relaxBelow = 999; });
	await run('relaxBelow=999（强制 loose，但闸门照旧）', (r) => { r.relaxBelow = 999; });
	/* 突变是否真的到达引擎：minScore 调到 0.99 应当把结果清空。不清空就是没读到。 */
	await run('minScore=0.99（探测突变是否生效）', (r) => { r.minScore = 0.99; });
	await run('slotMax=0（关掉槽位通道）', (r) => { r.slotMax = 0; });
} finally {
	loom.dispose?.();
	Date.now = realNow;
	fs.rmSync(dir, { recursive: true, force: true });
}
