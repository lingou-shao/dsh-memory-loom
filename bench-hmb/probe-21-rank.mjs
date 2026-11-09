/**
 * 2.1 上定位率掉到 53%，是被 `limit` 截断还是打分就没把锚点排上来？
 *
 * surface-21 每题只取 `limit: 10`。如果锚点行在 top-40 里，那问题是「10 条不够」；
 * 如果 top-40 里也没有，那是打分/写侧的问题，放宽条数没用。
 *
 * 只在历史末尾取题（cutoff 逼近语料末轮），这样「灌到 cutoff」与「灌全量」几乎
 * 等价，建库次数压到一次。判定同 surface-21：把返回行里的 `#F/#E/#L` 映射成
 * 轮次区间，看有没有盖住答案键的锚点轮。
 *
 *   node bench-hmb/probe-21-rank.mjs --persona M01 --n 6
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const PERSONA = String(argOf('persona', 'M01'));
const N = Number(argOf('n', 6));
const LIMITS = [5, 10, 20, 40];

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl')).filter((one) => one.persona === PERSONA);
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));
const turns = jsonl(path.join(DS, `${PERSONA}.jsonl`));
const lastTurn = turns.at(-1)['轮次'];

/* 取 cutoff 最靠近末尾的那几道 main 题。 */
const picked = exams
	.filter((one) => keys.get(one.id)?.kind === 'main')
	.sort((a, b) => b.cutoff_turn - a.cutoff_turn)
	.slice(0, N)
	.sort((a, b) => a.cutoff_turn - b.cutoff_turn);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p21r-${PERSONA}-`));
const dbPath = path.join(dir, 'loom.db');
const realNow = Date.now;
let clock = Date.parse(turns[0]['逻辑时间']);
Date.now = () => clock;
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const SID = `p21r-${PERSONA}`;
let cursor = 0;
const out = [];
try {
	for (const exam of picked) {
		for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
			const turn = turns[cursor];
			const at = Date.parse(turn['逻辑时间']);
			clock = at;
			await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
		}
		clock = Math.max(clock, Date.parse(exam.now));
		const anchors = (keys.get(exam.id).anchors ?? []).map((one) => one.last_turn);
		const row = { id: exam.id, cutoff: exam.cutoff_turn, anchors, rows: {} };
		for (const limit of LIMITS) {
			const text = String(await loom.call('memory_search', { query: exam.question, limit }, SID));
			row.rows[limit] = [...String(text).matchAll(/#([FEL])(\d+)(?:-(\d+))?/gu)]
				.map((m) => ({ kind: m[1], id: Number(m[2]), to: m[3] === undefined ? null : Number(m[3]) }));
		}
		out.push(row);
	}
} finally {
	loom.dispose?.();
	Date.now = realNow;
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const turnOf = new Map(db.prepare('SELECT id, turn FROM l0').all().map((row) => [row.id, row.turn]));
const factTurns = new Map(db.prepare('SELECT id, source_ids FROM facts').all().map((row) => {
	let list = [];
	try { list = JSON.parse(row.source_ids).map((id) => turnOf.get(id)).filter((t) => t != null); } catch { list = []; }
	return [row.id, list];
}));
const eventRange = new Map(db.prepare('SELECT id, turn_from, turn_to FROM events').all().map((row) => [row.id, [row.turn_from, row.turn_to]]));
db.close();

const covers = (ref, anchors) => {
	if (ref.kind === 'L') {
		const from = turnOf.get(ref.id);
		const to = ref.to === null ? from : turnOf.get(ref.to);
		for (let t = from; t <= to; t++) if (anchors.includes(t)) return true;
		return false;
	}
	if (ref.kind === 'F') return (factTurns.get(ref.id) ?? []).some((t) => anchors.includes(t));
	const range = eventRange.get(ref.id);
	return range !== undefined && anchors.some((t) => t >= range[0] && t <= range[1]);
};

const tally = Object.fromEntries(LIMITS.map((l) => [l, 0]));
for (const row of out) {
	row.rank = {};
	for (const limit of LIMITS) {
		const at = row.rows[limit].findIndex((ref) => covers(ref, row.anchors));
		row.rank[limit] = at === -1 ? null : at + 1;
		if (at !== -1) tally[limit] += 1;
	}
}
for (const row of out) console.log(row.id, `cutoff ${row.cutoff}/${lastTurn}`, '锚点', row.anchors.join(','), '首次命中位次', JSON.stringify(row.rank));
console.log(`\n${out.length} 题，末轮 ${lastTurn}`);
for (const limit of LIMITS) console.log(`  limit ${String(limit).padEnd(2)} 命中 ${tally[limit]}/${out.length}`);
