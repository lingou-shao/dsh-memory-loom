/**
 * 「问句拆臂」仿真（§62）。
 *
 * 外部依据：MAPLE 量到 AnyAspect@20 = 98.1% 而 AllAspect@20 = 15.7%，说明
 * 「每题命中任一侧面」和「每题命中所有侧面」之间有一个巨大的落差，而我们的
 * 714 指标正是 AllAspect。Query decomposition 那边的说法更直接：一条查询向量
 * 覆盖不了两个事实，「正确的证据从来没有以正确的重数进候选集」。
 *
 * 这个脚本只回答一件事：把问句拆成子查询、每个子查询各占一条指针，能不能让
 * 那些「一条到了、另一条没到」的题变成两个都到。**预算一样**（还是两条指针、
 * 还是展开前两条），只换「这 2 条从哪儿挑」。
 *
 *   node bench-hmb/sem/sim-arms-714.mjs
 *   node bench-hmb/sem/sim-arms-714.mjs --personas P12,P17
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLoom, MIN } from '../../loom-e2e/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const OUT = path.join(BENCH, 'sim-arms-714.json');

const argOf = (name, fallback) => {
	const at = process.argv.indexOf(`--${name}`);
	return at < 0 ? fallback : process.argv[at + 1];
};
const PERSONAS = String(argOf('personas', 'P01,P12,P14,P16,P17,P20')).split(',');
const LIMIT = 10;
const EXPANDS = 2;

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));
const answerKey = new Map(jsonl(path.join(DS, 'review-only', 'answer-key.jsonl')).map((row) => [row.id, row]));

const key = (text) => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
function grams(text, n) {
	const s = key(text);
	const out = new Set();
	for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
	return out;
}
function ratio(set, quote, n) {
	const s = key(quote);
	if (s.length < n) return set.has(s) ? 1 : 0;
	let hit = 0;
	let total = 0;
	for (let i = 0; i + n <= s.length; i++) {
		total += 1;
		if (set.has(s.slice(i, i + n))) hit += 1;
	}
	return total === 0 ? 0 : hit / total;
}
function refsOf(text) {
	return [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
}
function scoredFacts(id) {
	const keyRow = answerKey.get(id);
	const ev = evidence.get(id);
	if (keyRow === undefined || ev === undefined) return [];
	const want = new Set(keyRow.scored_fact_ids ?? []);
	const quotesByFact = new Map();
	for (const source of ev.sources ?? []) {
		if (typeof source.quote !== 'string') continue;
		const list = quotesByFact.get(source.fact_id) ?? [];
		list.push(source.quote);
		quotesByFact.set(source.fact_id, list);
	}
	const out = [];
	for (const fact of ev.facts ?? []) {
		if (want.size > 0 && !want.has(fact.fact_id)) continue;
		const quotes = quotesByFact.get(fact.fact_id) ?? [];
		if (quotes.length === 0) continue;
		out.push({ factId: fact.fact_id, quotes });
	}
	return out;
}

/**
 * 把问句切成「侧面」。
 *
 * 只认句面上真实存在的并列信号，不猜语义：问号/分号断开、`分别|各|还有|以及`
 * 前面那句断开、以及 `X和Y分别…` 里的 `和`。切不开就返回单臂，跟现在一样。
 */
const SPLIT_HEAD = /(?:分别|各自|各是|还有|以及|另外|后来|然后|顺便)/u;
function aspectsOf(question) {
	const text = String(question ?? '');
	const parts = text
		.split(/[？?！!；;]/u)
		.map((one) => one.trim())
		.filter((one) => key(one).length >= 3);
	const out = [];
	for (const part of parts) {
		const clauses = part
			.split(/[，,]/u)
			.map((one) => one.trim())
			.filter((one) => key(one).length >= 3);
		if (clauses.length > 1) {
			// 「…，分别…」「…，还有…」：前一句和后一句各算一个侧面。
			for (let i = 0; i < clauses.length; i++) {
				const clause = clauses[i];
				if (SPLIT_HEAD.test(clause) && i > 0) {
					const prev = out.pop() ?? clauses[i - 1];
					for (const piece of splitOnHe(prev)) out.push(piece);
					for (const piece of splitOnHe(clause)) out.push(piece);
				} else out.push(...splitOnHe(clause));
			}
		} else out.push(...splitOnHe(part));
	}
	const seen = new Set();
	const uniq = [];
	for (const one of out) {
		const k = key(one);
		if (k.length < 3 || seen.has(k)) continue;
		seen.add(k);
		uniq.push(one);
	}
	return uniq.length >= 2 ? uniq : [text];
}
/** 「刘莹和刘颖分别…」→ 两个名字各一条；只在后面跟着 分别/各 时才切。 */
function splitOnHe(clause) {
	if (!/(?:分别|各自|各是|都)/u.test(clause)) return [clause];
	if (/你们|我们|咱们|他们|她们/u.test(clause)) return [clause];
	const parts = clause.split('和').map((one) => one.trim()).filter((one) => key(one).length >= 2);
	return parts.length >= 2 ? parts : [clause];
}

/**
 * 问句自己说了「要对比两个版本」。这类题的答案必然是**一对**记录，而现在的
 * 检索只给一条——Zep 那篇讲得很直白：扁平存储会把两个版本压成得分高的那个，
 * 「并且至少对其中一个给出自信的错误答案」。
 */
