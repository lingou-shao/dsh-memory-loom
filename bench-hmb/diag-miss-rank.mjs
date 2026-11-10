/**
 * 把「这一行到底卡在哪一道」量出来，而不是靠读搜索结果猜。
 *
 * 输入是 `probe-miss.mjs` 落下的库快照与题面，逐题复算四段：
 *   ① 原话通道：loose OR 进 FTS 的 40 条池子里，金标那几轮排第几；
 *   ② 重排之后（`rankQuoteRows` 的口径：内容词命中数优先）排第几；
 *   ③ 派生层：facts / preferences 的 loose OR 前 30 条里有没有那一行；
 *   ④ 闸门：那一行过不过 `containment >= 0.25` / 别名 / 规矩句旁路 / 三实词旁路。
 *
 * 判据都是本地复刻，只用于定位；真正算分仍走产品。
 *
 *   node bench-hmb/diag-miss-rank.mjs P17-CASE-002/d15 ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const PROBE = process.env.HMB_PROBE_OUT ?? path.join(BENCH, 'work', 'probe-miss');
const IDS = process.argv.slice(2).filter((one) => !one.startsWith('--'));
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((row) => [row.id, row]));
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));

/* ── 产品里的分词与判据（逐字复刻，改 lib 时要一起改） ─────────────── */
const CJK = /[\u4e00-\u9fff]+/gu;
const LATIN = /[a-z]+/giu;
const DIGIT = /\d+/gu;
function tokensOf(text) {
	const tokens = [];
	for (const match of String(text).matchAll(CJK)) {
		const chars = [...match[0]];
		for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of String(text).matchAll(LATIN)) tokens.push(match[0].toLowerCase());
	for (const match of String(text).matchAll(DIGIT)) tokens.push(match[0]);
	return tokens;
}
const tokenSet = (text) => new Set(tokensOf(text));
const containment = (needle, haystack) => {
	const small = tokenSet(needle);
	const large = tokenSet(haystack);
	if (small.size === 0) return 0;
	let shared = 0;
	for (const token of small) if (large.has(token)) shared++;
	return shared / small.size;
};
const THIN_CHARS = new Set([..."怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来"]);
const isThinToken = (token) => [...token].some((char) => THIN_CHARS.has(char));
const solidToken = (token) => [...token].some((char) => !THIN_CHARS.has(char));
const SITUATION_MARK = /(下雨|落雨|雨天|地湿|淋雨|下过雨|雨夜|阴天|天阴|阴起)/u;
const RULE_MARK = /(只有|除了|以后|要是|如果|除非|只要|平时|通常|一律|从来|不过|反倒|当周|就按|只喝|只跑|只放)/u;
const SOLID_OVERLAP = Number(process.env.SOLID ?? 3);

function gate(query, text, aliases = '') {
	const row = aliases.trim().length === 0 ? text : `${text} ${aliases}`;
	const c = containment(query, row);
	const aliasOk = (() => {
		for (const word of aliases.split(/\s+/u)) {
			if (word.length < 2) continue;
			if (![...word].some((char) => !THIN_CHARS.has(char))) continue;
			if (query.includes(word)) return true;
		}
		return false;
	})();
	const ruleOk = RULE_MARK.test(text) && SITUATION_MARK.test(text);
	const asked = new Set(tokensOf(query).filter(solidToken));
	const own = new Set(tokensOf(row).filter(solidToken));
	let shared = 0;
	for (const token of asked) if (own.has(token)) shared++;
	const solidOk = SOLID_OVERLAP > 0 && shared >= SOLID_OVERLAP;
	return { c: Number(c.toFixed(3)), aliasOk, ruleOk, solidOk, shared, pass: c >= 0.25 || aliasOk || ruleOk || solidOk };
}
const loose = (query, limit) => [...new Set(tokensOf(query))].slice(0, limit).map((one) => `"${one.replaceAll('"', '""')}"`).join(' OR ');
const strict = (query, limit) => [...new Set(tokensOf(query))].slice(0, limit).map((one) => `"${one.replaceAll('"', '""')}"`).join(' ');

