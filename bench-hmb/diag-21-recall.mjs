#!/usr/bin/env node
/*
* 2.1 漏检的「召回表达式」诊断。
*
* 上一轮（§86.3）把 M01 的 38 道漏检分成三层：写侧 0、闸门 9、池子/打分 29。
* 29 这道里到底有多少是「表达式根本没带那个词」——这是第三层之前的一道关：
* 派生层那一路的 OR 表达式只取问句的**前 12 个二元组**（`compileLooseMatch`
* 默认 `limit = 12`），长问句里靠后的词从来没进过 FTS，所以不是排序排不出来，
* 是那一行压根不在候选里。
*
* 三个桶：
*   N  问句与锚点原话**一个内容二元组都不共享**（换说法 / 指代，非表达式问题）
*   B  有共享，但全落在前 12 之外 → 表达式截断
*   I  共享词在表达式内，仍未召回 → 排序 / 池子 / 闸门
*
* 用法：
*   node bench-hmb/diag-21-recall.mjs --rows <funnel json>        # 按漏斗产物（带 P/G 分类）
*   node bench-hmb/diag-21-recall.mjs --miss <anchors json>        # 按现行漏检名单（全量）
*/
import fs from "node:fs";
import path from "node:path";

const argOf = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};
const WORK = "C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work";
const DS = "C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset";
const SHOW = Number(argOf("show", 12));
const KINDS = String(argOf("kind", "P,G")).split(",").filter(Boolean);

const CJK_RUN = /[\p{Script=Han}]+/gu;
const LATIN_RUN = /[A-Za-z]+/gu;
const DIGIT_RUN = /\d+/gu;
/* 与 lib/index.js 的 THIN_CHARS 逐字一致；这里复制是因为那几个函数没导出。 */
const THIN_CHARS = new Set([..."怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明天年月日号点早晚最初先次来"]);

function tokensOf(text) {
	const tokens = [];
	for (const match of String(text ?? "").matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of String(text ?? "").matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
	for (const match of String(text ?? "").matchAll(DIGIT_RUN)) tokens.push(match[0]);
	return tokens;
}
function isThinToken(token) {
	if (/\d/u.test(token) || /[A-Za-z]/u.test(token)) return false;
	if ("我你他她它们".includes(token[0]) && !THIN_CHARS.has(token[1])) return false;
	return [...token].some((char) => THIN_CHARS.has(char));
}
const jsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

/** 从现行漏检名单拼出 {id, question, anchorTexts, funnelKind} 行。 */
function rowsFromMiss(file) {
	const anchorDetail = JSON.parse(fs.readFileSync(file, "utf8"));
	const exam = new Map(jsonl(`${DS}/exam-inputs.jsonl`).map((one) => [one.id, one]));
	const keys = new Map(jsonl(`${DS}/answer-key.jsonl`).map((one) => [one.id, one]));
	const turns = new Map();
	for (const persona of ["M01", "M02"]) turns.set(persona, new Map(jsonl(`${DS}/${persona}.jsonl`).map((row) => [Number(row["轮次"]), row["用户消息"] ?? ""])));
	const funnel = new Map();
	const funnelFile = `${WORK}/diag-funnel-base-m01.json`;
	if (fs.existsSync(funnelFile)) for (const row of JSON.parse(fs.readFileSync(funnelFile, "utf8")).rows) funnel.set(row.id, row.kind);
	const out = [];
	for (const row of anchorDetail.rows.filter((one) => one.state === "miss")) {
		const key = keys.get(row.id);
		const anchors = (key?.anchors ?? []).map((one) => turns.get(exam.get(row.id).persona)?.get(Number(one.last_turn)) ?? "");
		out.push({ id: row.id, question: exam.get(row.id)?.question ?? "", anchorTexts: anchors.filter((text) => text.length > 0), funnel: funnel.get(row.id) ?? "-" });
	}
	return out;
}

/** 从漏斗产物拼行（带 P/G 分类，只看 M01）。 */
function rowsFromFunnel(file) {
	return JSON.parse(fs.readFileSync(file, "utf8")).rows.filter((row) => KINDS.includes(row.kind));
}

const MISS = argOf("miss", null);
const rows = MISS ? rowsFromMiss(MISS) : rowsFromFunnel(argOf("rows", `${WORK}/diag-funnel-base-m01.json`));
const label = MISS ? `漏检名单 ${path.basename(MISS)}` : `漏斗 ${path.basename(argOf("rows", "diag-funnel-base-m01.json"))} kind=${KINDS.join(",")}`;

const buckets = { N: [], B: [], I: [] };
const detail = [];
for (const row of rows) {
	const ordered = [...new Set(tokensOf(row.question))];
	const content = ordered.filter((token) => !isThinToken(token));
	const anchorSet = new Set(row.anchorTexts.flatMap((text) => tokensOf(text)));
	const sharedAll = content.filter((token) => anchorSet.has(token));
	const inExpr = new Set(ordered.slice(0, 12));
	const sharedInExpr = sharedAll.filter((token) => inExpr.has(token));
	const firstPos = sharedAll.length > 0 ? content.indexOf(sharedAll[0]) : -1;
	const kind = sharedAll.length === 0 ? "N" : sharedInExpr.length === 0 ? "B" : "I";
	buckets[kind].push(row.id);
	detail.push({
		id: row.id,
		funnel: row.funnel ?? row.kind,
		kind,
		persona: row.id.slice(0, 3),
		question: row.question,
		shared: sharedAll.slice(0, 8).join(" "),
		sharedInExpr: sharedInExpr.slice(0, 8).join(" "),
		firstPos,
		exprTerms: ordered.slice(0, 12).join(" "),
		anchor: String(row.anchorTexts[0] ?? "").replace(/\n/g, " / ").slice(0, 60)
	});
}

console.log(`\n${label}  共 ${rows.length} 题`);
console.log(`  N  零共享（换说法/指代）：${buckets.N.length}`);
console.log(`  B  共享词全在表达式之外（前 12 截断）：${buckets.B.length}`);
console.log(`  I  共享词在表达式内仍未召回（排序/池子）：${buckets.I.length}`);
const byPersona = {};
for (const one of detail) {
	const key = `${one.persona}:${one.kind}`;
	byPersona[key] = (byPersona[key] ?? 0) + 1;
}
console.log("  按人物：", JSON.stringify(byPersona));

for (const kind of ["B", "I", "N"]) {
	const list = detail.filter((one) => one.kind === kind).slice(0, SHOW);
	if (list.length === 0) continue;
	console.log(`\n=== ${kind} ===`);
	for (const one of list) {
		console.log(`· ${one.id} [漏斗${one.funnel}] 共享第${one.firstPos + 1}名: ${one.shared || "—"}${one.sharedInExpr ? ` ｜在表达式内: ${one.sharedInExpr}` : ""}`);
		console.log(`   Q: ${one.question}`);
		if (kind === "B") console.log(`   表达式: ${one.exprTerms}`);
		console.log(`   锚点: ${one.anchor}`);
	}
}
const outFile = `${WORK}/diag-recall${MISS ? "-miss" : ""}.json`;
fs.writeFileSync(outFile, JSON.stringify({ counts: { N: buckets.N.length, B: buckets.B.length, I: buckets.I.length }, rows: detail }, null, 1));
console.log(`\n写成 JSON：${outFile}`);