const CONTRAST = /同一张|同一件|两个数|两种说法|两回|第一[次回]和?第?二[次回]|对不上|还算数|之前的说法|改口|记混|两个版本/iu;
/** 问句与首条命中共享的最长实词串（≥2 字），用来当实体锚。 */
function sharedAnchor(question, seed) {
	const q = key(question);
	const s = key(seed);
	let best = '';
	for (let i = 0; i < q.length; i++) {
		for (let len = Math.min(6, q.length - i); len >= 2; len--) {
			const piece = q.slice(i, i + len);
			if (piece.length <= best.length) break;
			if (s.includes(piece)) {
				best = piece;
				break;
			}
		}
	}
	if (best.length < 2) return null;
	if (/^(?:什么|怎么|哪个|哪个|后来|之前|现在|我们|你们|他们|她们)$/u.test(best)) return null;
	return best;
}

const rows = [];
for (const persona of PERSONAS) {
	const mine = exams.filter((exam) => exam.persona === persona).sort((a, b) => a.cutoff_turn - b.cutoff_turn);
	if (mine.length === 0) continue;
	const turns = jsonl(path.join(DS, 'histories', `${persona}.jsonl`));
	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `arms-${persona}-`));
	const loom = createLoom({ dbPath: path.join(dir, 'loom.db'), config: { consolidation: { triggerTokens: 0 } } });
	const SID = `sim-${persona}`;
	let cursor = 0;
	let previous = null;
	try {
		for (const exam of mine) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				previous = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			}
			clock = Math.max(clock, Date.parse(exam.now));
			await loom.ready?.();
			const search = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, SID));
			const baseRefs = refsOf(search);

			// 拆臂：每条侧面各查一次，按出现顺序取「每臂第一条」，再用整句的第一条补齐。
			const arms = aspectsOf(exam.question);
			const armRefs = [];
			const perArm = [];
			if (arms.length > 1) {
				for (const arm of arms) {
					const textOfArm = String(await loom.call('memory_search', { query: arm, limit: LIMIT }, SID));
					const refs = refsOf(textOfArm);
					perArm.push({ arm, refs: refs.slice(0, 3) });
					if (refs.length > 0 && !armRefs.includes(refs[0])) armRefs.push(refs[0]);
				}
			}
			/*
			 * 融合顺序：整句的第一条保底（它通常是「这件事」本身），剩下的名额
			 * 交给拆臂各出第一条。反过来先排拆臂，会把整句最相关的那条挤掉——
			 * 第一次试就是 -7（变好 5 / 变坏 12）。
			 */
			const chosen = [];
			for (const ref of [...baseRefs.slice(0, 1), ...armRefs, ...baseRefs]) {
				if (chosen.length >= EXPANDS) break;
				if (!chosen.includes(ref)) chosen.push(ref);
			}
			// 扇出臂：问句自己说了「两个版本」时，用首条命中里的实体再查一次。
			let fanRef = null;
			let fanAnchor = null;
			if (CONTRAST.test(exam.question) && baseRefs.length > 0) {
				const seed = String(await loom.call('memory_expand', { ref: `#${baseRefs[0]}` }, SID));
				fanAnchor = sharedAnchor(exam.question, seed);
				if (fanAnchor !== null) {
					const fanHits = refsOf(String(await loom.call('memory_search', { query: fanAnchor, limit: LIMIT }, SID)));
					fanRef = fanHits.find((ref) => ref !== baseRefs[0]) ?? null;
				}
			}
			if (fanRef !== null) chosen.length = Math.min(chosen.length, 1), chosen.push(fanRef);
			const expanded = [];
			for (const ref of chosen) expanded.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));

			// 基线：按现在的方式展开前两条
			const baseExpanded = [];
			for (const ref of baseRefs.slice(0, EXPANDS)) baseExpanded.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
			const baseG = grams([search, ...baseExpanded].join('\n'), 10);
			const armG = grams([search, ...expanded].join('\n'), 10);
			const r10 = (set, fact) => Math.max(0, ...fact.quotes.map((quote) => ratio(set, quote, 10)));
			const baseFacts = scoredFacts(exam.id).map((fact) => ({ id: fact.factId, r10: Number(r10(baseG, fact).toFixed(3)) }));
			const armFacts = scoredFacts(exam.id).map((fact) => ({ id: fact.factId, r10: Number(r10(armG, fact).toFixed(3)) }));
			rows.push({
				id: exam.id,
				persona,
				tags: (answerKey.get(exam.id)?.content_tags ?? []),
				question: exam.question,
				arms,
				perArm,
				baseRefs: baseRefs.slice(0, EXPANDS),
				fanAnchor,
				fanRef,
				armRefs: chosen,
				baseFacts,
				armFacts
			});
		}
	} finally {
		loom.dispose();
		Date.now = realNow;
	}
	process.stdout.write(`${persona} 完成 ${mine.length} 题\n`);
}

fs.writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

const usable = rows.filter((row) => row.baseFacts.length > 0);
const allOk = (facts) => facts.every((fact) => fact.r10 >= 0.8);
const baseCov = usable.filter((row) => allOk(row.baseFacts)).length;
const armCov = usable.filter((row) => allOk(row.armFacts)).length;
const multi = usable.filter((row) => row.arms.length > 1).length;
console.log(`题 ${usable.length} ｜ 拆得开 ${multi} ｜ 基线 ${baseCov} → 拆臂 ${armCov}`);
const gained = usable.filter((row) => allOk(row.armFacts) && !allOk(row.baseFacts));
const lost = usable.filter((row) => !allOk(row.armFacts) && allOk(row.baseFacts));
console.log(`变好 ${gained.length}：${gained.map((row) => row.id).join(' ')}`);
console.log(`变坏 ${lost.length}：${lost.map((row) => row.id).join(' ')}`);
