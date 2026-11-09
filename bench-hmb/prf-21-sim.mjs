/**
 * 伪相关反馈（PRF）离线模拟 —— 验证「判决反馈均衡」这条在 2.1 上有没有用。
 *
 * 背景（§68 / §69）：候选生成是唯一还有空间的一层。
 *   - 排序已饱和：命中位次第 1 位 64.6%、前 3 位 96.3%、前 5 位 100%，检索平均只返回 3.4 行。
 *   - 融合类机制（RRF / 双路确认 / Cross-Encoder）不增加任何一路没返回的文档，治不了候选生成。
 *   - PRF 是唯一作用在候选生成层的机制：用首轮 top-k 的实词扩展查询再搜一遍。
 *
 * 这个脚本不改 lib，只在原始对话稿上重建一个轮级 BM25，做受控对比：
 *   基线 = 问句 top-5
 *   PRF  = 问句 top-3 → 抽扩展词 → top-5
 * 两份结果用同一语料、同一 BM25、同一判据（锚点轮 8 字窗），唯一变量是「扩不扩展」。
 *
 * 判据（先写死，跑完不许改）：
 *   PASS = 救回 >= 8 题 且 新增噪声行 <= 救回数 / 2
 *   噪声行 = 既不含锚点原话、又与问句零实词共享的行。
 *   救回 = 基线未命中、PRF 命中；被弄坏 = 基线命中、PRF 未命中（必须一起报）。
 *
 * 已知局限，读数时按此解释：
 *   1. 语料是原始轮次，不是产品里的 fact 库。产品的事实行是同一句话的截断（clip 200），
 *      所以「原始轮命中」≈「那里存在可被抽取的一句原话」，是上限而非产品实际读数。
 *   2. 分词用字符二元组，与 lib 内部口径一致，但没有词性标注，扩展词质量全靠同现约束兜。
 *
 *   node bench-hmb/prf-21-sim.mjs [--m 5] [--w 0.4] [--top 5] [--r1 3] [--show 10] [--sweep]
 */
import fs from 'node:fs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const SURFACE =
	process.env.CMB21_SURFACE ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/surface-21-v0254.jsonl';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const P = {
	m: Number(argOf('m', 5)),
	w: Number(argOf('w', 0.4)),
	top: Number(argOf('top', 5)),
	r1: Number(argOf('r1', 3)),
	show: Number(argOf('show', 10)),
	mode: argOf('mode', 'near')
};
const SWEEP = process.argv.includes('--sweep');
const WIN = 8;
const NEAR = 6;
const K1 = 1.2;
const B = 0.75;

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) =>
	String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】]/gu, '');

const STOP = new Set([
	'的是', '了的', '这个', '那个', '一个', '就是', '还是', '不是', '没有', '什么', '自己', '可以',
	'已经', '时候', '因为', '所以', '现在', '他们', '我们', '你们', '一下', '这方', '里没', '是不',
	'有没', '你还', '记得', '你记', '得吗', '的吗', '那次', '吗你', '我记', '定的', '是怎', '怎么',
	'跟我', '跟你', '说什', '什么', '么来', '来着', '说的', '是什', '不是', '对的', '那个'
]);

function grams(text) {
	const clean = norm(text);
	const out = new Set();
	for (let i = 0; i + 1 < clean.length; i++) {
		const g = clean.slice(i, i + 2);
		if (!STOP.has(g)) out.add(g);
	}
	return out;
}

/** 锚点轮原话里有没有一段 WIN 字窗落进 dst。 */
function windowHit(src0, dst0) {
	const src = norm(src0);
	const dst = norm(dst0);
	if (src.length < WIN) return null;
	if (dst.includes(src)) return true;
	for (let i = 0; i + WIN <= src.length; i++) if (dst.includes(src.slice(i, i + WIN))) return true;
	return false;
}

/* ---------- 载入 ---------- */
const keys = new Map(jsonl(`${DS}/answer-key.jsonl`).map((one) => [one.id, one]));
const exams = new Map(jsonl(`${DS}/exam-inputs.jsonl`).map((one) => [one.id, one]));
const anchorState = new Map(
	(JSON.parse(fs.readFileSync('bench-hmb/out/anchors-21-v0254.json', 'utf8')).rows ?? []).map((r) => [r.id, r])
);