const report = {};
for (const id of IDS) {
	const exam = exams.get(id);
	const one = JSON.parse(fs.readFileSync(path.join(PROBE, `${id.replace(/\//g, '_')}.json`), 'utf8'));
	const snap = path.join(PROBE, `${id.replace(/\//g, '_')}.db`);
	if (!exam || !fs.existsSync(snap)) {
		console.log(`跳过 ${id}（缺题面或快照）`);
		continue;
	}
	const ev = evidence.get(id) ?? {};
	const goldTurns = [...new Set((ev.sources ?? []).map((row) => row.turn))];
	const goldTexts = (ev.sources ?? []).map((row) => String(row.quote ?? ''));
	const q = exam.question;
	const db = new DatabaseSync(snap, { readOnly: true });
	const out = { id, question: q, cutoff: exam.cutoff_turn, goldTurns, parts: {} };
	try {
		/* ① 原话池 */
		const poolLoose = db.prepare(`SELECT l.id, l.turn, l.role, l.text, bm25(l0_fts, 1.0, 1.0) AS bm25 FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = (SELECT identity_id FROM l0 LIMIT 1) ORDER BY bm25 LIMIT 40`).all(loose(q, 200));
		const poolStrict = db.prepare(`SELECT COUNT(*) AS n FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ?`).get(strict(q, 24));
		/* ② 重排口径 */
		const strong = [...new Set(tokensOf(q))].filter((token) => !isThinToken(token));
		const ranked = poolLoose
			.map((row) => ({ ...row, hits: [...new Set(tokensOf(row.text))].filter((token) => strong.includes(token)).length }))
			.sort((a, b) => b.hits - a.hits || a.bm25 - b.bm25);
		/*
		 * 变体：按**词的稀有度**加权，而不是数命中几个词。
		 *
		 * `rankQuoteRows` 现在数的是「命中几个内容词」，与词有多常见无关：一句
		 * 「读第二遍容易又挑出新毛病」靠 挑出/毛病/一遍 三个泛词，压过真正那句带
		 * 「试读」的原话。IDF 用候选池自己的 df 估，不额外查库。
		 */
		const df = new Map();
		for (const row of poolLoose) for (const token of new Set(tokensOf(row.text))) df.set(token, (df.get(token) ?? 0) + 1);
		const n = Math.max(1, poolLoose.length);
		const idf = (token) => Math.log(1 + n / (df.get(token) ?? n));
		const rankedIdf = poolLoose
			.map((row) => {
				const own = new Set(tokensOf(row.text));
				let weight = 0;
				let hits = 0;
				for (const token of strong) {
					if (!own.has(token)) continue;
					hits++;
					weight += idf(token);
				}
				return { ...row, hits, weight };
			})
			.sort((a, b) => b.weight - a.weight || a.bm25 - b.bm25);
		out.parts.l0 = {
			strictMatches: poolStrict.n,
			poolSize: poolLoose.length,
			goldInPool: goldTurns.map((turn) => poolLoose.findIndex((row) => row.turn === turn)),
			goldRanked: goldTurns.map((turn) => ranked.findIndex((row) => row.turn === turn)),
			goldIdf: goldTurns.map((turn) => rankedIdf.findIndex((row) => row.turn === turn)),
			idfTop: rankedIdf.slice(0, 6).map((row) => ({ turn: row.turn, role: row.role, hits: row.hits, w: Number(row.weight.toFixed(2)), head: String(row.text).slice(0, 34) }))
		};
		/* ③ 派生层：事实与偏好 */
		const titleOf = (text) => String(text).slice(0, 34);
		const scan = (table, fts, cols) => {
			let rows = [];
			try {
				rows = db.prepare(`SELECT ${cols} FROM ${fts} JOIN ${table} t ON t.id = ${fts}.rowid WHERE ${fts} MATCH ? ORDER BY bm25(${fts}) LIMIT 30`).all(loose(q, 12));
			} catch (error) {
				return { error: String(error.message) };
			}
			return rows.map((row, index) => {
				const g = gate(q, String(row.text), String(row.aliases ?? ''));
				return {
					rank: index + 1,
					id: row.id,
					kind: row.kind,
					head: titleOf(row.text),
					gate: g,
					gold: goldTexts.some((quote) => String(row.text).includes(quote.slice(0, 10)))
				};
			});
		};
		out.parts.facts = scan('facts', 'facts_fts', 't.id, t.kind, t.text, t.aliases');
		out.parts.prefs = scan('preferences', 'preferences_fts', `t.id, 'preference' AS kind, t.text, '' AS aliases`);
		/* ④ 金标原话在不在 l0（按轮次整行比对） */
		out.parts.goldInL0 = goldTurns.map((turn) => {
			const rows = db.prepare('SELECT id, role, text FROM l0 WHERE turn = ?').all(turn);
			return { turn, rows: rows.map((row) => ({ id: row.id, role: row.role, head: String(row.text).slice(0, 30) })) };
		});
	} finally {
		db.close();
	}
	report[id] = out;
	console.log(`\n===== ${id}  cutoff=${exam.cutoff_turn}`);
	console.log(`Q: ${q}`);
	console.log(`原话池：strict ${out.parts.l0.strictMatches} 条 · loose 取 ${out.parts.l0.poolSize} · 金标轮在池中名次 ${JSON.stringify(out.parts.l0.goldInPool)} · 数命中 ${JSON.stringify(out.parts.l0.goldRanked)} · IDF ${JSON.stringify(out.parts.l0.goldIdf)}`);
	for (const row of out.parts.l0.idfTop) console.log(`   #${row.turn} ${row.role} hits=${row.hits} w=${row.w} | ${row.head}`);
	const focus = (list, name) => {
		if (list.error) return console.log(`${name}: ${list.error}`);
		console.log(`${name}: ${list.length} 条候选`);
		for (const row of list.slice(0, 6)) console.log(`   ${row.rank}. [${row.kind}] gate=${row.gate.pass ? 'PASS' : 'drop'} c=${row.gate.c} shared=${row.gate.shared}${row.gold ? ' ★gold' : ''} | ${row.head}`);
	};
	focus(out.parts.facts, '事实');
	focus(out.parts.prefs, '偏好');
}
fs.writeFileSync(path.join(PROBE, 'rank-report.json'), JSON.stringify(report, null, 1));
