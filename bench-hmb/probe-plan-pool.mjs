/**
 * 计划考点 8 个未覆盖时点的第四层：目标轮到底在不在候选池里（§64）。
 *
 * `probe-plan-layers.mjs` 已量到 L1（l0 有那一轮）与 L2（派生层抽到了）都不缺，
 * 断在 L3（搜索没给指针）。这里回答最后一个问题：是池里没有，还是池里有、
 * 挑选没给它——两种修法完全不同，不能再靠猜。
 *
 *   node bench-hmb/probe-plan-pool.mjs
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
  ['P12-NEW-005/d45', [183], ['灯箱', '报价']],
  ['P16-CASE-added-future_plan/d15', [269], ['演出', '准备', '票']],
  ['P17-CASE-017/d00', [196, 222], ['搬', '七月四号', '红谷滩']],
  ['P17-CASE-017/d45', [196, 222], ['搬', '七月四号', '红谷滩']]
];

for (const [qid, wantTurns, probes] of CASES) {
  const exam = exams.find((one) => one.id === qid);
  if (exam === undefined) continue;
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool2-'));
  const dbPath = path.join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  Date.now = realNow;
  const db = new DatabaseSync(dbPath);
  const marks = [];
  for (const turnNo of wantTurns) {
    const rows = db.prepare('SELECT id FROM l0 WHERE turn = ?').all(turnNo);
    marks.push(...rows.map((row) => row.id));
  }
  console.log(`\n[${qid}] 轮≤${exam.cutoff_turn}  金标轮 ${wantTurns.join(',')}  → l0 id ${marks.join(',')}`);
  console.log(`  Q: ${String(exam.question).replace(/\n/gu, ' | ')}`);
  for (const probe of probes) {
    let hits = [];
    try {
      hits = db.prepare(`
        SELECT l.id, l.turn, l.role, substr(l.text, 1, 24) AS head
        FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid
        WHERE l0_fts MATCH ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 12
      `).all(`"${probe}"`);
    } catch {
      hits = [];
    }
    const rank = hits.findIndex((row) => marks.includes(row.id));
    console.log(`  词「${probe}」命中 ${hits.length}${hits.length === 12 ? '+' : ''} 行；金标轮${rank === -1 ? '不在前 12' : `排第 ${rank + 1}`}`);
    console.log(`      ${hits.slice(0, 6).map((row) => `t${row.turn}:${row.head.replace(/\n/gu, ' ')}`).join(' ‖ ')}`);
  }
  // 两个词 AND（模拟严格通道）
  if (probes.length >= 2) {
    try {
      const both = db.prepare(`
        SELECT l.id, l.turn FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid
        WHERE l0_fts MATCH ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 20
      `).all(`"${probes[0]}" AND "${probes[1]}"`);
      const rank = both.findIndex((row) => marks.includes(row.id));
      console.log(`  「${probes[0]}」AND「${probes[1]}」命中 ${both.length} 行；金标轮${rank === -1 ? '不在其中' : `排第 ${rank + 1}`}`);
    } catch (error) {
      console.log(`  AND 查询失败：${String(error?.message ?? error).slice(0, 60)}`);
    }
  }
  db.close();
  loom.dispose?.();
}
