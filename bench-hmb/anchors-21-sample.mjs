/**
 * 抽查：`anchors-21.mjs` 判成命中/未命中的题，锚点轮到底承不承载 required。
 *
 * 这是给口径做人工核验用的，不是自动指标。输出每题：
 *   题面 / required / 锚点轮原文 / 判定 / 块里有没有 required 的数字元素
 * 抽法固定种子、按命中与否分层，便于以后原样复核。
 *
 *   node bench-hmb/anchors-21-sample.mjs --surface FILE --state hit --n 10
 */
import fs from 'node:fs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const SURFACE = argOf('surface', 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/surface-21-v0254.jsonl');
const STATE = argOf('state', 'hit');
const N = Number(argOf('n', 10));
const SEED = Number(argOf('seed', 20261109));
const W = 8;

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) => String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】]/gu, '');
function windowHitAt(src0, dst0) {
	const src = norm(src0);
	const dst = norm(dst0);
	if (src.length < W) return null;
	if (dst.includes(src)) return true;
	for (let i = 0; i + W <= src.length; i++) if (dst.includes(src.slice(i, i + W))) return true;
	return false;
}

/* 简单确定性抽样：xorshift，种子固定。 */
function rng(seed) {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13; x >>>= 0;
		x ^= x >> 17;
		x ^= x << 5; x >>>= 0;
		return x / 4294967296;
	};
}

const keys = new Map(jsonl(`${DS}/answer-key.jsonl`).map((one) => [one.id, one]));
const exams = new Map(jsonl(`${DS}/exam-inputs.jsonl`).map((one) => [one.id, one]));
const turnCache = new Map();
function turnText(persona, turn) {
	if (!turnCache.has(persona)) {
		turnCache.set(persona, new Map(jsonl(`${DS}/${persona}.jsonl`).map((row) => [row['轮次'], row['用户消息'] ?? ''])));
	}
	return turnCache.get(persona).get(turn) ?? '';
}

const pool = [];
for (const one of jsonl(SURFACE)) {
	const key = keys.get(one.id);
	if (!key || key.kind !== 'main') continue;
	const ctx = one.context ?? {};
	const hay = [ctx.block ?? '', ctx.search ?? '', ...(ctx.expanded ?? []).map((e) => e?.text ?? '')].join('\n');
	const states = (key.anchors ?? []).map((a) => {
		const text = turnText(one.persona, a.last_turn);
		return { turn: a.last_turn, text, hit: windowHitAt(text, hay) };
	});
	const judged = states.filter((s) => s.hit !== null);
	if (!judged.length) continue;
	const state = judged.some((s) => s.hit) ? 'hit' : 'miss';
	pool.push({ id: one.id, key, exam: exams.get(one.id), states, state, hay });
}

const picked = pool.filter((one) => one.state === STATE);
const rand = rng(SEED);
const order = picked.map((one, i) => ({ one, r: rand(), i })).sort((a, b) => a.r - b.r).map((x) => x.one).slice(0, N);
for (const one of order) {
	console.log(`\n${'='.repeat(70)}`);
	console.log(`${one.id}  判定 ${one.state}  桶 d${one.key.interval_days}  ${(one.key.content_tags ?? []).join('/')}`);
	console.log(`问：${one.exam?.question}`);
	console.log('要点：');
	for (const r of one.key.rubric.required ?? []) console.log(`  - ${r}`);
	console.log('锚点：');
	for (const s of one.states) {
		console.log(`  t${s.turn} [${s.hit === null ? '不足8字' : s.hit ? '在块里' : '不在'}]\n     「${String(s.text).replace(/\n/g, ' ⏎ ')}」`);
	}
}
console.log(`\n共抽 ${order.length} 题（${STATE}，种子 ${SEED}，候选 ${picked.length}）`);
