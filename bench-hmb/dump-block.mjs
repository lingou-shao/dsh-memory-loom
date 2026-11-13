/**
 * 重放指定题，打印**常驻块**的原文。诊断用，不参与跑分。
 *
 *   node bench-hmb/dump-block.mjs P12-ADD-003/d03 --no-festive
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const festive = !process.argv.includes('--no-festive');
const wants = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const byPersona = new Map();
for (const id of wants) {
	const exam = exams.find((e) => e.id === id);
	if (exam === undefined) {
		console.error(`找不到 ${id}`);
		continue;
	}
	const list = byPersona.get(exam.persona) ?? [];
	list.push(exam);
	byPersona.set(exam.persona, list);
}

for (const [persona, list] of byPersona) {
	const turns = jsonl(path.join(DS, 'histories', `${persona}.jsonl`));
	list.sort((a, b) => a.cutoff_turn - b.cutoff_turn);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dump-${persona}-`));
	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const loom = createLoom({
		dbPath: path.join(dir, 'loom.db'),
		config: { consolidation: { triggerTokens: 0 }, retrieval: { dueToday: true, dueTodayFestive: festive } }
	});
	const SID = `dump-${persona}`;
	let cursor = 0;
	try {
		for (const exam of list) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			}
			clock = Math.max(clock, Date.parse(exam.now));
			await loom.ready?.();
			const block = String(loom.memoryBlock(SID));
			console.log(`=== ${exam.id}  festive=${festive}  ${String(exam.question).replace(/\n/gu, ' ').slice(0, 42)}`);
			for (const line of block.split('\n')) if (line.trim()) console.log(`   ${line.slice(0, 140)}`);
			console.log();
		}
	} finally {
		Date.now = realNow;
	}
}
