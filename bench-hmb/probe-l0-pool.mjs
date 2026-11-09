/**
 * 原话池到底有多大（§63）。
 *
 * `probe-raw-forced.mjs` 量到：`rawSearch: false` 时结果为空、`relaxBelow` 拉到上限
 * 结果也不变，说明所有命中都来自原话通道，而它只吐两条。这里直接对同一个库跑
 * 几组手写 MATCH，分清「池子本来就只有两行」和「池子大、被挑剩两条」。
 *
 *   node bench-hmb/probe-l0-pool.mjs
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

const CASES = [
  ['P20-CASE-021', ['试读', '读会', '试读会', '第二次']],
  ['P17-CASE-013', ['刘莹', '刘颖', '表妹']],
  ['P12-NEW-005', ['灯箱', '报价', '师傅']]
];

for (const [qid, probes] of CASES) {
  const exam = exams.find((one) => one.id.startsWith(`${qid}/`));
  if (exam === undefined) continue;
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-'));
  const dbPath = path.join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  Date.now = realNow;

  const db = new DatabaseSync(dbPath);
  const total = db.prepare('SELECT count(*) AS n FROM l0').get().n;
  const ident = db.prepare('SELECT DISTINCT identity_id FROM l0').all().map((r) => r.identity_id);
  console.log(`\n[${qid}] 轮≤${exam.cutoff_turn}  l0 共 ${total} 行，identity=${ident.join(',')}`);
  console.log(`  Q: ${exam.question.replace(/\n/gu, ' | ')}`);
  for (const probe of probes) {
    let n = 0;
    try {
      n = db.prepare('SELECT count(*) AS n FROM l0_fts WHERE l0_fts MATCH ?').get(`"${probe}"`).n;
    } catch (error) {
      n = -1;
    }
    const rows = n === 0 ? [] : db.prepare(`
      SELECT l.turn, l.role, substr(l.text, 1, 26) AS head
      FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid
      WHERE l0_fts MATCH ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 5
    `).all(`"${probe}"`);
    console.log(`  「${probe}」命中 ${n} 行 ${rows.map((r) => `t${r.turn}${r.role === 'user' ? 'U' : 'A'}:${r.head.replace(/\n/gu, ' ')}`).join(' | ')}`);
  }
  const sample = db.prepare('SELECT tokens FROM l0 LIMIT 1').get();
  console.log(`  tokens 样例：${String(sample?.tokens ?? '').slice(0, 90)}`);
  db.close();
}
