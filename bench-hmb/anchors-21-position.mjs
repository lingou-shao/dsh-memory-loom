/**
 * 命中的那些题，锚点原话排在检索结果第几位？
 *
 * 这决定「重排 / 融合 / Cross-Encoder / RRF」在我们这里还有没有空间：
 * 如果命中的都排在第 1-2 位，那是排序已经饱和，重排无事可做；
 * 如果分布铺到 5-10 位，才轮到重排类机制。
 *
 * 判定同 anchors-21.mjs：锚点轮用户消息的 8 字窗是否落进该行文本。
 * 行号从 `memory_search` 输出的 `1. ` / `2. ` 前缀读。
 *
 *   node bench-hmb/anchors-21-position.mjs [--surface FILE] [--window 8]
 */
import fs from 'node:fs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const SURFACE = argOf('surface', 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/surface-21-v0254.jsonl');
const W = Number(argOf('window', 8));

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) => String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】]/gu, '');
function windowHit(src0, dst0) {
	const src = norm(src0);
	const dst = norm(dst0);
	if (src.length < W) return null;
	if (dst.includes(src)) return true;
	for (let i = 0; i + W <= src.length; i++) if (dst.includes(src.slice(i, i + W))) return true;
	return false;
}

const keys = new Map(jsonl(`${DS}/answer-key.jsonl`).map((one) => [one.id, one]));
const turnCache = new Map();
function turnText(persona, turn) {
	if (!turnCache.has(persona)) {
		turnCache.set(persona, new Map(jsonl(`${DS}/${persona}.jsonl`).map((row) => [row['轮次'], row['用户消息'] ?? ''])));
	}
	return turnCache.get(persona).get(turn) ?? '';
}

/* 把 memory_search 的输出切成 [{ no, text }]，只保留带编号的行。 */
function lines(text) {
	const out = [];
	for (const raw of String(text ?? '').split('\n')) {
		const m = raw.match(/^\s*(\d+)\.\s*(.*)$/u);
		if (m) out.push({ no: Number(m[1]), text: m[2] });
	}
	return out;
}

const positions = [];
let answered = 0;
for (const one of jsonl(SURFACE)) {
	const key = keys.get(one.id);
	if (!key || key.kind !== 'main') continue;
	const anchors = (key.anchors ?? []).map((a) => turnText(one.persona, a.last_turn)).filter((t) => norm(t).length >= W);
	if (!anchors.length) continue;
	answered++;
	const rows = lines(one.context?.search);
	let first = null;
	for (const row of rows) {
		if (anchors.some((text) => windowHit(text, row.text) === true)) { first = row.no; break; }
	}
	if (first !== null) positions.push({ id: one.id, at: first, total: rows.length });
}

const n = answered;
const hits = positions.length;
console.log(`surface ${SURFACE.split(/[\\/]/).pop()}  有锚点可判 ${n} 题，检索行内命中 ${hits}（${((100 * hits) / n).toFixed(1)}%）`);
const dist = new Map();
for (const p of positions) dist.set(p.at, (dist.get(p.at) ?? 0) + 1);
console.log('\n首次命中位次分布');
for (const at of [...dist.keys()].sort((a, b) => a - b)) {
	const c = dist.get(at);
	console.log(`  第 ${String(at).padStart(2)} 位  ${String(c).padStart(3)}  ${'#'.repeat(Math.max(1, Math.round((40 * c) / hits)))}`);
}
const cum = (k) => positions.filter((p) => p.at <= k).length;
console.log('\n累计');
for (const k of [1, 2, 3, 5, 8, 10]) console.log(`  前 ${String(k).padStart(2)} 位内  ${cum(k)}/${hits} = ${((100 * cum(k)) / hits).toFixed(1)}%`);
const avgRows = positions.reduce((s, p) => s + p.total, 0) / (positions.length || 1);
console.log(`\n检索返回行数均值 ${avgRows.toFixed(1)}`);

/*
 * 没命中的题，检索行与问句有没有实词关联？
 *
 * 这一条决定「伪相关反馈（PRF / 判决反馈均衡）」这类机制可不可行：PRF 靠 top-k
 * 里的实词扩展，如果 top-k 本身就是与问句零共享的兜底结果，扩出来的词是噪声，
 * 只会 query drift。分组看平均共享二元组数。
 */
const STOP = new Set(['的是', '了的', '这个', '那个', '一个', '就是', '还是', '不是', '没有', '什么', '自己', '可以', '已经', '时候', '因为', '所以', '现在', '他们', '我们', '你们', '一下', '这方', '里没']);
function grams(text) {
	const clean = norm(text);
	const out = new Set();
	for (let i = 0; i + 1 < clean.length; i++) {
		const g = clean.slice(i, i + 2);
		if (!STOP.has(g)) out.add(g);
	}
	return out;
}
const shared = { hit: [], miss: [] };
for (const one of jsonl(SURFACE)) {
	const key = keys.get(one.id);
	if (!key || key.kind !== 'main') continue;
	const anchors = (key.anchors ?? []).map((a) => turnText(one.persona, a.last_turn)).filter((t) => norm(t).length >= W);
	if (!anchors.length) continue;
	const qg = grams(one.question ?? '');
	const rows = lines(one.context?.search);
	if (!rows.length) continue;
	const got = rows.some((row) => anchors.some((text) => windowHit(text, row.text) === true));
	let best = 0;
	for (const row of rows) {
		const rg = grams(row.text);
		let c = 0;
		for (const g of qg) if (rg.has(g)) c++;
		best = Math.max(best, c);
	}
	shared[got ? 'hit' : 'miss'].push(best);
}
const med = (list) => {
	const s = [...list].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
};
console.log('\n检索行与问句的共享二元组（每题取最好的一行）');
for (const [label, list] of Object.entries(shared)) {
	const zero = list.filter((v) => v === 0).length;
	console.log(`  ${label.padEnd(5)} ${String(list.length).padStart(3)} 题  中位 ${String(med(list)).padStart(2)}  均值 ${(list.reduce((a, b) => a + b, 0) / (list.length || 1)).toFixed(1)}  零共享 ${zero}/${list.length} = ${((100 * zero) / (list.length || 1)).toFixed(1)}%`);
}
