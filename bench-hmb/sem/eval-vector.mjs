// 离线语义检索实验：只用 loom 库里已有的单元，不改产品代码。
//
// 判分口径与 bench-hmb/eval-compare.py 逐字一致（同一份 keys.json、同一个 cid
// 证据判据），所以这里的数字可以直接和 retrieval_loom-epB.json 对照。
//
//   node bench-hmb/sem/eval-vector.mjs [--k 6] [--tag base] [--model Xenova/bge-base-zh-v1.5]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'bench-hmb/sem/models';
env.useBrowserCache = false;

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const K = Number(argOf('k', 6));
const TAG = argOf('tag', 'base');
const MODEL = argOf('model', 'Xenova/bge-small-zh-v1.5');
// bge-zh 官方推荐的检索指令前缀，只加在 query 侧，passage 侧不加。
const PREFIX = argOf('prefix', '');
const DIR = 'bench-hmb/out/sem';
const units = JSON.parse(await readFile(join(DIR, 'units.json'), 'utf8'));
const questions = JSON.parse(await readFile(join(DIR, 'questions.json'), 'utf8'));
const baseline = JSON.parse(await readFile('bench-hmb/out/retrieval_loom-epB.json', 'utf8'));
const baseRows = new Map(baseline.rows.map((r) => [r.qid, r]));

const extractor = await pipeline('feature-extraction', MODEL, { dtype: 'q8' });

const embed = async (texts) => {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const res = await extractor(batch, { pooling: 'cls', normalize: true });
    out.push(...res.tolist());
  }
  return out;
};

const t0 = Date.now();
const unitVecs = await embed(units.map((u) => u.text));
const queryVecs = await embed(questions.map((q) => PREFIX + q.question));
const embedMs = Date.now() - t0;

const hitsOf = (vec) => {
  const scored = [];
  for (let i = 0; i < unitVecs.length; i++) {
    let dot = 0;
    const a = unitVecs[i];
    for (let d = 0; d < a.length; d++) dot += a[d] * vec[d];
    scored.push([i, dot]);
  }
  scored.sort((x, y) => y[1] - x[1]);
  return scored.slice(0, K).map(([i, s]) => ({ ...units[i], score: Number(s.toFixed(4)) }));
};

const rows = [];
for (let qi = 0; qi < questions.length; qi++) {
  const q = questions[qi];
  const hits = hitsOf(queryVecs[qi]);
  const base = baseRows.get(q.qid);
  rows.push({
    qid: q.qid, type: q.type, need: q.need, all_needed: q.all_needed,
    vec: hits.map((h) => ({ cid: h.cid, ref: h.ref, score: h.score })),
    rawEmpty: (base?.raw?.length ?? 0) === 0,
    rawHit: base ? judge(q, new Set(base.raw.map((h) => h.cid))) : false,
    kwHit: base ? judge(q, new Set(base.kw.map((h) => h.cid))) : false,
  });
}

function judge(q, cids) {
  if (q.need.length === 0) return false;
  return q.all_needed ? q.need.every((n) => cids.has(n)) : q.need.some((n) => cids.has(n));
}

const vecHit = rows.filter((r) => judge(r, new Set(r.vec.map((h) => h.cid))));
const total = rows.length;
const emptyRows = rows.filter((r) => r.rawEmpty);

const summary = {
  tag: TAG, k: K, model: MODEL, prefix: PREFIX, dims: unitVecs[0].length, total, embedMs,
  vecHit: vecHit.length,
  vecRate: +(vecHit.length / total * 100).toFixed(1),
  rawHit: rows.filter((r) => r.rawHit).length,
  kwHit: rows.filter((r) => r.kwHit).length,
  empty: emptyRows.length,
  emptyVecHit: emptyRows.filter((r) => judge(r, new Set(r.vec.map((h) => h.cid)))).length,
  emptyKwHit: emptyRows.filter((r) => r.kwHit).length,
  kept: rows.filter((r) => r.rawHit && judge(r, new Set(r.vec.map((h) => h.cid)))).length,
};
sumRaw(summary, rows);

function sumRaw(s, rs) {
  const byType = {};
  for (const r of rs) {
    byType[r.type] ??= { n: 0, vec: 0, raw: 0, kw: 0, emptyN: 0, emptyVec: 0 };
    const t = byType[r.type];
    t.n++;
    const cids = new Set(r.vec.map((h) => h.cid));
    if (judge(r, cids)) t.vec++;
    if (r.rawHit) t.raw++;
    if (r.kwHit) t.kw++;
    if (r.rawEmpty) { t.emptyN++; if (judge(r, cids)) t.emptyVec++; }
  }
  s.byType = byType;
}

await mkdir('bench-hmb/out', { recursive: true });
await writeFile(`bench-hmb/out/vector_${TAG}.json`, JSON.stringify({ summary, rows }, null, 1), 'utf8');

console.log(`\n问法＝题面整句，k=${K}，单元 ${units.length} 条，题目 ${total} 道`);
console.log(`模型 ${MODEL}（${summary.dims} 维）`);
console.log(`嵌入耗时 ${(embedMs / 1000).toFixed(1)}s（${units.length + questions.length} 段）\n`);
console.log('臂'.padEnd(16), '命中/题数'.padStart(12), '  覆盖率');
console.log('词法 raw'.padEnd(16), `${summary.rawHit}/${total}`.padStart(12), `  ${(summary.rawHit / total * 100).toFixed(1)}%`);
console.log('词法 kw（对照）'.padEnd(16), `${summary.kwHit}/${total}`.padStart(12), `  ${(summary.kwHit / total * 100).toFixed(1)}%`);
console.log('向量 top-k'.padEnd(16), `${summary.vecHit}/${total}`.padStart(12), `  ${summary.vecRate}%`);
console.log(`\n【关键】raw 材料为空的 ${summary.empty} 道题：`);
console.log(`  向量补回 ${summary.emptyVecHit} 道（${(summary.emptyVecHit / summary.empty * 100).toFixed(1)}%）`);
console.log(`  kw 问法能补 ${summary.emptyKwHit} 道（${(summary.emptyKwHit / summary.empty * 100).toFixed(1)}%）← 这是上一轮算的天花板`);
console.log(`  raw 原本命中的 ${summary.rawHit} 道里，向量仍命中 ${summary.kept} 道（掉 ${summary.rawHit - summary.kept}）`);
console.log('\n按类型：');
for (const [t, s] of Object.entries(summary.byType)) {
  console.log(`  ${t.padEnd(6)} n=${String(s.n).padStart(3)}  向量 ${String(s.vec).padStart(3)}  词法raw ${String(s.raw).padStart(3)}  词法kw ${String(s.kw).padStart(3)}  ｜空材料 ${String(s.emptyN).padStart(3)} → 向量补 ${String(s.emptyVec).padStart(3)}`);
}
console.log(`\n明细写到 bench-hmb/out/vector_${TAG}.json`);
