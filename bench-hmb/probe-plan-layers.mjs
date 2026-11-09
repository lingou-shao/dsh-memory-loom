/**
 * 计划考点的 8 个未覆盖时点，缺在哪一层（§64）。
 *
 * 8 个 MISS 只压 3 个题号（`P12-NEW-005` 3 个时点、`P16-CASE-added-future_plan`
 * 1 个、`P17-CASE-017` 4 个）。按流水线四层逐条判定，避免又一次「凭形状猜」：
 *
 *   L1 写侧：金标那一轮的 l0 行在不在
 *   L2 抽取：派生层（facts/preferences）有没有对得上的行
 *   L3 召回：把问句扔进 `memory_search`，返回的指针区间盖不盖住金标轮
 *   L4 池内：金标轮在 l0 的 bm25 池里排第几（问句整句搜不到时，逐词看）
 *
 *   node bench-hmb/probe-plan-layers.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));
const answerKey = new Map(jsonl(path.join(DS, 'review-only', 'answer-key.jsonl')).map((row) => [row.id, row]));

const CASES = [
  ['P12-NEW-005/d45', 183],
  ['P16-CASE-added-future_plan/d15', 269],
  ['P17-CASE-017/d00', 196],
  ['P17-CASE-017/d45', 222]
];

const key = (text) => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
const grams = (text, n) => {
  const flat = key(text);
  const out = new Set();
  for (let i = 0; i + n <= flat.length; i++) out.add(flat.slice(i, i + n));
  return out;
};
const shared = (a, b, n) => {
  const left = grams(a, n);
  const right = grams(b, n);
  let hit = 0;
  for (const piece of left) if (right.has(piece)) hit++;
  return left.size === 0 ? 0 : hit / left.size;
};
const spans = (refs) => refs.map((ref) => {
  const matched = /^L(\d+)-(\d+)$/u.exec(ref);
  return matched === null ? null : [Number(matched[1]), Number(matched[2])];
}).filter(Boolean);

for (const [qid, wantTurn] of CASES) {
  const exam = exams.find((one) => one.id === qid);
  if (exam === undefined) {
    console.log(`\n[${qid}] 找不到题目`);
    continue;
  }
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  const dbPath = path.join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  clock = Math.max(clock, Date.parse(exam.now));
  const output = String(await loom.call('memory_search', { query: exam.question, limit: 10 }, 'x'));
  Date.now = realNow;

  const db = new DatabaseSync(dbPath);
  const turnRows = db.prepare("SELECT id, role, turn, text FROM l0 WHERE turn = ?").all(wantTurn);
  const rowOf = turnRows.find((row) => row.role === 'user') ?? turnRows[0];
  const lo = rowOf === undefined ? -1 : rowOf.id;
  const refs = [...new Set([...output.matchAll(/#(L\d+(?:-\d+)?)/gu)].map((one) => one[1]))];
  const covered = rowOf !== undefined && spans(refs).some(([a, b]) => a <= rowOf.id + 6 && b >= rowOf.id - 8)
    || (rowOf !== undefined && spans(refs).some(([a, b]) => a <= (wantTurn * 2) && b >= (wantTurn * 2 - 1)));

  const factRows = db.prepare('SELECT text, aliases FROM facts').all();
  let bestFact = 0;
  for (const fact of factRows) {
    bestFact = Math.max(bestFact, shared(rowOf?.text ?? '', `${fact.text} ${fact.aliases}`, 3));
  }

  console.log(`\n[${qid}] 轮≤${exam.cutoffTurn}  目标轮 t${wantTurn}`);
  console.log(`  Q: ${String(exam.question).replace(/\n/gu, ' | ')}`);
  console.log(`  L1 写侧   l0 有这一轮：${rowOf !== undefined ? `是（id ${rowOf.id}，${rowOf.text.length} 字）` : '否'}`);
  console.log(`  L2 抽取   派生层与这一轮三元组重合最高：${bestFact.toFixed(2)}`);
  console.log(`  L3 召回   指针 ${refs.join(', ') || '(无)'}  → 盖住金标轮：${covered ? '是' : '否'}`);
  // L4：逐词看池
  const terms = [...new Set(key(exam.question).match(/.{2}/gu) ?? [])].filter((term) => !/[的了是我你他她吗呢啊吧和与在就都也还]/.test(term));
  const pool = [];
  for (const term of terms.slice(0, 18)) {
    let n = 0;
    try {
      n = db.prepare('SELECT count(*) AS n FROM l0_fts WHERE l0_fts MATCH ?').get(`"${term}"`).n;
    } catch {
      n = -1;
    }
    pool.push(`${term}:${n}`);
  }
  console.log(`  L4 池内   问句二元组在 l0_fts 的命中行数：${pool.join(' ')}`);
  db.close();
  loom.dispose?.();
}
