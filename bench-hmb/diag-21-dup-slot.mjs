/**
 * 检索结果里的「同一条记忆占两个名额」有多少？
 *
 * 起因：`M02-G048/d015` 问「二期合同当初记岔了，后来怎么改的」，正确答案 10-09
 * 那条事实（#373）在库里、检索却没给；top-5 里第 2 条是原话 `#L313`，第 3 条是
 * 由同一段派生的事实 `#F172`——两条说的是同一句，占了两个名额。
 *
 * 判据写死，不做语义判断：一条结果带 `#L<行号>`、另一条带 `#F<id>`，而那条事实
 * 的 `source_ids` 覆盖该行号 → 记为「同源占位」一对。这样量的只是「同一段原文被
 * 印了两遍」，与「两件事像不像」无关，不会把日常重复算进来。
 *
 *   node bench-hmb/diag-21-dup-slot.mjs
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const W = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/';
const DBS = {
	M01: 'C:/Users/shaoz/AppData/Local/Temp/s21-M01-MZ8sf9/loom.db',
	M02: 'C:/Users/shaoz/AppData/Local/Temp/s21-M02-l3Gw0V/loom.db'
};

const rows = fs.readFileSync(W + 'surface-21-v0270.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const judged = new Map(fs.readFileSync(W + 'judge-21-0270.jsonl', 'utf8').trim().split('\n').map((line) => JSON.parse(line)).map((row) => [row.id, row]));

/** fact id -> 它覆盖的 l0 行号集合。 */
const covered = new Map();
for (const [persona, path] of Object.entries(DBS)) {
	const db = new DatabaseSync(path, { readOnly: true });
	const facts = db.prepare('SELECT id, source_ids FROM facts').all();
	for (const fact of facts) {
		const ids = new Set(String(fact.source_ids ?? '').match(/\d+/gu)?.map(Number) ?? []);
		covered.set(`${persona}#${fact.id}`, ids);
	}
	db.close();
}

let paired = 0;
let pairedFails = 0;
let total = 0;
let fails = 0;
const examples = [];
for (const row of rows) {
	const search = String(row.context?.search ?? '');
	if (search.length === 0) continue;
	const persona = row.id.slice(0, 3);
	const lines = [...search.matchAll(/#L(\d+)(?:-\d+)?/gu)].map((m) => Number(m[1]));
	const facts = [...search.matchAll(/#F(\d+)/gu)].map((m) => Number(m[1]));
	let hit = 0;
	for (const id of facts) {
		const set = covered.get(`${persona}#${id}`);
		if (set === undefined) continue;
		if (lines.some((one) => [...set].includes(one) || [...set].includes(one - 1))) hit++;
	}
	const failed = judged.get(row.id)?.date_wrong === true || judged.get(row.id)?.required?.includes('missed') === true;
	total++;
	if (failed) fails++;
	if (hit > 0) {
		paired++;
		if (failed) pairedFails++;
		if (examples.length < 8) examples.push({ id: row.id, hit, failed, question: String(row.context?.block ?? '').length });
	}
}

console.log(`有检索面的题 ${total}，其中「原话 + 同源事实」同时出现 ${paired}（${(paired / total * 100).toFixed(1)}%）`);
console.log(`这批里带 missed/date_wrong 的 ${pairedFails}`);
console.log(`全体失败 ${fails}`);
for (const one of examples) console.log(' ', one.id, `同源 ${one.hit} 对`, one.failed ? '失败' : '通过');

/* 顺带量一句：按紧判据（jaccard ≥ .5）还有多少条真重复没合并。 */
for (const [persona, path] of Object.entries(DBS)) {
	const db = new DatabaseSync(path, { readOnly: true });
	const facts = db.prepare("SELECT id, text FROM facts WHERE status IN ('active','disputed') AND isolated = 0").all();
	const CJK = /[\p{Script=Han}]+/gu;
	const bigrams = (text) => {
		const out = new Set();
		for (const run of String(text).matchAll(CJK)) {
			const chars = [...run[0]];
			for (let i = 0; i < chars.length - 1; i++) out.add(`${chars[i]}${chars[i + 1]}`);
		}
		return out;
	};
	const sets = facts.map((fact) => bigrams(fact.text));
	let pairs = 0;
	const sample = [];
	for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
		let shared = 0;
		for (const token of sets[i]) if (sets[j].has(token)) shared++;
		const jac = shared / (sets[i].size + sets[j].size - shared);
		if (jac >= 0.5) {
			pairs++;
			if (sample.length < 5) sample.push([facts[i], facts[j], jac]);
		}
	}
	console.log(`\n${persona}：active ${facts.length} 条，jaccard ≥ .5 的重复对 ${pairs}`);
	for (const [a, b, jac] of sample) console.log(`  ${jac.toFixed(2)} #${a.id} ${a.text.slice(0, 34)} || #${b.id} ${b.text.slice(0, 34)}`);
	db.close();
}