const corpus = new Map();
const UNIT = argOf('unit', 'clause');
for (const persona of ['M01', 'M02']) {
	const rows = jsonl(`${DS}/${persona}.jsonl`).filter((r) => (r['用户消息'] ?? '').trim());
	rows.sort((a, b) => a['轮次'] - b['轮次']);
	const docsOf = (row) => {
		const text = row['用户消息'];
		const pieces =
			UNIT === 'turn'
				? [text]
				: text
						.split(/[。！？；，、\n\/…~～]+/u)
						.map((s) => s.trim())
						.filter((s) => norm(s).length >= 6);
		return pieces.map((piece, idx) => {
			const clean = norm(piece);
			const tf = new Map();
			const pos = new Map();
			for (let i = 0; i + 1 < clean.length; i++) {
				const g = clean.slice(i, i + 2);
				tf.set(g, (tf.get(g) ?? 0) + 1);
				if (!pos.has(g)) pos.set(g, []);
				pos.get(g).push(i);
			}
			return { turn: row['轮次'], idx, text: piece, clean, tf, pos, dl: Math.max(1, clean.length - 1) };
		});
	};
	corpus.set(persona, rows.flatMap(docsOf));
}
const turnText = (persona, turn) => {
	const docs = (corpus.get(persona) ?? []).filter((d) => d.turn === turn);
	return docs.map((d) => d.text).join(' / ');
};

/* ---------- 组题 ---------- */
const questions = [];
for (const one of jsonl(SURFACE)) {
	const key = keys.get(one.id);
	const exam = exams.get(one.id);
	if (!key || key.kind !== 'main' || !exam) continue;
	const anchors = (key.anchors ?? [])
		.map((a) => ({ turn: a.last_turn, text: turnText(one.persona, a.last_turn) }))
		.filter((a) => norm(a.text).length >= WIN);
	if (!anchors.length) continue;
	questions.push({
		id: one.id,
		persona: one.persona,
		case_id: key.case_id,
		bucket: key.interval_days,
		question: exam.question,
		cutoff: exam.cutoff_turn,
		state: anchorState.get(one.id)?.state ?? 'unknown',
		anchors,
		qgrams: grams(exam.question)
	});
}

/* ---------- 预计算：每题在「截至 cutoff」子库上的 DF / pool / 基线排序 ---------- */
const idf = (df, n) => Math.log(1 + (n - df + 0.5) / (df + 0.5));
function scoreDoc(doc, terms, df, n, avgdl) {
	let s = 0;
	for (const [term, w] of terms) {
		const f = doc.tf.get(term);
		if (!f) continue;
		s += w * idf(df.get(term) ?? 0, n) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * doc.dl) / avgdl)));
	}
	return s;
}

for (const q of questions) {
	const docs = corpus.get(q.persona);
	let lo = 0;
	let hi = docs.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (docs[mid].turn <= q.cutoff) lo = mid + 1;
		else hi = mid;
	}
	q.pool = docs.slice(0, lo);
	q.n = lo;
	q.df = new Map();
	let totalDl = 0;
	for (const doc of q.pool) {
		totalDl += doc.dl;
		for (const g of doc.tf.keys()) q.df.set(g, (q.df.get(g) ?? 0) + 1);
	}
	q.avgdl = totalDl / Math.max(1, lo);
	const scored = q.pool
		.map((doc) => ({ doc, s: scoreDoc(doc, [...q.qgrams].map((g) => [g, 1]), q.df, q.n, q.avgdl) }))
		.filter((x) => x.s > 0)
		.sort((a, b) => b.s - a.s);
	q.baseRank = scored;
	/* 命中判据：子句级看「取回的片段是不是来自锚点轮」（产品的事实行就是一个分句）；
	 * 整轮级则退化成「锚点原话的 8 字窗有没有落进来」，与 anchors-21.mjs 同口径。 */
	q.cover =
		UNIT === 'turn'
			? (doc) => q.anchors.some((a) => windowHit(a.text, doc.text) === true)
			: (doc) => q.anchors.some((a) => a.turn === doc.turn);
	q.noise = (x) => !q.cover(x.doc) && [...q.qgrams].every((g) => !x.doc.tf.has(g));
}

