/**
 * 话题锚点自检（§63）。
 *
 * 改的是 `topicAnchor` / `topicPhrase`：这里直接把这两个函数的结果打出来，确认
 * 「上次聊灯箱时」锚到的是 灯箱 而不是 上次。
 *
 *   node bench-hmb/probe-topic-anchor.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));

const CASES = [
  ['P12-NEW-005', '上次聊灯箱时，事情进行到哪一步了？'],
  ['P20-CASE-011', '那三次老迟前史后来讲完了吗？纽扣现在算什么，之前的说法还算数吗？'],
  ['P16-CASE-added-new_story', '我想接着编夜摊那段，伞面后来出现了啥？']
];

for (const [qid, question] of CASES) {
  const exam = exams.find((one) => one.id.startsWith(`${qid}/`));
  if (exam === undefined) continue;
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-'));
  const dbPath = path.join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  Date.now = realNow;

  console.log(`\n[${qid}] 轮≤${exam.cutoff_turn}`);
  console.log(`  Q: ${question}`);
  const anchor = loom.store.topicAnchor('master', question, 6);
  console.log(`  anchor = ${anchor === null ? '（无）' : `「${anchor.term}」 ${anchor.rows.length} 行 → ${anchor.rows.map((r) => `t${r.turn}${r.role === 'user' ? 'U' : 'A'}`).join(',')}`}`);
  if (anchor !== null) {
    const mention = anchor.rows.reduce((best, row) => row.createdAt >= best.createdAt ? row : best, anchor.rows[0]);
    const after = loom.store.turnsAfter('master', mention.sessionId, mention.turn, 8);
    console.log(`  mention = t${mention.turn}${mention.role === 'user' ? 'U' : 'A'}  「${String(mention.text).slice(0, 34)}」`);
    console.log(`  之后 ${after.length} 轮：${after.map((r) => `t${r.turn}:${String(r.text).slice(0, 16)}`).join(' | ')}`);
  }
  const out = String(await loom.call('memory_search', { query: question, limit: 10 }, 'x'));
  console.log(`  结果 refs = ${[...new Set([...out.matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))].join(',')}`);
}
