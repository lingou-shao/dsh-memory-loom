#!/usr/bin/env node
/*
* 「共享词在表达式里，却还是没端出来」——到底是没召回，还是排在 10 条之后？
*
* 上一轮的漏斗只跑到 limit 10，所以 P 桶（29 道）里混着两种完全不同的病：
*   甲  这一行根本没进 FTS 的前 N 名 → 召回/排序要动
*   乙  它就在结果里，只是排在第 11 名之后 → 指针预算/排序，不是召回
*
* 判据：同一份库、同一个时钟，用两个 limit 各搜一次（10 和 50），看锚点轮原话
* 的 8 字窗在哪一档出现、出现在第几行。
*
*   node bench-hmb/diag-21-slots.mjs --ids M01-G074/d000,M01-G081/d000 [--limits 10,50]
*/
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLoom } from "../loom-e2e/harness.mjs";

const DS = process.env.CMB21_DIR ?? "C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset";
const WORK = "C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work";
const argOf = (name, fallback) => {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
};
const LIMITS = String(argOf("limits", "10,50")).split(",").map(Number);
const WIN = 8;

const jsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
const norm = (text) => String(text ?? "").replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, "");
function covers(clause, text) {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < WIN) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + WIN <= c.length; i++) if (t.includes(c.slice(i, i + WIN))) return true;
	return false;
}

const keys = new Map(jsonl(path.join(DS, "answer-key.jsonl")).map((one) => [one.id, one]));
const exams = new Map(jsonl(path.join(DS, "exam-inputs.jsonl")).map((one) => [one.id, one]));

/* 默认取上一轮判出的 I 桶（共享词在表达式内），可用 --ids 覆盖。 */
let ids = String(argOf("ids", "")).split(",").filter(Boolean);
if (ids.length === 0) {
	const detailFile = `${WORK}/diag-recall-miss.json`;
	if (fs.existsSync(detailFile)) ids = JSON.parse(fs.readFileSync(detailFile, "utf8")).rows.filter((one) => one.kind === "I").map((one) => one.id);
}
const PERSONAS = String(argOf("personas", "M01")).split(",").filter(Boolean);

const results = [];
for (const persona of PERSONAS) {
	const targets = ids.map((id) => exams.get(id)).filter((one) => one && one.persona === persona).sort((a, b) => a.cutoff_turn - b.cutoff_turn);
	if (targets.length === 0) continue;
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const byTurn = new Map(turns.map((turn) => [Number(turn["轮次"]), turn]));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `slots-${persona}-`));
	const dbPath = path.join(dir, "loom.db");
	const realNow = Date.now;
	let clock = Date.parse(turns[0]["逻辑时间"]);
	Date.now = () => clock;
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const sid = `slots-${persona}`;
	let cursor = 0;
	try {
		for (const exam of targets) {
			for (; cursor < turns.length && turns[cursor]["轮次"] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				clock = Date.parse(turn["逻辑时间"]);
				await loom.turn(sid, turn["用户消息"], turn["助手回复"], { at: clock });
			}
			clock = Date.parse(exam.now);
			const anchors = (keys.get(exam.id)?.anchors ?? [])
				.map((one) => turnTextOf(byTurn, Number(one.last_turn)))
				.filter((text) => norm(text).length >= WIN);
			const row = { id: exam.id, persona, question: exam.question, anchors, hits: {} };
			for (const limit of LIMITS) {
				const out = String(await loom.call("memory_search", { query: exam.question, limit }, sid));
				const lines = out.split("\n");
				const at = lines.findIndex((line) => anchors.some((anchor) => covers(anchor, line)));
				row.hits[limit] = { hit: at >= 0, line: at >= 0 ? at + 1 : null, rows: (out.match(/#[FEL]\d/gu) ?? []).length, chars: out.length };
				if (limit === LIMITS[0]) row.first = lines.slice(0, 4).map((line) => line.slice(0, 90));
			}
			results.push(row);
			console.error(`  ${exam.id}  ${LIMITS.map((l) => `${l}:${row.hits[l].hit ? "✓" + row.hits[l].line : "✗"}`).join(" ")}`);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

function turnTextOf(byTurn, turn) {
	return byTurn.get(turn)?.["用户消息"] ?? "";
}

const ok = (limit) => results.filter((one) => one.hits[limit].hit).length;
console.log(`\n共 ${results.length} 题`);
for (const limit of LIMITS) console.log(`  limit ${limit}：端出来 ${ok(limit)} 题`);
console.log("\n只在 50 出现、不在 10 出现（排名问题）：");
for (const one of results.filter((row) => !row.hits[LIMITS[0]].hit && row.hits[LIMITS.at(-1)].hit)) {
	console.log(`  ${one.id}  第 ${one.hits[LIMITS.at(-1)].line} 行 / 共 ${one.hits[LIMITS.at(-1)].rows} 条`);
}
console.log("\n两档都没有（召回问题）：");
for (const one of results.filter((row) => LIMITS.every((l) => !row.hits[l].hit))) console.log(`  ${one.id}  ${one.question.slice(0, 40)}`);
fs.writeFileSync(`${WORK}/diag-slots.json`, JSON.stringify(results, null, 1));
console.log(`\n写成 ${WORK}/diag-slots.json`);
