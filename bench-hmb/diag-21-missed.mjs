/**
 * 「只我中」25 题的丢失位置（增量口径，唯一有效的口径）。
 *
 * 前一版错在 8 字窗对短句返回 null，把 6–7 字的子句判成「写侧没有」。
 * 另一个错是拿**成品库**判检索：0.2.54 那轮跑完后，后来的会话会把同一批轮次
 * 归并成事件行并带上原话，于是成品库里能搜到当时搜不到的东西
 * （`M01-G026/d000` 实测：增量到 cutoff 时检索不含该句，成品库含，但那是
 * `事件 10-11` 的行，题发问时还不存在）。所以只能在增量库上判。
 *
 * 分类（判据统一为「子句是否出现在文本里」，>=8 字用 8 字窗、<8 字用子串）：
 *   W0  写侧：整轮一条 fact 都没有
 *   Wp  写侧：同轮有 fact，但这句被丢
 *   S   有此行但 status != active
 *   T1  默认检索就已包含该句（说明 surface 记的 miss 是口径问题）
 *   G   默认不含、放开闸门后含（闸门误杀）
 *   O   放开闸门也不含（候选条数 / 打分）
 *
 *   node bench-hmb/diag-21-missed.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const DETAIL = `${WORK}/prf-21-detail.jsonl`;
const OUT = `${WORK}/diag-missed.json`;
const WIN = 8;

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) =>
	String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, '');

/** 判据：>=8 字用 8 字窗（同 §68），<8 字只能判子串。 */
function covers(clause, text) {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < 8) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + WIN <= c.length; i++) if (t.includes(c.slice(i, i + WIN))) return true;
	return false;
}

const targets = jsonl(DETAIL).filter((one) => one.state === 'miss' && one.baseHit);
const byPersona = new Map();
for (const one of targets) {
	if (!byPersona.has(one.persona)) byPersona.set(one.persona, []);
	byPersona.get(one.persona).push(one);
}

const rows = [];
let mutationChecked = 0;
let mutationProved = 0;
for (const [persona, list] of byPersona) {
	list.sort((a, b) => a.cutoff - b.cutoff);
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `diag3-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');

	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const SID = `diag3-${persona}`;
	let cursor = 0;
	try {
		for (const one of list) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= one.cutoff; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			}
			clock = one.now ? Date.parse(one.now) : clock;
			const searchDefault = String(await loom.call('memory_search', { query: one.question, limit: 10 }, SID));
			const saved = {
				overlap: loom.settings.retrieval.relaxMinOverlap,
				below: loom.settings.retrieval.relaxBelow
			};
			loom.settings.retrieval.relaxMinOverlap = 0;
			loom.settings.retrieval.relaxBelow = 999;
			const searchOpen = String(await loom.call('memory_search', { query: one.question, limit: 10 }, SID));
			loom.settings.retrieval.relaxMinOverlap = saved.overlap;
			loom.settings.retrieval.relaxBelow = saved.below;
			if (searchOpen !== searchDefault) mutationProved++;
			mutationChecked++;
			rows.push({ ...one, searchDefault, searchOpen });
			console.error(`  ${one.id} cutoff ${one.cutoff} 完成`);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}

	const db = new DatabaseSync(dbPath, { readOnly: true });
	const facts = db.prepare('SELECT id, text, status, created_at, source_ids FROM facts').all();
	const l0 = db.prepare("SELECT id, turn, text FROM l0 WHERE role = 'user'").all();
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });

	console.error(
		`${persona} 库：facts ${facts.length}，L0 用户轮 ${l0.length}，题目 ${list.length}，` +
			`闸门开关使结果变化的题 ${rows.filter((r) => r.persona === persona && r.searchOpen !== r.searchDefault).length}`
	);

	for (const row of rows.filter((one) => one.persona === persona)) {
		const turnL0 = l0.filter((one) => one.turn === row.coveringTurn);
		const turnL0Ids = new Set(turnL0.map((one) => one.id));
		const clause = row.coveringText ?? '';
		const matching = facts.filter((f) => covers(clause, f.text));
		const active = matching.filter((f) => f.status === 'active');
		const turnFacts = facts.filter((f) => (JSON.parse(f.source_ids ?? '[]') ?? []).some((id) => turnL0Ids.has(Number(id))));
		const inDefault = covers(clause, row.searchDefault);
		const inOpen = covers(clause, row.searchOpen);

		let kind;
		if (!matching.length) kind = turnFacts.length ? 'Wp' : 'W0';
		else if (!active.length) kind = 'S';
		else if (inDefault) kind = 'T1';
		else if (inOpen) kind = 'G';
		else kind = 'O';

		Object.assign(row, {
			kind,
			hasL0: turnL0.some((one) => covers(clause, one.text)),
			clauseLen: norm(clause).length,
			factsTotal: facts.length,
			factsTurn: turnFacts.length,
			matchingIds: matching.map((f) => f.id),
			matchingStatus: matching.map((f) => f.status),
			factText: matching[0]?.text ?? null,
			factLen: matching[0] ? norm(matching[0].text).length : 0
		});
	}
}

const LABEL = {
	W0: '写侧：整轮一条 fact 都没有',
	Wp: '写侧：同轮有 fact 但这句被丢',
	S: '状态非 active',
	T1: '默认检索就已包含（surface 口径问题）',
	G: '闸门误杀',
	O: '闸门开也不含（候选条数/打分）'
};
const ORDER = ['W0', 'Wp', 'S', 'T1', 'G', 'O'];
const counts = {};
for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
console.log(`\n「只我中」${rows.length} 题的丢失位置（增量口径）`);
console.log(`闸门开关有效性：${mutationProved}/${mutationChecked} 题结果有变化`);
for (const kind of ORDER) {
	const n = counts[kind] ?? 0;
	console.log(`  ${kind.padEnd(2)}  ${LABEL[kind].padEnd(22)} ${String(n).padStart(3)}  ${((100 * n) / rows.length).toFixed(1)}%`);
}
for (const kind of ORDER) {
	const list = rows.filter((one) => one.kind === kind);
	if (!list.length) continue;
	console.log(`\n--- ${kind} ${LABEL[kind]}（${list.length}）---`);
	for (const one of list) {
		console.log(
			`  ${one.id.padEnd(16)} 子句 ${String(one.clauseLen).padStart(2)} 字  同轮 fact ${String(one.factsTurn).padStart(2)}  L0 ${one.hasL0 ? '有' : '无'}  「${String(one.coveringText).slice(0, 32)}」`
		);
		if (one.factText) console.log(`      fact：${String(one.factText).slice(0, 58)}`);
	}
}

fs.writeFileSync(
	OUT,
	JSON.stringify({ counts, mutationProved, mutationChecked, rows: rows.map(({ searchDefault, searchOpen, ...rest }) => rest) }, null, 1),
	'utf8'
);
console.log(`\n写 ${OUT}`);
