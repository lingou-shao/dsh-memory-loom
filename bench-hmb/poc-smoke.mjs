/**
 * POC 冒烟：把 hive-memory-bench 的 chain 语料灌进 loom，看写入是否可控、
 * 检索吐出来的是不是原文片段、cid 能不能带出来。
 *
 * 只跑 30 段 + 3 题，目的是在写正式适配器之前先确认三件事：
 *   1. memory_write 对长段落的行为（800 字截断在哪里生效）；
 *   2. memory_search 的返回能否解析成 {text, id}；
 *   3. facts.tags 里存 cid 是否可行（adapter 要靠它回填 cid）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/keys/keys.json'), 'utf8'));

const dbPath = path.join(os.tmpdir(), `loom-poc-${Date.now()}.db`);
const loom = createLoom({ dbPath });
const SESSION = 'bench';

const t0 = Date.now();
const N = 30;
for (const seg of corpus.slice(0, N)) {
  const out = await loom.call('memory_write', {
    text: seg.text,
    kind: 'fact',
    pinned: true,
    tags: [seg.cid],
  }, SESSION);
  if (!out.startsWith('已记住')) console.log('write:', seg.cid, out.slice(0, 80));
}
const tWrite = Date.now() - t0;
console.log(`写入 ${N} 段耗时 ${tWrite}ms（${(tWrite / N).toFixed(0)}ms/段）`);

// 长段落检查：有多少段超过 800 字（writeFact 的 clip 上限）
const over = corpus.filter((s) => s.text.length > 800).length;
const lens = corpus.map((s) => s.text.length).sort((a, b) => a - b);
console.log(`段落长度 min=${lens[0]} p50=${lens[Math.floor(lens.length / 2)]} max=${lens[lens.length - 1]}，超 800 字的 ${over} 段`);

// 检索：挑 3 道现值题
const qs = keys.filter((k) => k.type === '现值').slice(0, 3);
for (const q of qs) {
  const out = await loom.call('memory_search', { query: q.question, limit: 6 }, SESSION);
  console.log('\n---', q.qid, '|', q.question);
  console.log(out.split('\n').slice(0, 4).join('\n').slice(0, 700));
}

// cid 能否从 tags 读回
const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT id, tags, length(text) AS n FROM facts ORDER BY id LIMIT 3').all();
console.log('\nfacts 前 3 行:', JSON.stringify(rows));
db.close();
loom.dispose();
console.log('\ndb:', dbPath);
