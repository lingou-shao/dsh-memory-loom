/**
 * 验证「真实用法」链路：一个回合＝一段语料 → L0 原文 → 规则抽取成事实
 * （带 source_ids）→ 检索命中事实 → memory_expand 调回原文。
 *
 * 这一步不需要任何模型：`extractWithModel ?? extractWithRules` 在没有 llm
 * 服务时走规则路径，而规则路径同样经过 applyCandidate，同样写 source_ids。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/keys/keys.json'), 'utf8'));

const dbPath = path.join(os.tmpdir(), `loom-turn-${Date.now()}.db`);
// 评测是批量灌入，没有"聊满两万 token 再说"的余地：把触发阈值压到 0
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const SID = 'bench';

// 只灌 5 段，看清结构
for (const seg of corpus.slice(0, 5)) {
  await loom.turn(SID, seg.text, '收到。', { gapMs: 30 * 60000 });
}

const db = new DatabaseSync(dbPath, { readOnly: true });
console.log('l0 行数:', db.prepare('SELECT count(*) c FROM l0').get().c);
console.log('facts 行数:', db.prepare('SELECT count(*) c FROM facts').get().c);
console.log('events 行数:', db.prepare('SELECT count(*) c FROM events').get().c);
console.log('\n前 3 条 fact:');
for (const r of db.prepare('SELECT id, text, source_ids, status FROM facts ORDER BY id LIMIT 3').all()) {
  console.log(' ', r.id, '|', r.source_ids, '|', r.status, '|', String(r.text).slice(0, 70));
}

const q = keys.find((k) => k.type === '现值');
console.log('\n--- 检索:', q.question);
const out = await loom.call('memory_search', { query: `${q.subject} ${q.slot}`, limit: 6 }, SID);
console.log(out.split('\n').slice(0, 4).join('\n').slice(0, 500));

const m = /#([EF])(\d+)\)/.exec(out);
if (m) {
  const ref = `${m[1]}${m[2]}`;
  const body = await loom.call('memory_expand', { ref }, SID);
  console.log(`\n--- expand ${ref} 前 400 字:\n`, body.slice(0, 400));
}
db.close();
loom.dispose();
console.log('\ndb:', dbPath);
