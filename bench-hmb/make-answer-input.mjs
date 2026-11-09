#!/usr/bin/env node
/*
 * 把 0.2.53 的检索产物切成「作答输入包」。
 *
 * 只放三样东西：题目、考试时刻、系统自己捞回来的记忆（注入块 + 搜索行 + 展开正文）。
 * **不放** tags / facts / scoring 证据——作答模型只能看到记忆系统给它的东西，
 * 否则就是拿金标作答。
 *
 * 用法：
 *   node bench-hmb/make-answer-input.mjs <surface.jsonl> <outDir> [每题字数上限] [每包题数]
 */
import fs from "node:fs";
import path from "node:path";

const src = process.argv[2];
const outDir = process.argv[3];
const perQuestionCap = Number(process.argv[4] ?? 0);
const perBatch = Number(process.argv[5] ?? 30);
const maxChars = Number(process.argv[6] ?? 32000);

if (!src || !outDir) {
	console.error("用法: node make-answer-input.mjs <surface.jsonl> <outDir> [cap] [batchSize]");
	process.exit(1);
}

const rows = fs
	.readFileSync(src, "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));

const trim = (text, cap) => (cap > 0 && text.length > cap ? `${text.slice(0, cap)}\n…（截断）` : text);

const items = rows.map((row) => {
	const block = String(row.context?.block ?? "").trim();
	const search = String(row.context?.search ?? "").trim();
	const expanded = (row.context?.expanded ?? [])
		.map((one) => String(one.text ?? "").trim())
		.join("\n\n");
	const memory = [`【自动注入】\n${block}`, `【搜索】\n${search}`, `【展开】\n${expanded}`]
		.filter((part) => part.trim().length > 6)
		.join("\n\n");
	return {
		id: row.id,
		now: row.now,
		question: row.question,
		memory: trim(memory, perQuestionCap)
	};
});

fs.mkdirSync(outDir, { recursive: true });
const batches = [];
let current = [];
let chars = 0;
for (const item of items) {
	const size = JSON.stringify(item).length;
	if (current.length > 0 && (current.length >= perBatch || chars + size > maxChars)) {
		batches.push(current);
		current = [];
		chars = 0;
	}
	current.push(item);
	chars += size;
}
if (current.length > 0) batches.push(current);

batches.forEach((batch, index) => {
	const name = `batch-${String(index).padStart(3, "0")}.jsonl`;
	fs.writeFileSync(
		path.join(outDir, name),
		batch.map((one) => JSON.stringify(one)).join("\n") + "\n",
		"utf8"
	);
	console.log(name, batch.length, "题", batch.map((one) => JSON.stringify(one).length).reduce((a, b) => a + b, 0), "chars");
});
console.log("总计", items.length, "题 /", batches.length, "包");
