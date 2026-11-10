/**
 * 逐题探针：把 714 里「真缺」的那几道题，在**取面那一刻**看到的东西原样抓下来。
 *
 * 只做三件事，不做判断：
 *   1. 按 cutoff 增量灌库（与 surface-coverage 同一条链路、同一套 config）；
 *   2. 记下模型这一轮真正看到的三个面：常驻块 / 搜索结果 / 前两条指针的展开；
 *   3. 把库快照下来（`VACUUM INTO`），并回库核对金标那几轮的原话在不在 `l0`，
 *      以及搜索结果里的每个 `#L` 指针盖住了哪些轮。
 *
 * 有了这三样才能分清「库里没有」「库里有但没进候选」「进了候选没被展开」，
 * 而不是拿一句「检索没捞到」糊过去。
 *
 *   node bench-hmb/probe-miss.mjs --ids P17-CASE-002/d00,P20-CASE-009/d00
 *   node bench-hmb/probe-miss.mjs --ids-file work/probe-ids.txt
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const OUTDIR = process.env.HMB_PROBE_OUT ?? path.join(BENCH, 'work', 'probe-miss');
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const LIMIT = Number(argOf('limit', 10));
const EXPANDS = Number(argOf('expands', 2));
const IDS = (() => {
	const inline = argOf('ids', '');
	const file = argOf('ids-file', '');
	const text = inline || (file ? fs.readFileSync(file, 'utf8') : '');
	return text
		.split(/[\s,]+/)
		.map((one) => one.trim())
		.filter(Boolean);
})();

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl')).filter((exam) => IDS.includes(exam.id));
if (exams.length === 0) {
	console.error('没有匹配的题号');
	process.exit(1);
}
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));
const answerKey = new Map(jsonl(path.join(DS, 'review-only', 'answer-key.jsonl')).map((row) => [row.id, row]));
const history = (persona) => jsonl(path.join(DS, 'histories', `${persona}.jsonl`));
const refsOf = (text) => [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];

/** 摘掉空白与标点，只留字。 */
const key = (text) => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
const grams = (text, n) => {
	const s = key(text);
	const out = new Set();
	for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
	return out;
};
const ratio = (set, quote, n) => {
	const s = key(quote);
	if (s.length < n) return set.has(s) ? 1 : 0;
	let hit = 0;
	let total = 0;
	for (let i = 0; i + n <= s.length; i++) {
		total += 1;
		if (set.has(s.slice(i, i + n))) hit += 1;
	}
	return total === 0 ? 0 : hit / total;
};

fs.mkdirSync(OUTDIR, { recursive: true });
const byPersona = new Map();
for (const exam of exams) {
	const list = byPersona.get(exam.persona) ?? [];
	list.push(exam);
	byPersona.set(exam.persona, list);
}

const summary = [];
for (const [persona, mine] of byPersona) {
	mine.sort((a, b) => a.cutoff_turn - b.cutoff_turn);
	const turns = history(persona);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `miss-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');
	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const SID = `miss-${persona}`;
	let previous = null;
	let cursor = 0;
	try {
		for (const exam of mine) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
				previous = at;
			}
			clock = Math.max(clock, Date.parse(exam.now));
			await loom.ready?.();
			const block = String(loom.memoryBlock(SID));
			const search = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, SID));
			const refs = refsOf(search);
			const expanded = [];
			for (const ref of refs.slice(0, EXPANDS)) {
				let text = '';
				try {
					text = String(await loom.call('memory_expand', { ref: `#${ref}` }, SID));
				} catch (error) {
					text = `ERROR ${error?.message ?? error}`;
				}
				expanded.push({ ref, text });
			}

			/*
			 * 快照走第二个连接：引擎把 `db` 关在 store 里，harness 不暴露。
			 * WAL 下另开一个连接能看到已提交的数据，`VACUUM INTO` 落成单文件，
			 * 之后可以从容地回库查而不必把整段历史重放一遍。
			 */
			const snap = path.join(OUTDIR, `${exam.id.replace(/\//g, '_')}.db`);
			fs.rmSync(snap, { force: true });
			{
				const side = new DatabaseSync(dbPath);
				try {
					side.exec(`VACUUM INTO '${snap.replace(/'/g, "''")}'`);
				} finally {
					side.close();
				}
			}

			const ev = evidence.get(exam.id) ?? {};
			const keyRow = answerKey.get(exam.id) ?? {};
			const blockG10 = grams(block, 10);
			const searchG10 = grams(search, 10);
			const toolG10 = grams([search, ...expanded.map((one) => one.text)].join('\n'), 10);
			const facts = (ev.facts ?? []).map((fact) => {
				const quotes = (ev.sources ?? []).filter((one) => one.fact_id === fact.fact_id && typeof one.quote === 'string');
				const best = (set) => Math.max(0, ...quotes.map((one) => ratio(set, one.quote, 10)));
				return {
					factId: fact.fact_id,
					meaning: fact.meaning ?? '',
					scored: (keyRow.scored_fact_ids ?? []).includes(fact.fact_id),
					turns: fact.evidence_turns ?? [],
					blockR10: Number(best(blockG10).toFixed(3)),
					searchR10: Number(best(searchG10).toFixed(3)),
					toolR10: Number(best(toolG10).toFixed(3)),
					quotes: quotes.map((one) => one.quote)
				};
			});

			/*
			 * 回库核对：金标那几轮的原话在不在 l0、最后一条落在哪一行；
			 * 以及库里到底有几行同一轮（一轮两行：用户 + 助手）。
			 */
			let l0 = [];
			if (fs.existsSync(snap)) {
				const db = new DatabaseSync(snap);
				try {
					const wanted = [...new Set((ev.sources ?? []).map((one) => one.turn))].filter((one) => Number.isInteger(one));
					l0 = wanted.map((turnNo) => {
						const rows = db.prepare('SELECT id, turn, role, text FROM l0 WHERE turn = ? ORDER BY id').all(turnNo);
						return {
							turn: turnNo,
							rows: rows.map((row) => ({ id: row.id, role: row.role, charLen: String(row.text).length, head: String(row.text).slice(0, 60) }))
						};
					});
				} catch (error) {
					l0 = [{ error: String(error?.message ?? error) }];
				} finally {
					db.close();
				}
			}

			const one = {
				id: exam.id,
				persona,
				now: exam.now,
				cutoffTurn: exam.cutoff_turn,
				question: exam.question,
				kind: keyRow.kind ?? null,
				tags: keyRow.content_tags ?? [],
				block,
				search,
				expanded,
				refs,
				facts,
				l0,
				snapshot: snap
			};
			fs.writeFileSync(path.join(OUTDIR, `${exam.id.replace(/\//g, '_')}.json`), JSON.stringify(one, null, 1));
			summary.push({
				id: exam.id,
				refs,
				expands: expanded.map((one) => one.ref),
				facts: facts.map((fact) => `${fact.factId}:${fact.scored ? '' : '('}b${fact.blockR10}/s${fact.searchR10}/t${fact.toolR10}${fact.scored ? '' : ')'}`)
			});
			console.log(`${exam.id}  refs=${refs.join(',')}  facts=${summary.at(-1).facts.join(' ')}`);
		}
	} finally {
		loom.dispose();
		Date.now = realNow;
	}
	console.log(`${persona} 完成 ${mine.length} 题 → ${OUTDIR}`);
}
fs.writeFileSync(path.join(OUTDIR, 'summary.json'), JSON.stringify(summary, null, 1));
