// 候选重排实验：向量先取 top-N，再用 cross-encoder 重排，看 top-k 是否变好。
//
//   node bench-hmb/sem/eval-rerank.mjs --n 20 --k 3
//   node bench-hmb/sem/eval-rerank.mjs --model Xenova/bge-base-zh-v1.5 --tag base
//
// 判分口径与 eval-vector.mjs 完全一致（同一份 questions.json、同一个 judge）。
// 唯一的变量是「N 个候选按什么顺序排」：一次是向量余弦，一次是 cross-encoder。
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline, AutoTokenizer, AutoModelForSequenceClassification, env } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'bench-hmb/sem/models';
env.useBrowserCache = false;

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const N = Number(argOf('n', 20));
const KMAX = Number(argOf('k', 6));
const MODEL = argOf('model', 'Xenova/bge-small-zh-v1.5');
const RERANKER = argOf('reranker', 'Xenova/bge-reranker-base');
const TAG = argOf('tag', 'rerank');
const LIMIT = Number(argOf('limit', 0));

const DIR = 'bench-hmb/out/sem';
const units = JSON.parse(await readFile(join(DIR, 'units.json'), 'utf8'));
const questions = JSON.parse(await readFile(join(DIR, 'questions.json'), 'utf8'));
const baseline = JSON.parse(await readFile('bench-hmb/out/retrieval_loom-epB.json', 'utf8'));
const baseRows = new Map(baseline.rows.map((r) => [r.qid, r]));

const judge = (q, cids) => {
  if (q.need.length === 0) return false;
  return q.all_needed ? q.need.every((n) => cids.has(n)) : q.need.some((n) => cids.has(n));
};

// ── 第一段：向量召回 top-N ─────────────────────────────────────────────
const embedder = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });
const embed = async (texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const res = await embedder(texts.slice(i, i + 32), { pooling: 'cls', normalize: true });
    out.push(...res.tolist());
  }
  return out;
};

const tEmbed = Date.now();
const unitVecs = await embed(units.map((u) => u.text));
const queryVecs = await embed(questions.map((q) => q.question));
const embedMs = Date.now() - tEmbed;

const topN = (vec) => {
  const scored = [];
  for (let i = 0; i < unitVecs.length; i++) {
    let dot = 0;
    const a = unitVecs[i];
    for (let d = 0; d < a.length; d++) dot += a[d] * vec[d];
    scored.push([i, dot]);
  }
  scored.sort((x, y) => y[1] - x[1]);
  return scored.slice(0, N).map(([i, s]) => ({ i, score: s }));
};

// ── 第二段：cross-encoder 重排 ────────────────────────────────────────
const tokenizer = await AutoTokenizer.from_pretrained(RERANKER);
const cross = await AutoModelForSequenceClassification.from_pretrained(RERANKER, { dtype: 'q8' });
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

const rerankScore = async (query, passages) => {
  const out = [];
  const BATCH = 8;
  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH);
    const inputs = tokenizer(batch.map(() => query), {
      text_pair: batch, padding: true, truncation: true, max_length: 512,
    });
    const logits = await cross(inputs);
    const data = logits.logits.data;
    const cols = logits.logits.dims.at(-1);
    for (let j = 0; j < batch.length; j++) out.push(sigmoid(Number(data[j * cols])));
  }
  return out;
};

const rows = [];
const tRerank = Date.now();
const work = LIMIT > 0 ? questions.slice(0, LIMIT) : questions;
for (let qi = 0; qi < work.length; qi++) {
  const q = work[qi];
  const cand = topN(queryVecs[qi]);
  const scores = await rerankScore(q.question, cand.map((c) => units[c.i].text));
  const reranked = cand
    .map((c, j) => ({ ...c, rerank: scores[j] }))
    .sort((x, y) => y.rerank - x.rerank);

  const vecCids = (k) => new Set(cand.slice(0, k).map((c) => units[c.i].cid));
  const rrCids = (k) => new Set(reranked.slice(0, k).map((c) => units[c.i].cid));
  const base = baseRows.get(q.qid);

  rows.push({
    qid: q.qid, type: q.type, need: q.need, all_needed: q.all_needed,
    rawEmpty: (base?.raw?.length ?? 0) === 0,
    vec: cand.map((c) => ({ cid: units[c.i].cid, ref: units[c.i].ref, score: +c.score.toFixed(4) })),
    reranked: reranked.map((c) => ({ cid: units[c.i].cid, ref: units[c.i].ref, score: +c.rerank.toFixed(4) })),
  });
  if ((qi + 1) % 100 === 0) process.stderr.write(`  ${qi + 1}/${work.length}\n`);
}
const rerankMs = Date.now() - tRerank;

const pick = (r, field, k) => new Set(r[field].slice(0, k).map((h) => h.cid));
const rate = (field, k) => rows.filter((r) => judge(r, pick(r, field, k))).length;
const emptyRows = rows.filter((r) => r.rawEmpty);
const emptyRate = (field, k) => emptyRows.filter((r) => judge(r, pick(r, field, k))).length;

const summary = {
  tag: TAG, model: MODEL, reranker: RERANKER, n: N, total: rows.length, embedMs, rerankMs,
  byK: Object.fromEntries(
    [1, 2, 3, 4, 6, 10, 20].filter((k) => k <= N).map((k) => [k, {
      vec: rate('vec', k), rerank: rate('reranked', k),
      emptyVec: emptyRate('vec', k), emptyRerank: emptyRate('reranked', k),
    }])
  ),
  byType: Object.fromEntries(
    [...new Set(rows.map((r) => r.type))].map((t) => {
      const rs = rows.filter((r) => r.type === t);
      return [t, {
        n: rs.length,
        vec: rs.filter((r) => judge(r, pick(r, 'vec', KMAX))).length,
        rerank: rs.filter((r) => judge(r, pick(r, 'reranked', KMAX))).length,
      }];
    })
  ),
};
await writeFile(`bench-hmb/out/rerank_${TAG}.json`, JSON.stringify({ summary, rows }, null, 1), 'utf8');

console.log(`\n嵌入 ${MODEL}（${unitVecs[0].length} 维）｜重排 ${RERANKER}｜候选 N=${N}`);
console.log(`嵌入 ${(embedMs / 1000).toFixed(1)}s｜重排 ${(rerankMs / 1000).toFixed(0)}s（${rows.length} 题，${(rerankMs / rows.length / 1).toFixed(0)}ms/题）\n`);
console.log('k'.padStart(3), '向量余弦'.padStart(12), '重排后'.padStart(10), '  差值');
for (const [k, s] of Object.entries(summary.byK)) {
  const d = s.rerank - s.vec;
  console.log(String(k).padStart(3), `${s.vec}/561 ${(s.vec / 561 * 100).toFixed(1)}%`.padStart(12),
    `${s.rerank}/561`.padStart(10), `  ${d >= 0 ? '+' : ''}${d}`);
}
console.log(`\n空材料题 ${emptyRows.length} 道，补回：`);
for (const [k, s] of Object.entries(summary.byK)) {
  console.log(`  k=${k}: 向量 ${s.emptyVec} → 重排 ${s.emptyRerank}`);
}
console.log('\n按类型（k=' + KMAX + '）：');
for (const [t, s] of Object.entries(summary.byType)) {
  console.log(`  ${t.padEnd(6)} n=${String(s.n).padStart(3)}  向量 ${String(s.vec).padStart(3)}  重排 ${String(s.rerank).padStart(3)}  ${s.rerank >= s.vec ? '+' : ''}${s.rerank - s.vec}`);
}
console.log(`\n明细写到 bench-hmb/out/rerank_${TAG}.json`);
