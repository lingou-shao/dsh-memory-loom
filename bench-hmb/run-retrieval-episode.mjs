/**
 * 全量：走 episode 桥（回合 → 整合 → 检索 → 调回原文）跑 642 题检索。
 *
 * 与 run-retrieval.mjs 的区别只在接入方式：
 *   那边把语料段直存成 fact（测存储+检索）；
 *   这边按插件设计跑索引 + 正文分离（测的是它真正的用法）。
 *
 * 用法：node bench-hmb/run-retrieval-episode.mjs [--tag loom-ep]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const OUT = path.resolve('bench-hmb/out');
fs.mkdirSync(OUT, { recursive: true });

const arg = (n, d) => { const i = process.argv.indexOf(n); return i === -1 ? d : process.argv[i + 1]; };
const TAG = arg('--tag', 'loom-ep');
const REUSE = process.argv.includes('--reuse');

const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/keys/keys.json'), 'utf8'));

const db = path.join(OUT, `${TAG}.db`);
const proc = spawn('node', ['bench-hmb/loom_bridge_episode.mjs'], {
  env: { ...process.env, HMB_LOOM_DB: db },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buf = '';
const waiters = [];
proc.stdout.on('data', (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    waiters.shift()?.(JSON.parse(line));
  }
});
const rpc = (o) => new Promise((res) => {
  waiters.push(res);
  proc.stdin.write(`${JSON.stringify(o)}\n`);
});

let ingestMs = 0;
let ing = { n: 0, settled_slow: 0 };
if (!REUSE) {
  const t = Date.now();
  ing = await rpc({ op: 'ingest', mode: 'episode', chapters: corpus });
  ingestMs = Date.now() - t;
}
console.log(`写入 ${ing.n ?? 0} 段 ${ingestMs}ms（整合超时 ${ing.settled_slow ?? 0} 段）`);

const kOf = (q) => (q.type === '变更' ? 50 : 6);
const rows = [];
const t1 = Date.now();
for (const [i, q] of keys.entries()) {
  const k = kOf(q);
  const rec = { qid: q.qid, type: q.type, k };
  for (const [mode, query] of [['raw', q.question], ['kw', `${q.subject} ${q.slot}`]]) {
    const r = await rpc({ op: 'retrieve', query, k });
    rec[mode] = (r.hits ?? []).map((h) => ({ cid: h.cid, chars: h.text.length, ref: h.ref }));
  }
  rows.push(rec);
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${keys.length}（${((Date.now() - t1) / 1000).toFixed(0)}s）`);
}
const askMs = Date.now() - t1;

await rpc({ op: 'close' });
proc.kill();

fs.writeFileSync(path.join(OUT, `retrieval_${TAG}.json`), JSON.stringify({
  arm: TAG, n_ingested: corpus.length, mode: 'episode',
  ingest_ms: ingestMs, retrieve_ms: askMs, rows,
}, null, 1), 'utf8');
console.log(`检索 ${rows.length} 题 ${(askMs / 1000).toFixed(0)}s → ${path.join(OUT, `retrieval_${TAG}.json`)}`);
console.log('db:', db);
