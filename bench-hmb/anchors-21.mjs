/**
 * 2.1 的「定位」该怎么量：锚点位置 vs 锚点原话。
 *
 * 背景（docs/design.md §66.3）：答案键的 `anchors[].last_turn` 按上游 `read_exam_v21.py`
 * 的 V2 注释是「每个事实**最后一次相关提及**」，不是「承载这条要点的原话那一轮」。
 * 拿它当金标位置会同时产生两类错：冤枉（召回到更早的原话反判失败）与假阳性
 * （只召回到一句「离你生日还有俩月」就算成功）。
 *
 * 另外 `surface-21.mjs` 写盘时把 `refs`（L0 轮次区间）删了，位置映射随之丢失。
 * 所以这里不用位置，改用**原话命中**：锚点轮的用户消息里，有没有一段 ≥W 字的连续
 * 片段出现在块 / 检索结果 / 展开正文里。
 *
 * 为什么这里能用「N 字窗」而 §66.6 说 714 那套的 10 字窗在 2.1 上作废：作废的是拿
 * `reference_answer`（改写稿）去比原文。锚点轮的用户消息是**真实原文**，块里的事实行
 * 又是同一句原话的截断（`body` 由 `userTurnsOf` 的分句拼成、`clip 200`），所以只要
 * 这句进了块，前 8 字必在。这是布尔判据，没有阈值可调。
 *
 * 三分类，而不是二分类：
 *   hit        —— 锚点轮原话的某个 W 字窗出现在文本里
 *   miss       —— 没有
 *   unjudgeable—— 锚点轮归一后不足 W 字（例如只有「嗯」），这条锚点本身判不了
 *
 * 只报数，不下结论。
 *
 *   node bench-hmb/anchors-21.mjs [--surface FILE] [--window 8] [--show 12]
 */
import fs from 'node:fs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const SURFACE = argOf('surface', 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/surface-21-v0254.jsonl');
const W = Number(argOf('window', 8));
const SHOW = Number(argOf('show', 12));
/* 诊断用：命中是块给的还是检索结果给的。灵敏度检验也靠它——只看一路读数必须动。 */
const SOURCE = argOf('source', 'all');

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) => String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】]/gu, '');

/** 锚点轮原话里任意一个 W 字窗落进文本，就算这句端出来了。 */
function windowHitAt(anchorText, hayText, w) {
	const src = norm(anchorText);
	const dst = norm(hayText);
	if (src.length < w) return null;
	if (dst.length < w) return false;
	if (dst.includes(src)) return true;
	for (let i = 0; i + w <= src.length; i++) if (dst.includes(src.slice(i, i + w))) return true;
	return false;
}
const windowHit = (anchorText, hayText) => windowHitAt(anchorText, hayText, W);

const keys = new Map(jsonl(`${DS}/answer-key.jsonl`).map((one) => [one.id, one]));
const surface = jsonl(SURFACE);
const turnCache = new Map();
function turnText(persona, turn) {
	const key = `${persona}`;
	if (!turnCache.has(key)) {
		const rows = jsonl(`${DS}/${persona}.jsonl`);
		turnCache.set(key, new Map(rows.map((row) => [row['轮次'], row['用户消息'] ?? ''])));
	}
	return turnCache.get(key).get(turn) ?? '';
}

