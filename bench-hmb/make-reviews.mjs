#!/usr/bin/env node
/*
 * 我的判分结论（dec-XX.txt）→ 官方简式判断（judgements.jsonl）。
 *
 * dec 行格式：
 *   id ✓
 *   id ✗ req=0,0 错否 因=……
 * `req` 与该题 rubric.required 等长；省略即全部为 true。
 * 出现的旗标词写进对应布尔位，`违反禁止/未知当事实/无关旧事` 用 `#` 前缀带内容。
 * 没在 dec 里出现的题 → 直接报错，不默认通过（漏判必须能发现）。
 */
import fs from "node:fs";
import path from "node:path";

const packetsPath = process.argv[2];
const decDir = process.argv[3];
const outPath = process.argv[4];

const packets = fs
	.readFileSync(packetsPath, "utf8")
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));

const decisions = new Map();
for (const file of fs.readdirSync(decDir).filter((name) => /^dec-\d+\.txt$/.test(name)).sort()) {
	for (const raw of fs.readFileSync(path.join(decDir, file), "utf8").split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const mark = line.indexOf("✓") >= 0 ? "✓" : line.indexOf("✗") >= 0 ? "✗" : "";
		if (mark === "") throw new Error(`无法解析: ${file} ${line}`);
		const id = line.slice(0, line.search(/[✓✗]/)).trim();
		if (decisions.has(id)) throw new Error(`重复判分: ${id}`);
		decisions.set(id, { file, pass: mark === "✓", line });
	}
}

const missing = packets.map((one) => one.id).filter((id) => !decisions.has(id));
if (missing.length > 0) {
	console.error(`漏判 ${missing.length} 题:`, missing.slice(0, 10).join(", "));
	process.exit(1);
}
const unknown = [...decisions.keys()].filter((id) => !packets.some((one) => one.id === id));
if (unknown.length > 0) {
	console.error(`判了不存在的题 ${unknown.length}:`, unknown.slice(0, 10).join(", "));
	process.exit(1);
}

const FLAGS = ["错认", "错否", "越界", "编造日期", "不当私事披露"];
const LISTS = ["违反禁止", "未知当事实", "无关旧事"];

const rows = packets.map((packet) => {
	const decision = decisions.get(packet.id);
	const required = new Array(packet.rubric.required.length).fill(true);
	const flags = Object.fromEntries(FLAGS.map((name) => [name, false]));
	const lists = Object.fromEntries(LISTS.map((name) => [name, []]));
	let reason = "回答覆盖 rubric 的全部必答项，未出现错认、错否、越界、编造日期或不当披露。";

	if (!decision.pass) {
		const body = decision.line.replace(/^[^✓✗]+[✓✗]\s*/, "");
		const reqMatch = body.match(/req=([0-9,]+)/);
		if (reqMatch) {
			const values = reqMatch[1].split(",").map((one) => one.trim());
			if (values.length !== required.length) throw new Error(`required 长度不符: ${packet.id}`);
			values.forEach((value, index) => {
				required[index] = value === "1" || value === "true";
			});
		}
		for (const name of FLAGS) if (body.includes(name)) flags[name] = true;
		for (const name of LISTS) {
			const hit = body.match(new RegExp(`${name}[=:]([^\\s]+)`));
			if (hit) lists[name].push(hit[1]);
		}
		const reasonMatch = body.match(/因=(.+)$/);
		reason = reasonMatch ? reasonMatch[1].trim() : "未满足必答项。";
	}

	return {
		id: packet.id,
		required,
		错认: flags.错认,
		错否: flags.错否,
		越界: flags.越界,
		编造日期: flags.编造日期,
		不当私事披露: flags.不当私事披露,
		违反禁止: lists.违反禁止,
		未知当事实: lists.未知当事实,
		无关旧事: lists.无关旧事,
		reason
	};
});

fs.writeFileSync(outPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
const pass = rows.filter((row) => row.required.every(Boolean)).length;
console.log(`写出 ${rows.length} 条判断 → ${outPath}`);
console.log(`required 全过 ${pass} / ${rows.length}`);
