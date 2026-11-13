/**
 * 19 道「改主意」题：后续说法卡在哪一层。
 *
 * 分三段查，口径与 §100.2 的 diag-side 一致：
 *   ① 证据轮的原话在不在 l0（写侧）
 *   ② 在 l0 的话，原话有没有进本次提示词（查找侧）
 *   ③ 进了提示词，答案有没有用（表达侧，只能人看）
 *
 * 证据轮取答案键自己的 anchors.last_turn，不用我猜。
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const W = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/';
const DS = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset/';
const J = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const keys = new Map(J(DS + 'answer-key.jsonl').map((r) => [r.id, r]));
const exams = new Map(J(DS + 'exam-inputs.jsonl').map((r) => [r.id, r]));
const answers = new Map(J(W + 'answers-21-0270.jsonl').map((r) => [r.id, r.answer]));
const judges = new Map(J(W + 'judge-21-0270.jsonl').map((r) => [r.id, r]));
const surfaces = new Map(J(W + 'surface-21-v0270.jsonl').map((r) => [r.id, r]));

const corpus = {};
for (const p of ['M01', 'M02']) {
	corpus[p] = new Map();
	for (const line of fs.readFileSync(DS + p + '.jsonl', 'utf8').trim().split('\n')) {
		const d = JSON.parse(line);
		corpus[p].set(d['轮次'], d['用户消息'] ?? '');
	}
}
const DB = {
	M01: new DatabaseSync('C:/Users/shaoz/AppData/Local/Temp/s21-M01-MZ8sf9/loom.db', { readOnly: true }),
	M02: new DatabaseSync('C:/Users/shaoz/AppData/Local/Temp/s21-M02-l3Gw0V/loom.db', { readOnly: true })
};

const memOf = (row) => {
	const c = row?.context ?? {};
	const ex = c.expanded;
	const body = Array.isArray(ex) ? ex.map((o) => (typeof o === 'string' ? o : o.text ?? '')).join('\n') : ex ?? '';
	return [c.block ?? '', '【搜索】', c.search ?? '', '【展开】', body].join('\n');
};
const strip = (t) => String(t).replace(/[\s，。！？、；：“”‘’（）()【】…—~～]/gu, '');

const REVISE = /后来|改成|改为|延长|缩短|推迟|提前到|已作废|作废|已更正|更正|说法有变|最新|暂缓|又改|反悔|不开了|取消|最后定|原先|最初|最早/;

const rows = [];
for (const [id, j] of judges) {
	const k = keys.get(id);
	if (!k || k.kind !== 'main') continue;
	const req = j.required ?? [];
	if (!req.includes('missed')) continue;
	const texts = k.rubric.required ?? [];
	const missIdx = [];
	req.forEach((v, i) => { if (v !== 'met') missIdx.push(i); });
	if (!missIdx.some((i) => REVISE.test(texts[i] ?? ''))) continue;
	rows.push({ id, k, texts, missIdx, q: exams.get(id)?.question ?? '', ans: answers.get(id) ?? '' });
}

const tally = { notInL0: [], inL0NotPrompt: [], inPrompt: [], noTurn: [] };
for (const r of rows) {
	const p = r.id.slice(0, 3);
	const mem = strip(memOf(surfaces.get(r.id)));
	const turns = [...new Set((r.k.anchors ?? []).map((a) => a.last_turn).filter((t) => typeof t === 'number'))];
	if (!turns.length) { tally.noTurn.push(r.id); continue; }
	const detail = [];
	let inPrompt = 0, inL0 = 0;
	for (const t of turns) {
		const txt = strip(corpus[p].get(t) ?? '');
		if (txt.length < 10) continue;
		const probe = txt.slice(0, 14);
		const hitPrompt = mem.includes(probe);
		let hitL0 = false;
		try {
			hitL0 = DB[p].prepare('SELECT COUNT(*) AS n FROM l0 WHERE text LIKE ?').get('%' + probe.slice(0, 10) + '%').n > 0;
		} catch { hitL0 = false; }
		if (hitPrompt) inPrompt++;
		else if (hitL0) inL0++;
		detail.push({ t, hitPrompt, hitL0, head: (corpus[p].get(t) ?? '').slice(0, 30) });
	}
	console.log(`\n=== ${r.id} | ${r.q.slice(0, 46)}`);
	r.missIdx.forEach((i) => { if (REVISE.test(r.texts[i] ?? '')) console.log(`    x R${i} ${r.texts[i].slice(0, 70)}`); });
	console.log(`    答: ${r.ans.slice(0, 84)}`);
	for (const d of detail) console.log(`    证据 t${d.t} ${d.hitPrompt ? '进提示词' : d.hitL0 ? '在库未进' : '库里没有'} | ${d.head}`);
	if (inPrompt) tally.inPrompt.push(r.id);
	else if (inL0) tally.inL0NotPrompt.push(r.id);
	else tally.notInL0.push(r.id);
}

console.log('\n=== 汇总 ===');
console.log(`改主意题 ${rows.length} 道`);
console.log(`  证据原话进了提示词: ${tally.inPrompt.length} -> ${tally.inPrompt.join(', ')}`);
console.log(`  在库里但没进提示词: ${tally.inL0NotPrompt.length} -> ${tally.inL0NotPrompt.join(', ')}`);
console.log(`  证据原话库里就没有: ${tally.notInL0.length} -> ${tally.notInL0.join(', ')}`);
console.log(`  答案键没给锚点轮  : ${tally.noTurn.length} -> ${tally.noTurn.join(', ')}`);
