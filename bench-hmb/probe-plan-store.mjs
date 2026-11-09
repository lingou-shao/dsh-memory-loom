/**
 * 派生层里到底有没有计划那一行（§64）。
 *
 * `probe-plan-layers.mjs` 量到 P16 的派生层与金标轮三元组重合 1.00、P17 是 0.90，
 * 但检索面都给不出指针。这里直接 dump 三张表里与金标相关的行，看「计划区取
 * 指针」这条通道有没有东西可取——§61 的界线通道就是同一个形态。
 *
 *   node bench-hmb/probe-plan-store.mjs
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
  ['P16-CASE-added-future_plan/d15', /演出|票|准备|下个月/u],
  ['P17-CASE-017/d45', /搬|红谷滩|七月|一室一厅/u],
  ['P12-NEW-005/d45', /灯箱|报价|师傅/u]
];

for (const [qid, pattern] of CASES) {
  const exam = exams.find((one) => one.id === qid);
  if (exam === undefined) continue;
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  const dbPath = path.join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  Date.now = realNow;
  const db = new DatabaseSync(dbPath);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  console.log(`\n[${qid}] 轮≤${exam.cutoff_turn}  表：${tables.join(' ')}`);
  for (const table of ['plans', 'preferences', 'facts']) {
    if (!tables.includes(table)) continue;
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const hit = rows.filter((row) => pattern.test(Object.values(row).filter((one) => typeof one === 'string').join(' ')));
    console.log(`  ${table}：共 ${rows.length} 行，命中 ${hit.length} 行；列 ${columns.join(',')}`);
    for (const row of hit.slice(0, 6)) {
      console.log(`     id=${row.id} kind=${row.kind} tags=${row.tags} status=${row.status} ttl=${row.ttl} resolved=${row.resolved_at}\n       text=${String(row.text).slice(0, 80)}\n       aliases=${String(row.aliases ?? '').slice(0, 160)}\n       src=${row.source_l0 ?? row.source_ids ?? ''}`);
    }
  }
  db.close();
  loom.dispose?.();
}
