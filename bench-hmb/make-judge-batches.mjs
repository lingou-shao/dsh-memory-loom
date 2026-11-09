#!/usr/bin/env node
/*
 * 判分材料压缩：packets.jsonl → 每批一个 txt，一行一题。
 *
 * 行格式（固定三段，便于逐行比对）：
 *   id ｜Q: 问句 ｜R: 必答项（多项用 / 分隔） ｜A: 系统回答
 *
 * 只做展示层压缩，判断仍由人（本轮是主 agent）逐题做。原始 packet 留在
 * detail-XXX.jsonl，遇到拿不准的行按 id 回查全文。
 */
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
const outDir = process.argv[3];
const perBatch = Number(process.argv[4] ?? 120);
const maxChars = Number(process.argv[5] ?? 30000);

const rows = fs
	.readFileSync(src, "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));

const flat = (text, cap) => String(text ?? "").replace(/\s*\n+\s*/g, " / ").trim().slice(0, cap);

const lines = rows.map((row) => {
	const required = (row.rubric?.required ?? []).map((one) => flat(one, 70)).join(" ／ ");
	const day = String(row.now ?? "").slice(0, 10);
	return {
		id: row.id,
		line: `${row.id} ｜T: ${day} ｜Q: ${flat(row.question, 60)} ｜R: ${required} ｜A: ${flat(row.answer, 140)}`
	};
});

fs.mkdirSync(outDir, { recursive: true });
const batches = [];
let current = [];
let chars = 0;
for (const item of lines) {
	if (current.length > 0 && (current.length >= perBatch || chars + item.line.length > maxChars)) {
		batches.push(current);
		current = [];
		chars = 0;
	}
	current.push(item);
	chars += item.line.length + 1;
}
if (current.length > 0) batches.push(current);

const byId = new Map(rows.map((row) => [row.id, row]));
batches.forEach((batch, index) => {
	const name = String(index).padStart(2, "0");
	fs.writeFileSync(path.join(outDir, `batch-${name}.txt`), batch.map((one) => one.line).join("\n") + "\n", "utf8");
	fs.writeFileSync(
		path.join(outDir, `detail-${name}.jsonl`),
		batch.map((one) => JSON.stringify(byId.get(one.id))).join("\n") + "\n",
		"utf8"
	);
	console.log(`batch-${name}.txt`, batch.length, "题", batch.map((one) => one.line.length + 1).reduce((a, b) => a + b, 0), "chars");
});
console.log("总计", lines.length, "题 /", batches.length, "批");
