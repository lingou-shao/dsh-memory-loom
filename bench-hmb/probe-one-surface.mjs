/**
 * 单题重放：把某一题按 cutoff 重灌一遍，打印注入块与检索结果。
 * 用来确认 surface-21 里记的 state=miss 是可复现的，还是产物的口径 bug。
 *
 *   node bench-hmb/probe-one-surface.mjs --q M01-G026/d000
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const ID = argOf('q', 'M01-G026/d000');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exam = jsonl(`${DS}/exam-inputs.jsonl`).find((one) => one.id === ID);
const turns = jsonl(path.join(DS, `${exam.persona}.jsonl`));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `one-${exam.persona}-`));
const dbPath = path.join(dir, 'loom.db');
const realNow = Date.now;
let clock = Date.parse(turns[0]['逻辑时间']);
Date.now = () => clock;
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const SID = `one-${exam.persona}`;
try {
	for (const turn of turns) {
		if (turn['轮次'] > exam.cutoff_turn) break;
		const at = Date.parse(turn['逻辑时间']);
		clock = at;
		await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
	}
	clock = Math.max(clock, Date.parse(exam.now));
	const block = String(loom.memoryBlock(SID));
	const search = String(await loom.call('memory_search', { query: exam.question, limit: 10 }, SID));
	/* 闸门开关是否真的生效：两次结果必须至少有一处不同，否则「0 例闸门误杀」是假的 */
	const saved = { overlap: loom.settings.retrieval.relaxMinOverlap, below: loom.settings.retrieval.relaxBelow };
	loom.settings.retrieval.relaxMinOverlap = 0;
	loom.settings.retrieval.relaxBelow = 999;
	const open = String(await loom.call('memory_search', { query: exam.question, limit: 10 }, SID));
	loom.settings.retrieval.relaxMinOverlap = saved.overlap;
	loom.settings.retrieval.relaxBelow = saved.below;
	const again = String(await loom.call('memory_search', { query: exam.question, limit: 10 }, SID));
	console.log(`\n闸门开关：默认 ${search.length} 字 / 全开 ${open.length} 字 → ${search === open ? '相同（突变没生效或本题不受影响）' : '不同（突变生效）'}`);
	console.log(`复原后与默认一致：${again === search}`);
	console.log(`题 ${ID} cutoff ${exam.cutoff_turn}`);
	console.log(`问：${exam.question}`);
	console.log(`\n--- 注入块（${block.length} 字）---`);
	console.log(block.slice(0, 900));
	console.log(`\n--- 检索结果 ---`);
	console.log(search);
	const all = `${block}\n${search}`;
	for (const needle of String(process.env.NEEDLE ?? '').split('|').filter(Boolean)) {
		console.log(`包含「${needle}」：${all.includes(needle)}`);
	}
} finally {
	loom.dispose?.();
	Date.now = realNow;
	console.log(`\n库留一份：${dbPath}`);
}
