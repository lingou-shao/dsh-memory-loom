/**
 * 探索：能不能自动找出「承载某条 required 要点的那一轮」。
 *
 * 只用发布集（review-only 没公开，拿不到 sources / mention_turns），所以金标轮
 * 得自己找：对每条 required，在 cutoff 前的用户消息里找字符 bigram Dice 最高的一轮。
 *
 * 这一步只输出候选，不下结论——先看相似度分布是不是双峰，再人工抽查准确率。
 *
 *   node bench-hmb/anchors-21-explore.mjs [--persona M01] [--show 8]
 */
import fs from 'node:fs';
import path from 'node:path';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const ONLY = argOf('persona', null);
const SHOW = Number(argOf('show', 8));

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const STOP = new Set(['的是', '了的', '这个', '那个', '一个', '就是', '还是', '不是', '没有', '什么', '自己', '可以', '已经', '时候', '因为', '所以', '现在', '他们', '我们', '你们', '一下', '这方', '里没']);

/** 字符二元组，去停用。 */
function grams(text) {
	const clean = String(text).replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～]/gu, '');
	const out = new Set();
	for (let i = 0; i + 1 < clean.length; i++) {
		const g = clean.slice(i, i + 2);
		if (!STOP.has(g)) out.add(g);
	}
	return out;
}
const dice = (a, b) => {
	if (!a.size || !b.size) return 0;
	let hit = 0;
	const [small, big] = a.size <= b.size ? [a, b] : [b, a];
	for (const g of small) if (big.has(g)) hit++;
	return (2 * hit) / (a.size + b.size);
};

const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl')).filter((one) => !ONLY || one.persona === ONLY);

const turnCache = new Map();
function turnsOf(persona) {
	if (!turnCache.has(persona)) {
		const rows = jsonl(path.join(DS, `${persona}.jsonl`));
		turnCache.set(persona, rows.map((row) => ({ turn: row['轮次'], user: row['用户消息'] ?? '', ug: grams(row['用户消息'] ?? '') })));
	}
	return turnCache.get(persona);
}

const rows = [];
for (const exam of exams) {
	const key = keys.get(exam.id);
	if (!key || key.kind !== 'main') continue;
	const pool = turnsOf(exam.persona).filter((row) => row.turn <= exam.cutoff_turn);
	const anchors = (key.anchors ?? []).map((one) => one.last_turn);
	const perReq = [];
	for (const req of key.rubric.required ?? []) {
		const rg = grams(req);
		let best = null;
		for (const row of pool) {
			const s = dice(rg, row.ug);
			if (!best || s > best.score) best = { turn: row.turn, score: s, text: row.user };
		}
		perReq.push({ req, ...best });
	}
	rows.push({ id: exam.id, anchors, perReq });
}

const all = rows.flatMap((row) => row.perReq.map((one) => one.score)).sort((a, b) => a - b);
const q = (p) => all[Math.min(all.length - 1, Math.floor(p * all.length))];
console.log(`required 条数 ${all.length}（${rows.length} 题）`);
console.log(`相似度分位 p10 ${q(0.1).toFixed(3)} · p25 ${q(0.25).toFixed(3)} · p50 ${q(0.5).toFixed(3)} · p75 ${q(0.75).toFixed(3)} · p90 ${q(0.9).toFixed(3)}`);
const bins = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 1.01]];
for (const [lo, hi] of bins) {
	const n = all.filter((s) => s >= lo && s < hi).length;
	console.log(`  ${lo.toFixed(1)}–${hi.toFixed(1)}  ${String(n).padStart(4)}  ${'#'.repeat(Math.round((40 * n) / all.length))}`);
}

/* 自动定位到的轮落在锚点里的比例：这就是「锚点指向原话」的粗略估计。 */
let inAnchor = 0;
let n = 0;
for (const row of rows) {
	for (const one of row.perReq) {
		n++;
		if (row.anchors.includes(one.turn)) inAnchor++;
	}
}
console.log(`\n自动定位轮在锚点集内 ${inAnchor}/${n} = ${((100 * inAnchor) / n).toFixed(1)}%`);

const top = [...rows].sort((a, b) => (b.perReq[0]?.score ?? 0) - (a.perReq[0]?.score ?? 0)).slice(0, SHOW);
for (const row of top) {
	console.log(`\n## ${row.id}  锚点 ${row.anchors.join(',') || '（无）'}`);
	for (const one of row.perReq) {
		const hit = row.anchors.includes(one.turn) ? '锚点内' : '锚点外';
		console.log(`  要点「${one.req.slice(0, 40)}」`);
		console.log(`    → t${one.turn} (${one.score.toFixed(3)}, ${hit}) ${String(one.text).replace(/\n/g, ' / ').slice(0, 90)}`);
	}
}
