/**
 * 闸门只看到 BM25 的 top-N，N 就等于输出 limit（默认 10）。
 *
 * 这里量一件事：能过 0.25 闸门的候选，在 BM25 排序里到底排第几。
 * 如果它们大量落在 10 名之外，那「先取大池子再过滤」就是纯召回增益，
 * 而且不需要动闸门本身。
 *
 * 口径说明：用回放完成的库（facts/events 全量），按 `created_at <= now`
 * 过滤到发问当时。这是**机制诊断**，不判最终 A —— 位置口径见 §70.2 的告警，
 * 但这里问的是「排序里有没有、在第几」，与时点无关。
 *
 *   node bench-hmb/diag-21-rank.mjs [--top 200]
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const W = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const DS = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const DBS = { M01: `${W}/db-0254/M01.db`, M02: `${W}/db-0254/M02.db` };
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const TOP = Number(argOf('top', 200));

const CJK = /[\u4e00-\u9fa5]+/gu, LAT = /[a-z]+/giu, DIG = /\d+/gu;
function tokensOf(text) {
	const out = [];
	for (const m of String(text).matchAll(CJK)) { const c = [...m[0]]; for (let i = 0; i + 1 < c.length; i++) out.push(c[i] + c[i + 1]); if (c.length === 1) out.push(c[0]); }
	for (const m of String(text).matchAll(LAT)) out.push(m[0].toLowerCase());
	for (const m of String(text).matchAll(DIG)) out.push(m[0]);
	return out;
}
const setOf = (t) => new Set(tokensOf(t));
const containment = (needle, hay) => {
	const small = needle instanceof Set ? needle : setOf(needle);
	const large = hay instanceof Set ? hay : setOf(hay);
	if (!small.size) return 0;
	let n = 0; for (const t of small) if (large.has(t)) n++;
	return n / small.size;
};

const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const A = JSON.parse(fs.readFileSync('C:/Users/shaoz/Documents/GitHub/dsh-memory-loom/bench-hmb/out/anchors-21-v0254.json', 'utf8'));
const anchors = Array.isArray(A) ? A : (A.rows ?? A.items ?? []);
const missIds = new Set(anchors.filter((r) => r.state === 'miss').map((r) => r.id));
const exams = new Map(jsonl(`${DS}/exam-inputs.jsonl`).map((e) => [e.id, e]));

const CORPUS = new Map();
for (const p of ['M01', 'M02']) {
	const db = new DatabaseSync(DBS[p], { readOnly: true });
	const rows = [
		...db.prepare("SELECT id, text, aliases, created_at, 'fact' AS kind FROM facts").all().map((r) => ({ id: r.id, text: String(r.text ?? ''), aliases: String(r.aliases ?? ''), at: Number(r.created_at), kind: 'fact' })),
		...db.prepare("SELECT id, title, summary, aliases, ended_at FROM events").all().map((r) => ({ id: r.id, text: `${String(r.title ?? '')}：${String(r.summary ?? '')}`, aliases: String(r.aliases ?? ''), at: Number(r.ended_at), kind: 'event' }))
	];
	db.close();
	// 预计算 token 与长度，避免每题重算
	for (const row of rows) {
		row.tf = new Map();
		const t = tokensOf(`${row.text} ${row.aliases}`);
		for (const x of t) row.tf.set(x, (row.tf.get(x) ?? 0) + 1);
		row.len = t.length;
	}
	CORPUS.set(p, rows);
}

/* BM25，k1=1.2 b=0.75，与 lib 的 FTS5 默认量级一致（不追求逐位复刻，只看排序形状）。 */
const stats = new Map();
for (const [p, rows] of CORPUS) {
	const df = new Map();
	let total = 0;
	for (const r of rows) { total += r.len; for (const k of r.tf.keys()) df.set(k, (df.get(k) ?? 0) + 1); }
	stats.set(p, { df, avg: total / Math.max(1, rows.length), n: rows.length });
}

const band = { top10: 0, r11_50: 0, r51_200: 0, over200: 0, none: 0 };
const detail = [];
for (const id of missIds) {
	const e = exams.get(id);
	if (!e) continue;
	const p = id.slice(0, 3);
	const rows = (CORPUS.get(p) ?? []).filter((r) => r.at <= Date.parse(e.now));
	const st = stats.get(p);
	const q = setOf(e.question);
	const qt = [...q];
	const scored = rows.map((r) => {
		let s = 0;
		const dl = r.len || 1;
		for (const t of qt) {
			const f = r.tf.get(t); if (!f) continue;
			const d = st.df.get(t) ?? 1;
			const idf = Math.log(1 + (st.n - d + 0.5) / (d + 0.5));
			s += idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * dl / st.avg)));
		}
		return { r, s };
	}).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);

	let firstPass = -1, passCount = 0;
	for (let i = 0; i < scored.length; i++) {
		const row = scored[i].r;
		const c = containment(q, `${row.text} ${row.aliases}`);
		if (c >= 0.25) { passCount++; if (firstPass < 0) firstPass = i + 1; }
		if (i + 1 > TOP) break;
	}
	const where = firstPass < 0 ? 'none' : firstPass <= 10 ? 'top10' : firstPass <= 50 ? 'r11_50' : firstPass <= 200 ? 'r51_200' : 'over200';
	band[where]++;
	detail.push({ id, firstPass, passCount, cand: scored.length });
}

const n = detail.length;
console.log(`未命中 ${n} 题：能过 0.25 闸门的候选在 BM25 排序里的位置`);
for (const k of ['top10', 'r11_50', 'r51_200', 'over200', 'none']) {
	console.log(`  ${k.padEnd(8)} ${String(band[k]).padStart(3)}  ${((100 * band[k]) / n).toFixed(1)}%`);
}
const beyond = band.r11_50 + band.r51_200 + band.over200;
console.log(`\n第一名过闸候选在 10 名之后：${beyond}/${n} = ${((100 * beyond) / n).toFixed(1)}%`);
console.log(`排序里有候选的题 ${detail.filter((d) => d.cand > 0).length}/${n}，候选数中位 ${detail.map((d) => d.cand).sort((a, b) => a - b)[Math.floor(n / 2)]}`);
console.log('\n样例（firstPass 在 11–200 之间）');
for (const d of detail.filter((x) => x.firstPass > 10 && x.firstPass <= 200).slice(0, 10)) {
	console.log(`  ${d.id}  firstPass=${d.firstPass}  候选 ${d.cand}  过闸共 ${d.passCount}`);
}
fs.writeFileSync(`${W}/diag-rank.json`, JSON.stringify(detail, null, 1));
