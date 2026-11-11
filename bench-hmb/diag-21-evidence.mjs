#!/usr/bin/env node
/*
* 「共享的那个词，到底有多稀有」——把 58 道漏检按**证据强度**重排一遍。
*
* 起因（§87.5）：I 桶 32 道被判成「排序问题」，但 I 的判据只问「共享的内容二元组
* 在不在表达式里」，没问**那个词有多少行也带着**。如果共享的只是「你说 / 快到 /
* 接着 / 自己」这类口语桥，问句和锚点之间其实没有可用的字面证据——那不是排序能
* 修的，把它算进「排序可救」等于把天花板估高。
*
* 所以这里换一把尺子：对每道漏检，取问句与锚点原话共享的内容二元组，逐个量它在
* **截止轮为止的用户轮**里出现多少次（DF），只看最稀有的那一个。
*
*   R  稀有        minDF ≤ 该人物的 rareLimit（M01 23 / M02 19）→ 闸门/追加档够得着
*   C  常见        19/23 < minDF ≤ 200 → 排序问题，但一百多行共享同一个词
*   V  极常见      minDF > 200 → 那个词不是证据，是口语桥
*   N  零共享      —（与 §87.1 的 N 桶同一判据）
*
* 口径：DF 在**用户轮**上数（与 `store.searchL0` 数到的行同源，assistant 轮不计），
* 时间窗到该题的 cutoff，不含之后的轮。全量文件读取，不建库。
*
*   node bench-hmb/diag-21-evidence.mjs [--miss FILE] [--show 20]
*/
import fs from 'node:fs';
import path from 'node:path';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const MISS = argOf('miss', `${WORK}/diag-recall-miss.json`);
const SHOW = Number(argOf('show', 25));

const CJK_RUN = /[\p{Script=Han}]+/gu;
const LATIN_RUN = /[A-Za-z]+/gu;
const DIGIT_RUN = /\d+/gu;
/* 与 lib/index.js 的 THIN_CHARS 逐字一致（那几个函数没导出）。 */
const THIN_CHARS = new Set([...'怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明天年月日号点早晚最初先次来']);

function tokensOf(text) {
	const tokens = [];
	for (const match of String(text ?? '').matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let i = 0; i < chars.length - 1; i++) tokens.push(`${chars[i]}${chars[i + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of String(text ?? '').matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
	for (const match of String(text ?? '').matchAll(DIGIT_RUN)) tokens.push(match[0]);
	return tokens;
}
function isThinToken(token) {
	if (/\d/u.test(token) || /[A-Za-z]/u.test(token)) return false;
	if ('我你他她它们'.includes(token[0]) && !THIN_CHARS.has(token[1])) return false;
	return [...token].some((char) => THIN_CHARS.has(char));
}

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((one) => [one.id, one]));
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));

/** 每个人的用户轮：轮次 → {at, text}，以及全卷 DF 表（按轮次前缀现算太慢，这里逐题数）。 */
const personaCache = new Map();
function personaData(persona) {
	if (personaCache.has(persona)) return personaCache.get(persona);
	const turns = jsonl(path.join(DS, `${persona}.jsonl`)).map((row) => ({
		turn: Number(row['轮次']),
		text: row['用户消息'] ?? '',
		tokens: new Set(tokensOf(row['用户消息'] ?? ''))
	}));
	const byTurn = new Map(turns.map((one) => [one.turn, one]));
	const data = { turns, byTurn };
	personaCache.set(persona, data);
	return data;
}

/* 漏检名单：`diag-recall-miss.json` 已经只留 miss，`state` 有值时再兜一层。 */
const list = JSON.parse(fs.readFileSync(MISS, 'utf8')).rows.filter((one) => one.state === undefined || one.state === 'miss');

const out = [];
for (const row of list) {
	const exam = exams.get(row.id);
	if (!exam) continue;
	const persona = exam.persona;
	const { turns, byTurn } = personaData(persona);
	const rareLimit = Math.max(3, Math.round(turns.length * 2 * 3 / 780));
	const anchorTurns = (keys.get(row.id)?.anchors ?? []).map((one) => Number(one.last_turn));
	const anchorTexts = anchorTurns.map((turn) => byTurn.get(turn)?.text ?? '').filter((text) => text.length > 0);
	const shared = [...new Set(tokensOf(row.question))].filter((token) => !isThinToken(token));
	const anchorTokens = new Set(anchorTexts.flatMap((text) => tokensOf(text)));
	const sharedTokens = shared.filter((token) => anchorTokens.has(token));
	let best = null;
	for (const token of sharedTokens) {
		let df = 0;
		for (const turn of turns) {
			if (turn.turn > exam.cutoff_turn) break;
			if (turn.tokens.has(token)) df++;
		}
		if (best === null || df < best.df) best = { token, df };
	}
	const minDf = best === null ? null : best.df;
	const kind = minDf === null ? 'N' : minDf <= rareLimit ? 'R' : minDf <= 200 ? 'C' : 'V';
	out.push({
		id: row.id,
		persona,
		kind87: row.kind ?? '?',
		kind,
		rareLimit,
		minDf,
		bestToken: best?.token ?? null,
		sharedCount: sharedTokens.length,
		shared: sharedTokens.slice(0, 6).join(' '),
		question: row.question,
		anchor: String(anchorTexts[0] ?? '').replace(/\n/gu, ' / ')
	});
}

const counts = {};
for (const one of out) counts[one.kind] = (counts[one.kind] ?? 0) + 1;
const label = { N: '零共享', R: '稀有共享（闸门/追加档够得着）', C: '常见共享（DF ≤ 200）', V: '极常见（DF > 200，口语桥）' };
console.log(`\n漏检 ${out.length} 题，按「最稀有的共享内容二元组」的 DF 重排（${path.basename(MISS)}）`);
for (const kind of ['N', 'R', 'C', 'V']) console.log(`  ${kind}  ${label[kind]}  ${counts[kind] ?? 0}`);

/* §87.1 的 N/B/I 与这一把尺子的交叉表：看 I 桶里有多少其实没有可用字面证据。 */
console.log('\n交叉（行=§87.1 的桶，列=证据强度）');
const cross = {};
for (const one of out) {
	cross[one.kind87] ??= { N: 0, R: 0, C: 0, V: 0 };
	cross[one.kind87][one.kind]++;
}
for (const [k, v] of Object.entries(cross).sort()) console.log(`  ${k}  N ${v.N}  R ${v.R}  C ${v.C}  V ${v.V}   共 ${v.N + v.R + v.C + v.V}`);

for (const kind of ['R', 'C', 'V', 'N']) {
	const list2 = out.filter((one) => one.kind === kind).slice(0, SHOW);
	if (!list2.length) continue;
	console.log(`\n=== ${kind}（${out.filter((one) => one.kind === kind).length}） ===`);
	for (const one of list2) {
		const df = one.minDf === null ? '—' : `${one.minDf}`;
		console.log(`· ${one.id} [${one.kind87}] DF ${df}/${one.rareLimit} 最好的词「${one.bestToken ?? '—'}」 共享 ${one.sharedCount} 个`);
		console.log(`   Q: ${one.question.slice(0, 60)}`);
		console.log(`   锚: ${one.anchor.slice(0, 50)}`);
	}
}
const outFile = `${WORK}/diag-evidence.json`;
fs.writeFileSync(outFile, JSON.stringify({ counts, cross, rows: out }, null, 1));
console.log(`\n写成 ${outFile}`);