const rows = [];
for (const one of surface) {
	const key = keys.get(one.id);
	if (!key || key.kind !== 'main') continue;
	const ctx = one.context ?? {};
	const fromBlock = typeof ctx.block === 'string' ? ctx.block : '';
	const fromRefs = typeof ctx.search === 'string' ? ctx.search : '';
	const fromExpand = (Array.isArray(ctx.expanded) ? ctx.expanded.map((e) => e?.text ?? '') : []).join('\n');
	const fromSearch = `${fromRefs}\n${fromExpand}`;
	/*
	 * block  —— 自动注入块
	 * refs   —— memory_search 的摘要行（模型不主动展开时看到的就是这些）
	 * expand —— memory_expand 拉回的正文
	 * search —— refs + expand
	 * all    —— 全部
	 */
	const hay =
		SOURCE === 'block' ? fromBlock
		: SOURCE === 'refs' ? fromRefs
		: SOURCE === 'expand' ? fromExpand
		: SOURCE === 'search' ? fromSearch
		: `${fromBlock}\n${fromSearch}`;
	const anchors = (key.anchors ?? []).map((a) => {
		const text = turnText(one.persona, a.last_turn);
		const atW = {};
		for (const w of [6, 8, 10, 12]) atW[w] = windowHitAt(text, hay, w);
		return { turn: a.last_turn, hit: atW[W], text, atW };
	});
	const judged = anchors.filter((a) => a.hit !== null);
	rows.push({
		id: one.id,
		case_id: key.case_id,
		bucket: key.interval_days,
		anchors,
		state: judged.length === 0 ? 'unjudgeable' : judged.some((a) => a.hit) ? 'hit' : 'miss',
		len: anchors.length,
		short: anchors.filter((a) => a.hit === null).length
	});
}

const n = rows.length;
const count = (state) => rows.filter((r) => r.state === state).length;
const hit = count('hit');
const miss = count('miss');
const unj = count('unjudgeable');
console.log(`surface ${SURFACE.split(/[\\/]/).pop()}  题数 ${n}  窗长 ${W}  来源 ${SOURCE}`);
console.log(`  任一锚点原话进块 ${hit}/${n} = ${((100 * hit) / n).toFixed(1)}%`);
console.log(`  没有锚点进块     ${miss}/${n} = ${((100 * miss) / n).toFixed(1)}%`);
console.log(`  判不了（锚点轮不足 ${W} 字）${unj}/${n} = ${((100 * unj) / n).toFixed(1)}%`);
console.log(`  可判题里命中 ${hit}/${hit + miss} = ${((100 * hit) / (hit + miss)).toFixed(1)}%`);

/*
 * 一题有多个锚点时，「任一进块」是上界（一个要点被端出来就算过），「全部进块」是下界
 * （要点未必需要全部锚点）。真实值在两者之间，所以两个都报，不报单值。
 */
const allIn = rows.filter((r) => r.anchors.length > 0 && r.anchors.every((a) => a.hit === true));
const allInJudged = rows.filter((r) => r.anchors.length > 0 && r.anchors.every((a) => a.hit !== null));
const judgedRows = rows.filter((r) => r.state !== 'unjudgeable');
const ratio = judgedRows.reduce((sum, r) => {
	const ok = r.anchors.filter((a) => a.hit !== null);
	return sum + (ok.length ? ok.filter((a) => a.hit).length / ok.length : 0);
}, 0);
console.log(`\n多锚点区间（可判 ${judgedRows.length} 题）`);
console.log(`  上界 任一进块 ${judgedRows.filter((r) => r.state === 'hit').length}/${judgedRows.length} = ${((100 * judgedRows.filter((r) => r.state === 'hit').length) / judgedRows.length).toFixed(1)}%`);
console.log(`  下界 全部进块 ${allIn.length}/${allInJudged.length} = ${((100 * allIn.length) / allInJudged.length).toFixed(1)}%`);
console.log(`  平均覆盖 ${(ratio / judgedRows.length).toFixed(3)}（进块锚点数 / 该题可判锚点数）`);

