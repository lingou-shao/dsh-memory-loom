/*
 * 混合索引（单字 + 二元组）在 714 卷未覆盖事实上的 top-k 收益。
 *
 * 背景：`eval-slot-ceiling-714.mjs` 量到未覆盖的 124 条里，二元组 0 个的 45 条中
 * 有 28 条仍共享 ≥2 个内容单字（`坐很久`/`久坐`、`下雨`/`雨天`）；全卷真正一个
 * 内容字都共享的只有 8 条。也就是说「零重合」是二元组口径造成的错觉，不是语料里
 * 真的没有共同字。
 *
 * 这一步把上限换成真实读数：拿全卷 1085 条证据原话当检索池，问句当查询，
 * 分别用「只用二元组」和「二元组 + α·单字」打分，看**原本未覆盖**的那 124 条
 * 能被拉到第几名。α=0 是现状的近似（池更小，所以是乐观值，不是现状读数）。
 *
 * 文献：Nie/Gao/Zhang/Zhou 2001 量过「单字 + 二元组 + 词」混合索引最好；
 * Lucene 的 CJKAnalyzer 从 2000 年代初就一直用二元组，缺点正是 recall 高而
 * precision 低——所以这里扫 α，不是直接加权。
 *
 * 复跑：node bench-hmb/sem/eval-mixed-index-714.mjs [--k 3]
 */
import { readFileSync } from 'node:fs';

const SURFACE = 'C:/Users/shaoz/Desktop/chat-memory-bench/loom-surface.jsonl';
const EVIDENCE = 'C:/Users/shaoz/Desktop/chat-memory-bench/grading/evidence.jsonl';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] !== void 0 ? process.argv[i + 1] : fallback;
};
const K = Number(argOf('k', 3));

const THIN = new Set([..."怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来"]);
const CJK = /[\u4e00-\u9fff]+/gu;

const bigramsOf = (text) => {
	const out = [];
	for (const run of String(text).matchAll(CJK)) {
		const c = [...run[0]];
		for (let i = 0; i < c.length - 1; i++) out.push(c[i] + c[i + 1]);
	}
	return out;
};
const contentBigrams = (text) => bigramsOf(text).filter((b) => ![...b].some((ch) => THIN.has(ch)));
const contentChars = (text) => [...String(text).matchAll(CJK)].flatMap((m) => [...m[0]]).filter((ch) => !THIN.has(ch));

/* 检索池：每条计分事实的证据原话。同一段话只留一份。 */
const surface = readFileSync(SURFACE, 'utf8').trim().split('\n').map(JSON.parse);
const evidence = new Map();
for (const line of readFileSync(EVIDENCE, 'utf8').trim().split('\n')) {
	const row = JSON.parse(line);
	const byId = new Map();
	for (const fact of row.facts ?? []) {
		const quote = (row.sources ?? []).find((s) => s.fact_id === fact.fact_id)?.quote ?? "";
		byId.set(fact.fact_id, `${fact.meaning ?? ""} ${quote}`.trim());
	}
	evidence.set(row.id, byId);
}

const docs = new Map();
const cases = [];
for (const record of surface) {
	const byId = evidence.get(record.id) ?? new Map();
	for (const fact of record.facts ?? []) {
		const text = byId.get(fact.factId) ?? "";
		if (text.length === 0) continue;
		if (!docs.has(text)) docs.set(text, { text, bigram: new Map(), char: new Map() });
		const doc = docs.get(text);
		for (const t of contentBigrams(text)) doc.bigram.set(t, (doc.bigram.get(t) ?? 0) + 1);
		for (const t of contentChars(text)) doc.char.set(t, (doc.char.get(t) ?? 0) + 1);
		cases.push({ id: record.id, tags: record.tags ?? [], question: record.question ?? "", text, covered: (fact.toolR10 ?? 0) >= 0.8 });
	}
}
const docList = [...docs.values()];
const avgLen = (key) => docList.reduce((sum, d) => sum + [...d[key].values()].reduce((a, b) => a + b, 0), 0) / docList.length;
const avgBigram = avgLen("bigram");
const avgChar = avgLen("char");

