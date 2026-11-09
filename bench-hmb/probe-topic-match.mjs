/**
 * `searchL0` 的短语匹配能不能用（§63 排障）。
 *
 * `topicAnchor` 拼的是 `"灯箱"` 这种**短语**表达式，而 `compileLooseMatch` 拼的是
 * `试读 OR 读会`。两者在同一个 FTS 表上行为可能不同——这个探针直接问产品同一个
 * 问题两次：整句、以及话题词本身。
 *
 *   node bench-hmb/probe-topic-match.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const exam = exams.find((one) => one.id.startsWith('P12-NEW-005/'));
const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));

const realNow = Date.now;
let clock = Date.parse(turns[0]['逻辑时间']);
Date.now = () => clock;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmatch-'));
const loom = createLoom({ dbPath: path.join(dir, 'loom.db'), config: { consolidation: { triggerTokens: 0 } } });
for (const turn of turns) {
  if (turn['轮次'] > exam.cutoff_turn) break;
  clock = Date.parse(turn['逻辑时间']);
  await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
}
Date.now = realNow;

for (const query of ['灯箱', '报价', exam.question]) {
  const out = String(await loom.call('memory_search', { query, limit: 10 }, 'x'));
  const refs = [...new Set([...out.matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
  console.log(`\nQ: ${query.replace(/\n/gu, ' | ')}`);
  console.log(`  refs=${refs.join(',') || '（空）'}`);
  console.log(`  ${out.split('\n').slice(0, 4).join('\n  ')}`);
}