/* 窗长敏感性：真判据应当对 W 不敏感（W 小只增加假阳性风险）。 */
console.log('\n窗长敏感性（可判题口径）');
for (const w of [6, 8, 10, 12]) {
	const judgedRows = rows.filter((r) => r.anchors.some((a) => a.atW[w] !== null));
	const hitRows = judgedRows.filter((r) => r.anchors.some((a) => a.atW[w] === true));
	const cov = judgedRows.reduce((sum, r) => {
		const ok = r.anchors.filter((a) => a.atW[w] !== null);
		return sum + (ok.length ? ok.filter((a) => a.atW[w] === true).length / ok.length : 0);
	}, 0);
	console.log(`  W=${String(w).padEnd(2)} 可判 ${String(judgedRows.length).padStart(3)} 题  上界 ${String(hitRows.length).padStart(3)} = ${((100 * hitRows.length) / judgedRows.length).toFixed(1)}%  平均覆盖 ${(cov / judgedRows.length).toFixed(3)}`);
}

/* 锚点个数为 0 的题单列：没锚点就无从判定位。 */
const zero = rows.filter((r) => r.len === 0);
console.log(`\n无锚点题 ${zero.length}：${zero.map((r) => r.id).join(' ')}`);

console.log('\n按间隔（可判题口径）');
const bucket = new Map();
for (const r of rows) {
	if (r.state === 'unjudgeable') continue;
	const b = r.bucket ?? '无';
	const cur = bucket.get(b) ?? { n: 0, hit: 0 };
	cur.n++;
	if (r.state === 'hit') cur.hit++;
	bucket.set(b, cur);
}
for (const b of [...bucket.keys()].sort((x, y) => (x === '无' ? 9e9 : x) - (y === '无' ? 9e9 : y))) {
	const cur = bucket.get(b);
	console.log(`  d${String(b).padEnd(3)} ${String(cur.hit).padStart(3)}/${String(cur.n).padEnd(3)} ${((100 * cur.hit) / cur.n).toFixed(1)}%`);
}

/* 同一 case 的多个 instance 共享锚点，失败会整组一起掉，必须按 case 看。 */
const byCase = new Map();
for (const r of rows) {
	const cur = byCase.get(r.case_id) ?? [];
	cur.push(r);
	byCase.set(r.case_id, cur);
}
const cases = [...byCase.entries()];
const allMiss = cases.filter(([, list]) => list.every((r) => r.state !== 'hit'));
const allHit = cases.filter(([, list]) => list.every((r) => r.state === 'hit'));
console.log(`\n按 case ${cases.length} 组：全挂 ${allMiss.length}（${allMiss.reduce((s, [, l]) => s + l.length, 0)} 题）、全过 ${allHit.length}、混合 ${cases.length - allMiss.length - allHit.length}`);
console.log(`全挂的 case：${allMiss.map(([c, l]) => `${c}(${l.length})`).join(' ')}`);

const worst = rows.filter((r) => r.state === 'miss').slice(0, SHOW);
console.log(`\n没端出来的 ${worst.length} 题`);
for (const r of worst) {
	console.log(`  ${r.id}  锚点 ${r.anchors.map((a) => `t${a.turn}${a.hit === null ? '(短)' : a.hit ? '✓' : '✗'}`).join(' ')}`);
	for (const a of r.anchors.slice(0, 2)) console.log(`      t${a.turn} 「${String(a.text).replace(/\n/g, ' / ').slice(0, 70)}」`);
}

/* 回归比对用：逐题明细写盘，`--json out.json`。 */
const JSON_OUT = argOf('json', null);
if (JSON_OUT) {
	const detail = {
		surface: SURFACE,
		window: W,
		n,
		upper: { hit, judged: hit + miss, rate: hit / (hit + miss) },
		lower: { all: allIn.length, judged: allInJudged.length, rate: allIn.length / allInJudged.length },
		coverage: ratio / judgedRows.length,
		rows: rows.map((r) => ({ id: r.id, case_id: r.case_id, bucket: r.bucket, state: r.state, anchors: r.anchors.map((a) => ({ turn: a.turn, hit: a.hit })) }))
	};
	fs.writeFileSync(JSON_OUT, JSON.stringify(detail, null, 1) + '\n', 'utf8');
	console.log(`\n明细写入 ${JSON_OUT}（${n} 题）`);
}
