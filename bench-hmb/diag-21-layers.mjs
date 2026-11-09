/**
 * 25 题逐题核对：原话到底进了哪一层，以及那一层在发问当时存不存在。
 *
 * 前一轮的 W0「整轮一条 fact 都没有」不等于写侧丢失 —— 库里还有事件层，
 * 事件带 turn_from/turn_to 和逐字引用。所以每题要问三件事：
 *   1. 锚点轮有没有 fact（有 → 事实层）
 *   2. 锚点轮在不在某个事件区间里，且该事件 created_at <= 题的 now（有 → 事件层当时可用）
 *   3. 锚点轮有没有 L0 原话行（永远有，除非被 purge）
 *
 * 用 0.2.54 那轮的成品库（s21-*），fact/event 的 created_at 都取自引擎时钟，
 * 所以「当时有没有」可以用 created_at <= now 判。
 *
 * 只能判**写侧**：成品库晚于发问时点，后来的会话会把同一批轮次归并成事件行并
 * 带上逐字引用，于是「在成品库里能搜到」不等于「当时能搜到」。检索侧的结论一律
 * 用增量回放（diag-21-missed.mjs / diag-21-gate.mjs），不要用这个脚本的库。
 *
 *   node bench-hmb/diag-21-layers.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const DBS = {
	M01: path.join(os.tmpdir(), 's21-M01-T9F11n', 'loom.db'),
	M02: path.join(os.tmpdir(), 's21-M02-qpCGXz', 'loom.db')
};
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) =>
	String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, '');
function covers(clause, text) {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < 8) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + 8 <= c.length; i++) if (t.includes(c.slice(i, i + 8))) return true;
	return false;
}

const targets = jsonl(`${WORK}/prf-21-detail.jsonl`).filter((one) => one.state === 'miss' && one.baseHit);
const byPersona = new Map();
for (const one of targets) {
	if (!byPersona.has(one.persona)) byPersona.set(one.persona, []);
	byPersona.get(one.persona).push(one);
}

const rows = [];
for (const [persona, list] of byPersona) {
	const db = new DatabaseSync(DBS[persona], { readOnly: true });
	const l0 = db.prepare("SELECT id, turn FROM l0 WHERE role = 'user'").all();
	const facts = db.prepare('SELECT id, text, source_ids, created_at, status FROM facts').all();
	const events = db.prepare('SELECT id, turn_from, turn_to, created_at, status, title, summary FROM events').all();
	db.close();
	const turnOfL0 = new Map(l0.map((one) => [one.id, one.turn]));
	const factsByTurn = new Map();
	for (const fact of facts) {
		for (const id of JSON.parse(fact.source_ids ?? '[]') ?? []) {
			const turn = turnOfL0.get(Number(id));
			if (turn === undefined) continue;
			if (!factsByTurn.has(turn)) factsByTurn.set(turn, []);
			factsByTurn.get(turn).push(fact);
		}
	}
	for (const one of list) {
		const at = Date.parse(one.now);
		const turnList = one.anchorTurns ?? [one.coveringTurn];
		const clause = one.coveringText ?? '';
		const turnFacts = turnList.flatMap((t) => factsByTurn.get(t) ?? []).filter((f) => f.created_at <= at);
		const turnEvents = events.filter(
			(ev) => ev.created_at <= at && ev.status === 'active' && turnList.some((t) => t >= ev.turn_from && t <= ev.turn_to)
		);
		/* 事件行里有没有逐字引用到这句 —— 事件摘要通常是改写，逐字命中要靠引用 */
		const eventQuote = turnEvents.filter((ev) => covers(clause, ev.summary) || covers(clause, ev.title));
		rows.push({
			id: one.id,
			persona,
			turn: one.coveringTurn,
			clauseLen: norm(clause).length,
			factCount: turnFacts.length,
			factMatch: turnFacts.filter((f) => covers(clause, f.text)).length,
			eventCount: turnEvents.length,
			eventQuote: eventQuote.length,
			eventTitles: turnEvents.map((ev) => ev.title).slice(0, 2)
		});
	}
}

const pct = (a, b) => `${((100 * a) / (b || 1)).toFixed(1)}%`;
const n = rows.length;
const bucket = (label, test) => rows.filter(test).length;
console.log(`\n${n} 题，三层各自能不能承载这句原话（时间点：题的 now）`);
console.log(`  事实层有这句            ${bucket('', (r) => r.factMatch > 0)} ${pct(bucket('', (r) => r.factMatch > 0), n)}`);
console.log(`  事实层有该轮别的事实    ${bucket('', (r) => r.factCount > 0 && r.factMatch === 0)}`);
console.log(`  事件层存在（覆盖该轮）  ${bucket('', (r) => r.eventCount > 0)} ${pct(bucket('', (r) => r.eventCount > 0), n)}`);
console.log(`  事件层里逐字含这句      ${bucket('', (r) => r.eventQuote > 0)} ${pct(bucket('', (r) => r.eventQuote > 0), n)}`);
console.log(`  三层都没有              ${bucket('', (r) => r.factCount === 0 && r.eventCount === 0)}`);

console.log('\n逐题');
console.log('  id                子句  事实 命中  事件 逐字  事件标题');
for (const row of rows) {
	console.log(
		`  ${row.id.padEnd(16)} ${String(row.clauseLen).padStart(3)}  ${String(row.factCount).padStart(2)}  ${String(row.factMatch).padStart(2)}   ${String(row.eventCount).padStart(2)}  ${String(row.eventQuote).padStart(2)}   ${row.eventTitles.join(' / ').slice(0, 30)}`
	);
}
fs.writeFileSync(`${WORK}/diag-layers.json`, JSON.stringify(rows, null, 1), 'utf8');