/* ---------- 单次仿真 ---------- */
function simulate(params) {
	const out = [];
	for (const q of questions) {
		const baseTop = q.baseRank.slice(0, params.top);
		const baseHit = baseTop.some((x) => q.cover(x.doc));

		const maxDf = Math.max(3, Math.round(0.05 * q.n));
		const cand = new Map();
		const harvest = (doc, rw) => {
			for (const [g] of doc.pos) {
				if (q.qgrams.has(g) || STOP.has(g)) continue;
				const d = q.df.get(g) ?? 0;
				if (d < 2 || d > maxDf) continue;
				cand.set(g, (cand.get(g) ?? 0) + rw * (doc.tf.get(g) ?? 1) * idf(d, q.n));
			}
		};
		if (params.mode === 'oracle') {
			/* 天花板诊断：扩展词取自**含答案那一句**本身（现实里拿不到，只用来量上限） */
			const target = q.baseRank.find((x) => q.cover(x.doc));
			if (target) harvest(target.doc, 1);
		} else {
			q.baseRank.slice(0, params.r1).forEach(({ doc }, rank) => {
				const rw = 1 / (rank + 1);
				if (params.mode === 'rocchio') { harvest(doc, rw); return; }
				/* near 模式：只收挨着某个问句词出现的词（保守，抗 query drift） */
				for (const [g, ps] of doc.pos) {
					if (q.qgrams.has(g) || STOP.has(g)) continue;
					const d = q.df.get(g) ?? 0;
					if (d < 2 || d > maxDf) continue;
					let near = false;
					for (const p of ps) {
						for (const qg of q.qgrams) {
							for (const s2 of doc.pos.get(qg) ?? []) {
								if (Math.abs(p - s2) <= NEAR) { near = true; break; }
							}
							if (near) break;
						}
						if (near) break;
					}
					if (!near) continue;
					cand.set(g, (cand.get(g) ?? 0) + rw * (doc.tf.get(g) ?? 1) * idf(d, q.n));
				}
			});
		}
		const expansion = [...cand.entries()].sort((a, b) => b[1] - a[1]).slice(0, params.m).map(([g]) => g);

		const terms = [...q.qgrams].map((g) => [g, 1]);
		for (const g of expansion) terms.push([g, params.w]);
		const prfTop = q.pool
			.map((doc) => ({ doc, s: scoreDoc(doc, terms, q.df, q.n, q.avgdl) }))
			.filter((x) => x.s > 0)
			.sort((a, b) => b.s - a.s)
			.slice(0, params.top);
		const prfHit = prfTop.some((x) => q.cover(x.doc));

		out.push({
			id: q.id,
			case_id: q.case_id,
			bucket: q.bucket,
			state: q.state,
			question: q.question,
			baseHit,
			prfHit,
			expansion,
			baseNoise: baseTop.filter(q.noise).length,
			prfNoise: prfTop.filter(q.noise).length,
			rowsBase: baseTop.length,
			rowsPrf: prfTop.length
		});
	}
	return out;
}

function summarize(list) {
	const n = list.length;
	const b = list.filter((r) => r.baseHit).length;
	const p = list.filter((r) => r.prfHit).length;
	const rescued = list.filter((r) => !r.baseHit && r.prfHit).length;
	const broken = list.filter((r) => r.baseHit && !r.prfHit).length;
	const nb = list.reduce((s, r) => s + r.baseNoise, 0);
	const np = list.reduce((s, r) => s + r.prfNoise, 0);
	return { n, b, p, rescued, broken, nb, np, dNoise: np - nb };
}
const pct = (a, b) => `${((100 * a) / (b || 1)).toFixed(1)}%`;

const results = simulate(P);

/* --dump：把逐题明细写盘，供 diag-21-missed.mjs 复核「写侧丢失 vs 闸门误杀」 */
const DUMP = argOf('dump', '');
if (DUMP) {
	const byId = new Map(questions.map((q) => [q.id, q]));
	const lines = results.map((r) => {
		const q = byId.get(r.id);
		const coverRow = q.baseRank.slice(0, P.top).find((x) => q.cover(x.doc));
		return JSON.stringify({
			id: r.id,
			persona: q.persona,
			case_id: r.case_id,
			state: r.state,
			question: r.question,
			cutoff: q.cutoff,
			now: exams.get(r.id)?.now ?? null,
			baseHit: r.baseHit,
			prfHit: r.prfHit,
			coveringTurn: coverRow?.doc.turn ?? null,
			coveringText: coverRow?.doc.text ?? null,
			baseRank: coverRow ? q.baseRank.findIndex((x) => x.doc === coverRow.doc) + 1 : null,
			anchorTurns: q.anchors.map((a) => a.turn)
		});
	});
	fs.writeFileSync(DUMP, lines.join('\n') + '\n', 'utf8');
	console.log(`\n明细写 ${DUMP}：${lines.length} 行`);
}
const all = summarize(results);
const miss = summarize(results.filter((r) => r.state === 'miss'));
const hit = summarize(results.filter((r) => r.state === 'hit'));

