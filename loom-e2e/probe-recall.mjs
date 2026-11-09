/**
 * 闭环验证：掉出候选池的老事件，还能不能找回来。
 *
 * 造 400 个事件（候选池上限 300），E1 是最老的一条。
 * 检查三件事：
 *   1. E1 确实不在索引里（rebuild 的 LIMIT 把它挡在外面）
 *   2. events_fts 仍能按关键词命中它（memory_search 的通道）
 *   3. 拿到 E1 之后 memory_expand 仍能读出正文（body 不依赖 loom_hooks）
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { HookIndex, indexDefaults } from '../lib/index.js';

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
const FILE = fileURLToPath(new URL('./tmp-recall.db', import.meta.url));
for (const s of ['', '-wal', '-shm']) rmSync(`${FILE}${s}`, { force: true });

const db = new DatabaseSync(FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec(SCHEMA);
db.prepare('INSERT INTO identities (id, name, role, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)').run('master', '主人', 'master', NOW, NOW);
db.prepare('INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at) VALUES (?, ?, ?, ?, ?)').run('s1', 'master', 'Asia/Shanghai', NOW, NOW);

const insL0 = db.prepare('INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone, consolidated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)');
const insEv = db.prepare(`INSERT INTO events
  (identity_id, session_id, title, summary, tokens, domain, started_at, ended_at, turn_from, turn_to, salience, l0_from, l0_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const COUNT = 400;
db.exec('BEGIN');
for (let i = 1; i <= COUNT; i++) {
  const endedAt = NOW - (COUNT - i + 1) * 12 * 3600 * 1000;
  const isOld = i === 1;
  const body = isOld
    ? '那天在鲸鱼座观测站值班，凌晨三点看到一颗火流星，我记下了时间、方位和颜色。这段对话只有我一个人在场，没人可以作证。'
    : `第 ${i} 段工作记录：改了需求，跑了测试，交付了版本。`;
  const title = isOld ? '鲸鱼座观测站值班' : `工作记录 ${i}`;
  const tokens = isOld ? '鲸鱼 鱼座 观测 测站 值班 流星' : '工作 记录 需求 测试 版本';
  let first = 0; let last = 0;
  for (let t = 0; t < 4; t++) {
    const id = insL0.run('s1', 'master', i * 4 + t, t % 2 === 0 ? 'user' : 'assistant',
      t === 0 ? body + `（第${i}段）` : `收到，继续。`, '', endedAt + t * 1000, 'Asia/Shanghai').lastInsertRowid;
    if (t === 0) first = Number(id);
    last = Number(id);
  }
  insEv.run('master', 's1', title, title + '的摘要', tokens, 'work', endedAt, endedAt, i * 4, i * 4 + 3, isOld ? 0.9 : 0.5, first, last, endedAt);
}
db.exec('COMMIT');

const index = new HookIndex(db, { ...indexDefaults }, () => NOW);
const report = index.rebuild('master');
console.log(`\n库内事件 ${COUNT} 条，候选池 ${report.candidates} 条，驻留 ${report.resident} 条`);

const hook = db.prepare("SELECT ref FROM loom_hooks WHERE identity_id = 'master' AND ref = 'E1'").get();
console.log(`  ${hook === undefined ? 'ok  ' : 'FAIL'} E1 不在索引里（候选池外）${hook === undefined ? '' : ' — 竟然在'}`);

const fts = db.prepare(`
  SELECT e.id FROM events_fts JOIN events e ON e.id = events_fts.rowid
  WHERE events_fts MATCH ? AND e.identity_id = 'master' AND e.status = 'active'
  ORDER BY bm25(events_fts, 5.0, 1.0, 1.0) LIMIT 5`).all('鲸鱼');
console.log(`  ${fts.some((r) => r.id === 1) ? 'ok  ' : 'FAIL'} FTS5 仍能命中 E1 — 命中 ${fts.map((r) => 'E' + r.id).join(', ') || '无'}`);

const body = index.body('master', 'E1');
console.log(`  ${body.ok ? 'ok  ' : 'FAIL'} memory_expand("E1") 能读出正文 — ${body.ok ? body.chars + ' 字：' + body.text.slice(0, 24) + '…' : body.reason}`);

const hookCount = db.prepare("SELECT COUNT(*) AS n FROM loom_hooks WHERE identity_id = 'master'").get().n;
console.log(`  附：loom_hooks 共 ${hookCount} 行（= 候选池规模，search 只能搜到这里）`);
db.close();
for (const s of ['', '-wal', '-shm']) rmSync(`${FILE}${s}`, { force: true });
