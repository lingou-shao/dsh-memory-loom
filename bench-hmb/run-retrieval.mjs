/**
 * 把 chain 轨语料灌进 loom，逐题检索，落盘 hits 供离线评估。
 *
 * 这一版刻意保持"最朴素接入"：一条语料段＝一条 fact，不做时间轴映射、
 * 不做 query 改写、不做多次检索合并。目的是先量出裸接入的地板在哪里。
 *
 * 用法：node bench-hmb/run-retrieval.mjs [--limit N] [--pinned]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const OUT = path.resolve('bench-hmb/out');
fs.mkdirSync(OUT, { recursive: true });

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : process.argv[i + 1];
};
const LIMIT = Number(arg('--limit', '0')) || Infinity;
const PINNED = process.argv.includes('--pinned');
const REUSE = process.argv.includes('--reuse');
const ALIASES = process.argv.includes('--aliases');
const TAG = arg('--tag', 'loom');

const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/keys/keys.json'), 'utf8'));

const dbPath = path.join(OUT, `loom-chain${TAG === 'loom' ? '' : `-${TAG}`}.db`);
const loom = createLoom({ dbPath });
const SESSION = 'bench';

/**
 * 语料段里能抽到的「主体」「属性」。写入时作为 aliases 挂上去，是插件自己的
 * 正当接口（工具说明：用户下次可能用来找这条记忆的 2-3 个说法）——不是给
 * 评测特调，真实使用里写记忆本来就该带。
 */
/*
 * 语料句式的两个洞：`A 的B首次确立为 V` 与 `A 的B调整为 V`。
 * 第一版把 `的` 后面的空格写死了，实际语料里 `的B` 是连着的，于是别名一条没抽到、
 * 两轮读数完全相同——这种"改了个配置但数字一模一样"的情况必须先怀疑自己没生效。
 */
const SUBJ_SLOT = /([^\s，。（）]+) 的([^\s，。（）]{1,8}?)(?:首次确立为|调整为)\s/g;
function aliasesOf(text) {
  const out = new Set();
  for (const m of text.matchAll(SUBJ_SLOT)) {
    for (const w of [m[1], m[2]]) {
      if (w.length >= 2 && w.length <= 6) out.add(w);
    }
  }
  return [...out].slice(0, 6);
}

// ── 写入 ────────────────────────────────────────────────────────────────
const t0 = Date.now();
let rejected = 0;
if (REUSE) {
  console.log('复用既有库，跳过写入');
} else {
  for (const seg of corpus) {
    const args = { text: seg.text, kind: 'fact', tags: [seg.cid] };
    if (PINNED) args.pinned = true;
    if (ALIASES) {
      const al = aliasesOf(seg.text);
      if (al.length > 0) args.aliases = al;
    }
    const out = await loom.call('memory_write', args, SESSION);
    if (!out.startsWith('已记住')) {
      rejected++;
      console.log(`  写入未记下: ${seg.cid} → ${out.slice(0, 60)}`);
    }
  }
}
const tIngest = Date.now() - t0;

const db = new DatabaseSync(dbPath, { readOnly: true });
const rowById = new Map(
  db.prepare('SELECT id, text, tags FROM facts WHERE status <> \'pending_delete\'').all()
    .map((r) => [r.id, r]),
);
db.close();

// ── 检索 ────────────────────────────────────────────────────────────────
// 变更问要多拿：运行器给 CHAIN_K=60，但 searchFor 把 limit 卡在 50。
const kOf = (q) => (q.type === '变更' ? 50 : 6);

/**
 * 两种问法，量的是两件事：
 *   raw —— 把题面整句丢进去，和 BM25 基线的输入完全一致，是**公平地板**；
 *   kw  —— 只给「主体 + 属性」，这是模型真会做的事（工具说明就写着"关键词"），
 *          量的是"如果查询提取得当，这套题拿得到多少材料"。
 */
const queriesOf = (q) => [
  ['raw', q.question],
  ['kw', `${q.subject} ${q.slot}`],
];

const rows = [];
const t1 = Date.now();
for (const q of keys.slice(0, LIMIT === Infinity ? undefined : LIMIT)) {
  const limit = kOf(q);
  const rec = { qid: q.qid, type: q.type, k: limit };
  for (const [mode, query] of queriesOf(q)) {
    const text = await loom.call('memory_search', { query, limit }, SESSION);
    const ids = [...text.matchAll(/\(#F(\d+)\)/g)].map((m) => Number(m[1]));
    rec[mode] = ids.map((id) => {
      const r = rowById.get(id);
      // tags 是逗号分隔的原样字符串，不是 JSON 数组（单值时连引号都没有）
      const cid = typeof r?.tags === 'string' ? r.tags.split(',')[0] : null;
      return { id, cid, chars: r?.text.length ?? 0 };
    });
  }
  rows.push(rec);
}
const tAsk = Date.now() - t1;

const report = {
  arm: TAG,
  db: dbPath,
  pinned: PINNED,
  n_ingested: corpus.length,
  rejected,
  ingest_ms: tIngest,
  retrieve_ms: tAsk,
  k_policy: { '变更': 50, default: 6 },
  rows,
};
fs.writeFileSync(path.join(OUT, `retrieval_${TAG}.json`), JSON.stringify(report, null, 1), 'utf8');

console.log(`写入 ${corpus.length} 段 ${tIngest}ms（${rejected} 段未记下）`);
console.log(`检索 ${rows.length} 题 ${tAsk}ms`);
console.log(`输出 ${path.join(OUT, `retrieval_${TAG}.json`)}`);
console.log(`db ${dbPath}`);
loom.dispose();