console.log(`PRF 模拟  surface=${SURFACE.split(/[\\/]/).pop()}  单元=${UNIT}  M=${P.m} w=${P.w} R1=${P.r1} TOP=${P.top}  mode=${P.mode}`);
console.log(`总体 ${all.n} 题（state 分布：miss ${miss.n} / hit ${hit.n}）`);
for (const [label, s] of [['全部', all], ['未命中 miss', miss], ['已命中 hit', hit]]) {
	console.log(
		`\n${label.padEnd(12)} 基线 ${String(s.b).padStart(3)}（${pct(s.b, s.n)}）  PRF ${String(s.p).padStart(3)}（${pct(s.p, s.n)}）  ` +
			`救回 ${s.rescued}  弄坏 ${s.broken}  噪声行 ${s.nb}→${s.np}（${s.dNoise > 0 ? '+' : ''}${s.dNoise}）`
	);
}

const pass = miss.rescued >= 8 && miss.dNoise <= miss.rescued / 2;
console.log(`\n判据（跑前写死）：救回 >= 8 且 新增噪声行 <= 救回/2`);
console.log(
	`  救回 ${miss.rescued}（≥8 ${miss.rescued >= 8 ? '✓' : '✗'}）  新增噪声 ${miss.dNoise}（≤${(miss.rescued / 2).toFixed(1)} ${miss.dNoise <= miss.rescued / 2 ? '✓' : '✗'}）`
);
console.log(`  → ${pass ? '通过，值得进 lib' : '不通过，不进 lib'}`);

const wins = results.filter((r) => r.state === 'miss' && !r.baseHit && r.prfHit);
console.log(`\n救回明细（${wins.length} 题）`);
for (const r of wins.slice(0, P.show)) {
	console.log(`  ${r.id.padEnd(16)} 扩展 [${r.expansion.join(' ')}]  ${r.question.slice(0, 42)}`);
}
const losses = results.filter((r) => r.state === 'miss' && r.baseHit && !r.prfHit);
if (losses.length) {
	console.log(`\n被弄坏（${losses.length} 题，基线本来能中但 PRF 挤出 top-${P.top}）`);
	for (const r of losses.slice(0, 6)) console.log(`  ${r.id} 扩展 [${r.expansion.join(' ')}]`);
}

/* ---------- 诊断：为什么救不回来 ----------
 * 两个可能：(a) 扩展词是垃圾，(b) 锚点原话在基线排序里根本排不到能被 5 个词顶上去的位置。
 * (b) 是决定性的：如果中位位次是几百，那任何「重排 / 扩词 / 融合」都治不了，只有换表示。 */
console.log('\n诊断');
const noExp = results.filter((r) => !r.expansion.length).length;
const avgExp = results.reduce((s, r) => s + r.expansion.length, 0) / results.length;
console.log(`  扩展词：0 个的题 ${noExp}/${results.length}，均值 ${avgExp.toFixed(1)} 个（M=${P.m}）`);

/* 扩展词里有多少是「真词」——用「该词在语料里出现过 >= 5 次」当粗代理。 */
const globalDf = new Map();
for (const q of questions) for (const [g, v] of q.df) globalDf.set(g, Math.max(globalDf.get(g) ?? 0, v));
const expAll = results.flatMap((r) => r.expansion);
const rare = expAll.filter((g) => (globalDf.get(g) ?? 0) < 5).length;
console.log(`  扩展词总数 ${expAll.length}，其中全库出现 <5 次的「碎片」 ${rare}（${pct(rare, expAll.length)}）`);