const df = (key, term) => docList.reduce((n, d) => n + (d[key].has(term) ? 1 : 0), 0);
const idfCache = new Map();
const idf = (key, term) => {
	const ck = `${key}\u0000${term}`;
	if (!idfCache.has(ck)) {
		const n = df(key, term);
		idfCache.set(ck, Math.log(1 + (docList.length - n + 0.5) / (n + 0.5)));
	}
	return idfCache.get(ck);
};

/** BM25 over one token stream. `weightOf` lets the two streams share one formula. */
function bm25(doc, key, avg, terms) {
	let score = 0;
	const len = [...doc[key].values()].reduce((a, b) => a + b, 0);
	for (const term of terms) {
		const tf = doc[key].get(term);
		if (tf === void 0) continue;
		const norm = 1 - 0.75 + 0.75 * (len / avg);
		score += idf(key, term) * ((tf * 2.2) / (tf + 1.2 * norm));
	}
	return score;
}

const bigramQueries = new Map();
const charQueries = new Map();
const queryOf = (q) => {
	if (!bigramQueries.has(q)) bigramQueries.set(q, contentBigrams(q));
	if (!charQueries.has(q)) charQueries.set(q, contentChars(q));
	return { bigram: bigramQueries.get(q), char: charQueries.get(q) };
};

/* 每个 α 跑一遍全池打分。池只有千条量级，暴力足够。 */
function run(alpha) {
	const rankOf = new Map();
	for (const c of cases) {
		const terms = queryOf(c.question);
		const scored = docList.map((d) => ({
			text: d.text,
			score: bm25(d, "bigram", avgBigram, terms.bigram) + alpha * bm25(d, "char", avgChar, terms.char)
		}));
		scored.sort((a, b) => b.score - a.score);
		const at = scored.slice(0, K).findIndex((s) => s.text === c.text);
		rankOf.set(c, at >= 0 ? at + 1 : Infinity);
	}
	return rankOf;
}

const miss = cases.filter((c) => !c.covered);
const hit = cases.filter((c) => c.covered);
console.log(`池 ${docList.length} 条证据原话，查询 ${cases.length} 条（未覆盖 ${miss.length} / 已覆盖 ${hit.length}），k=${K}\n`);
console.log("α\t未覆盖命中@k\t已覆盖命中@k\t全体命中@k");

const rows = [];
for (const alpha of [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2]) {
	const rank = run(alpha);
	const m = miss.filter((c) => rank.get(c) <= K).length;
	const h = hit.filter((c) => rank.get(c) <= K).length;
	const all = [...miss, ...hit].filter((c) => rank.get(c) <= K).length;
	rows.push({ alpha, m, h, all });
	console.log(`${alpha}\t${m}/${miss.length}\t${h}/${hit.length}\t${all}/${cases.length}`);
}

/* α 最佳时，把仍未命中的按考点列出来——这批才是真的要换机制。 */
const best = rows.reduce((a, b) => (b.m > a.m ? b : a));
const rank = run(best.alpha);
const still = miss.filter((c) => rank.get(c) > K);
const byTag = new Map();
for (const c of still) for (const tag of c.tags) byTag.set(tag, (byTag.get(tag) ?? 0) + 1);
console.log(`\n最佳 α=${best.alpha}，仍未命中 ${still.length} 条，按考点：`);
for (const [tag, n] of [...byTag].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${tag}\t${n}`);
if (process.argv.includes('--show')) {
	for (const c of still.slice(0, Number(argOf('show', 10)))) {
		console.log(`\n[${c.id} ${c.tags.join("/")}] 问：${c.question.replace(/\n/g, " / ").slice(0, 60)}`);
		console.log(`  证据：${c.text.slice(0, 80)}`);
	}
}
