/**
 * 上限探针：候选池与驻留集的真实代价。
 *
 * 三个问题，全部要数字不要感觉：
 *   1. rebuild 的成本随事件数怎么长（LIMIT 300 是保护还是瓶颈）
 *   2. 驻留 16 条实际吃多少 token，扩到 32 / 64 吃多少
 *   3. memory_expand 的取回成本是否随钩子数量变化（应当无关）
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { HookIndex, indexDefaults, estimateTokens } from '../lib/index.js';

const BUNDLE = fileURLToPath(new URL('../lib/index.js', import.meta.url));
const SOURCE = readFileSync(BUNDLE, 'utf8');
/*
 * `SCHEMA` 里有插值（`${FACTS_INDEX_DDL}`，v7 起索引单独成块，迁移要原样重建）。
 * 正则抠出来的是带占位符的原文，直接交给 SQLite 会报 `unrecognized token: "$"`，
 * 所以按名字把同名的模板常量也抠出来替换。
 */
const SCHEMA = /const SCHEMA = `([\s\S]*?)`;/.exec(SOURCE)[1].replace(/\$\{(\w+)\}/gu, (whole, name) => {
  const found = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(SOURCE);
  return found === null ? whole : found[1];
});

const NOW = Date.UTC(2026, 9, 29, 5, 0, 0);
const TURNS = 6;           // 每个事件的轮数
const CHARS = 150;         // 每轮字数
const TITLES = ['改需求', '调性能', '排错', '对账', '写方案', '面试复盘', '搬家', '体检'];

function build(count) {
  const file = fileURLToPath(new URL('./tmp-probe.db', import.meta.url));
  for (const s of ['', '-wal', '-shm']) rmSync(`${file}${s}`, { force: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  db.prepare('INSERT INTO identities (id, name, role, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
    .run('master', '主人', 'master', NOW, NOW);
  db.prepare('INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
    .run('s1', 'master', 'Asia/Shanghai', NOW, NOW);

  const insL0 = db.prepare('INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone, consolidated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
  const insEv = db.prepare(`INSERT INTO events
    (identity_id, session_id, title, summary, tokens, domain, started_at, ended_at, turn_from, turn_to, salience, l0_from, l0_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  db.exec('BEGIN');
  for (let i = 0; i < count; i++) {
    // 每 6 小时一个事件，越往后越新；三年前的也算进来，测最坏情况
    const endedAt = NOW - (count - i) * 6 * 3600 * 1000;
    let first = 0;
    let last = 0;
    for (let t = 0; t < TURNS; t++) {
      const text = `${TITLES[i % TITLES.length]}第${i}段第${t}轮：`.padEnd(12, '段') + 'x'.repeat(CHARS);
      const id = insL0.run('s1', 'master', i * TURNS + t, t % 2 === 0 ? 'user' : 'assistant', text, '', endedAt + t * 1000, 'Asia/Shanghai').lastInsertRowid;
      if (t === 0) first = Number(id);
      last = Number(id);
    }
    insEv.run('master', 's1', `${TITLES[i % TITLES.length]} ${i}`, '摘要'.repeat(30), '', 'work',
      endedAt, endedAt, i * TURNS, i * TURNS + TURNS - 1, 0.3 + (i % 7) * 0.1, first, last, endedAt);
  }
  db.exec('COMMIT');
  return db;
}

function bench(count, hooks, budget) {
  const db = build(count);
  const index = new HookIndex(db, {
    ...indexDefaults,
    maxHooks: hooks,
    hooksBudgetTokens: budget,
  }, () => NOW);
  index.rebuild('master');                     // 预热
  const t0 = performance.now();
  const report = index.rebuild('master');
  const ms = performance.now() - t0;
  const text = index.render('master');
  const blockTokens = estimateTokens(text);
  db.close();
  return { report, ms, blockTokens, lines: text.split('\n').length - 1 };
}

console.log('\n=== 事件规模 vs rebuild 成本（每事件 6 轮 × 150 字）===');
console.log('  事件数   候选池   驻留   索引块token   rebuild耗时');
for (const n of [100, 300, 1000, 3000]) {
  const { report, ms, blockTokens } = bench(n, 16, 300);
  console.log(`  ${String(n).padStart(6)}   ${String(report.candidates).padStart(6)}   ${String(report.resident).padStart(4)}   ${String(blockTokens).padStart(10)}   ${ms.toFixed(1).padStart(8)} ms`);
}

console.log('\n=== 驻留条数上限 vs 每轮固定成本（300 条事件库）===');
console.log('  maxHooks  预算   实际驻留   索引块token   100轮累计   相对16条');
const base = bench(300, 16, 300);
const baseTokens = base.blockTokens;
for (const [hooks, budget] of [[16, 300], [24, 500], [32, 700], [64, 1400], [128, 2800]]) {
  const r = bench(300, hooks, budget);
  console.log(`  ${String(hooks).padStart(8)}  ${String(budget).padStart(4)}   ${String(r.report.resident).padStart(8)}   ${String(r.blockTokens).padStart(10)}   ${String(r.blockTokens * 100).padStart(9)}   ${((r.blockTokens / baseTokens) * 100).toFixed(0).padStart(6)}%`);
}

console.log('\n=== 取回成本是否随钩子数量变化 ===');
console.log('  （memory_expand 走 body()：ref → 链接 → 正文，不读 loom_hooks 的规模）');
for (const hooks of [16, 64]) {
  const db = build(300);
  const index = new HookIndex(db, { ...indexDefaults, maxHooks: hooks, hooksBudgetTokens: hooks * 20 }, () => NOW);
  index.rebuild('master');
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) index.body('master', 'E1');
  const per = (performance.now() - t0) / 200;
  console.log(`  驻留上限 ${String(hooks).padStart(3)} 条 → 单次取回 ${per.toFixed(3)} ms（含 SQL + 拼正文）`);
  db.close();
}
rmSync(fileURLToPath(new URL('./tmp-probe.db', import.meta.url)), { force: true });