const rankOf = [];
let absent = 0;
for (const q of questions) {
	const i = q.baseRank.findIndex((x) => q.cover(x.doc));
	if (i === -1) { absent++; continue; }
	rankOf.push({ state: q.state, rank: i + 1 });
}
const q2 = (arr, p) => {
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
};
for (const st of ['miss', 'hit']) {
	const ranks = rankOf.filter((r) => r.state === st).map((r) => r.rank);
	if (!ranks.length) continue;
	console.log(
		`  ${st.padEnd(4)} 锚点最佳位次  n=${String(ranks.length).padStart(3)}  中位 ${String(q2(ranks, 0.5)).padStart(4)}  p75 ${String(q2(ranks, 0.75)).padStart(4)}  p90 ${String(q2(ranks, 0.9)).padStart(5)}  前5 ${ranks.filter((r) => r <= 5).length}  前20 ${ranks.filter((r) => r <= 20).length}  前50 ${ranks.filter((r) => r <= 50).length}`
	);
}
console.log(`  基线排序里完全没有锚点原话的题 ${absent}/${questions.length}（这类题 PRF 不可能救）`);

/* miss 里，位次落在「扩词有可能顶上来的范围」（6–20 位）的题有多少 */
const missRanks = rankOf.filter((r) => r.state === 'miss').map((r) => r.rank);
console.log(`  miss 中位次 6–20（扩词可及区间）${missRanks.filter((r) => r > 5 && r <= 20).length} 题；>50（不可及）${missRanks.filter((r) => r > 50).length} 题`);

if (process.argv.includes('--gap')) {
	/* 可及但没救回的题，缺的是什么词：锚点句里的实词 - 问句里的词 */
	console.log('\n词缺口（miss 且锚点位次 6–20，即扩词理论上够得着的题）');
	let shown = 0;
	for (const q of questions) {
		if (q.state !== 'miss' || shown >= P.show) continue;
		const idx = q.baseRank.findIndex((x) => q.cover(x.doc));
		if (idx < 5 || idx > 19) continue;
		const target = q.baseRank[idx].doc;
		const gap = [];
		for (const [g, tfv] of target.tf) {
			if (q.qgrams.has(g) || STOP.has(g)) continue;
			const d = q.df.get(g) ?? 0;
			if (d < 2 || d > Math.max(3, Math.round(0.05 * q.n))) continue;
			gap.push(g);
		}
		console.log(`\n  ${q.id}  位次 ${idx + 1}`);
		console.log(`    问：${q.question}`);
		console.log(`    锚：${target.text.replace(/\n/g, ' / ').slice(0, 110)}`);
		console.log(`    缺口（锚点句独有实词）：${gap.slice(0, 10).join(' ')}`);
		shown++;
	}
}

if (process.argv.includes('--bridge')) {
	/* 废案（2026-11-09 实测）：这个诊断没有选择性。
	 * 判据是「缺口词在别的子句里与某个问句词同句出现」，而问句词是高频二元组
	 * （我生 / 你说 / 奶茶），任何稀有二元组都能在某处与它同句 → 15 道可及题 100% 通过。
	 * 结论不能用。保留代码只为记录「这条路用二元组同现测不出来，需要语义」。 */
	console.log('\n桥可发现性（废案：判据无选择性，见 §69.4）');
	const inv = new Map(); // persona → term → Set(docIndex)
	for (const [persona, docs] of corpus) {
		const m = new Map();
		docs.forEach((d, i) => {
			for (const g of d.tf.keys()) {
				if (!m.has(g)) m.set(g, new Set());
				m.get(g).add(i);
			}
		});
		inv.set(persona, m);
	}
	let asked = 0;
	let withBridge = 0;
	for (const q of questions) {
		if (q.state !== 'miss') continue;
		const idx = q.baseRank.findIndex((x) => q.cover(x.doc));
		if (idx < 5 || idx > 19) continue;
		asked++;
		const target = q.baseRank[idx].doc;
		const gaps = [];
		for (const [g] of target.tf) {
			if (q.qgrams.has(g) || STOP.has(g)) continue;
			const d = q.df.get(g) ?? 0;
			if (d < 2 || d > Math.max(3, Math.round(0.05 * q.n))) continue;
			gaps.push(g);
		}
		const index = inv.get(q.persona);
		const bridges = [];
		for (const g of gaps) {
			const docsWithGap = [...(index.get(g) ?? [])].filter((i) => corpus.get(q.persona)[i].turn !== target.turn);
			for (const i of docsWithGap) {
				const doc = corpus.get(q.persona)[i];
				const shared = [...q.qgrams].filter((x) => doc.tf.has(x));
				if (shared.length) { bridges.push({ gap: g, shared: shared[0], turn: doc.turn }); break; }
			}
		}
		if (bridges.length) withBridge++;
		if (asked <= P.show) {
			console.log(`\n  ${q.id}  位次 ${idx + 1}  缺口 ${gaps.length} 个，可发现桥 ${bridges.length} 个`);
			console.log(`    问：${q.question.slice(0, 60)}`);
			for (const b of bridges.slice(0, 3)) console.log(`    桥：「${b.gap}」在 t${b.turn} 与问句词「${b.shared}」同句`);
		}
	}
	console.log(`\n  可及题 ${asked} 道，其中至少有一个可发现桥的 ${withBridge} 道 = ${pct(withBridge, asked)}`);
}

