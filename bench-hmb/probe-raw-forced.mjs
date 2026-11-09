/**
 * 「如果原话通道一定启动，这几条找得到吗」——§63 的取证探针。
 *
 * 背景：714 未覆盖的 71 条计分事实，`searchR10` 全部 < 0.4，也就是**搜索结果里
 * 从来没到过**，没有一条是「到了但两条指针没给」。所以问题在入口，不在预算。
 *
 * 这里只问一件事：把 `relaxBelow` 抬到上限（原话通道几乎无条件启动）之后，目标
 * 轮能不能进结果。能进 → 阈值问题；进不去 → 排序/查询表达问题。
 *
 * 灌一次库、复制成三份再开三个配置，避免同一段历史灌三遍。
 *
 *   node bench-hmb/probe-raw-forced.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));

const TARGETS = [
  ['P12-NEW-005', [183]],
  ['P17-CASE-017', [196, 222]],
  ['P20-CASE-021', [231]],
  ['P16-CASE-draft-d091-1', [254]],
  ['P20-CASE-004', [19]]
];

const CONFIGS = [
  ['默认', {}],
  ['强制原话', { relaxBelow: 30 }],
  ['强制+关原话', { rawSearch: false, relaxBelow: 30 }]
];

const realNow = Date.now;

for (const [qid, want] of TARGETS) {
  const exam = exams.find((one) => one.id.startsWith(`${qid}/`));
  if (exam === undefined) {
    console.log(`\n[${qid}] 题库里没有这道题`);
    continue;
  }
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praw-'));
  const seed = path.join(dir, 'seed.db');
  const loom = createLoom({ dbPath: seed, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  loom.close?.();
  clock = Math.max(clock, Date.parse(exam.now));

  console.log(`\n[${qid}] 轮≤${exam.cutoffTurn}  目标轮 ${want.join(',')}`);
  console.log(`  Q: ${exam.question.replace(/\n/gu, ' | ')}`);
  for (const [label, extra] of CONFIGS) {
    const copy = path.join(dir, `${label}.db`);
    fs.copyFileSync(seed, copy);
    const one = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 }, retrieval: extra } });
    const text = String(await one.call('memory_search', { query: exam.question, limit: 10 }, 'x'));
    one.close?.();
    const refs = [...new Set([...text.matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
    /*
     * 原话指针长这样 `#L120-124`，行号 ≈ 轮号 × 2（一轮 user+assistant 两行），
     * 所以判「目标轮在不在这个区间」时按轮号折半，留两行余量。
     */
    const hit = refs.some((ref) => {
      const span = /^L(\d+)-(\d+)$/u.exec(ref);
      return span !== null && want.some((n) => Number(span[1]) <= n * 2 + 4 && Number(span[2]) >= n * 2 - 4);
    });
    console.log(`  ${label.padEnd(10)} refs=${refs.slice(0, 6).join(',') || '（空）'}  含目标=${hit}`);
  }
  Date.now = realNow;
}