/* 与产品检索的重合度：同一个命中率不代表同一批题。
 * 如果两边失败集几乎不重叠，说明「换表示」才是能加候选的那条路（融合加不了）。
 * 注意判据不等价：我的是「取回子句来自锚点轮」，产品是「锚点原话 8 字窗落在输出里」。
 * 2026-11-09 抽查「只我中」6 题，6/6 取回的就是锚点那句原文（--onlymine 可复核）。 */
{
	const prodHit = results.filter((r) => r.state === 'hit').length;
	const mineHit = results.filter((r) => r.baseHit).length;
	const both = results.filter((r) => r.state === 'hit' && r.baseHit).length;
	const onlyProd = results.filter((r) => r.state === 'hit' && !r.baseHit).length;
	const onlyMine = results.filter((r) => r.state === 'miss' && r.baseHit).length;
	const neither = results.filter((r) => r.state === 'miss' && !r.baseHit).length;
	console.log('\n与产品检索的重合（我的子句级 BM25 top-5 vs 产品 state）');
	console.log(`  两者都中 ${both}   只产品中 ${onlyProd}   只我中 ${onlyMine}   都不中 ${neither}`);
	console.log(
		`  产品 ${prodHit}/${all.n}（${pct(prodHit, all.n)}）  我 ${mineHit}/${all.n}（${pct(mineHit, all.n)}）  并集 ${prodHit + onlyMine}/${all.n}（${pct(prodHit + onlyMine, all.n)}）  交集 ${both}`
	);
}

if (process.argv.includes('--onlymine')) {
	/* 「只我中」的题：我命中的是同一轮里的**哪一句**？如果只是同轮另一句，
	 * 那 71.6% 的并集是判据差异，不是真覆盖。 */
	console.log('\n只我的子句级 BM25 命中、产品未命中的题（核对是否同一句）');
	let shown = 0;
	for (const q of questions) {
		if (q.state !== 'miss' || shown >= P.show) continue;
		const top = q.baseRank.slice(0, P.top);
		const coverRows = top.filter((x) => q.cover(x.doc));
		if (!coverRows.length) continue;
		const doc = coverRows[0].doc;
		const anchorText = q.anchors.map((a) => a.text).join(' / ');
		const sharedWithQ = [...q.qgrams].filter((g) => doc.tf.has(g));
		const sharedWithAnchor = [...new Set(anchorText.match(/../gu) ?? [])].filter((g) => doc.tf.has(g));
		console.log(`\n  ${q.id}  问：${q.question.slice(0, 50)}`);
		console.log(`    取回子句：${doc.text.slice(0, 70)}`);
		console.log(`    锚点原话：${anchorText.replace(/\n/g, ' / ').slice(0, 70)}`);
		console.log(`    与问句共享 ${sharedWithQ.length} 个（${sharedWithQ.slice(0, 5).join(' ')}）  与锚点句共享 ${sharedWithAnchor.length} 个`);
		shown++;
	}
}

if (SWEEP) {
	console.log('\n参数敏感性（miss 子集）  格内 = 净变化 / 救回[v=被弄坏]');
	for (const mode of ['near', 'rocchio']) {
		for (const r1 of [1, 3, 5]) {
			const cells = [3, 5, 8, 12, 20].map((m) => {
				const s = summarize(simulate({ ...P, m, r1, mode }).filter((r) => r.state === 'miss'));
				return `M${String(m).padStart(2)}:+${String(s.p - s.b).padStart(3)}/${String(s.rescued).padStart(2)}${s.broken ? `v${s.broken}` : '  '}`;
			});
			console.log(`  ${mode.padEnd(7)} R1=${r1}  ${cells.join('  ')}`);
		}
	}
}
