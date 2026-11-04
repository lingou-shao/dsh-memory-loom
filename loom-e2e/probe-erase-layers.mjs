/**
 * 删除的完整性：erase 之后，事件摘要、偏好、日记、印象、人设覆写是不是也走了。
 *
 * 为什么值得一个探针：这几层没有 status 列。删除路径如果只覆盖 l0 和 facts，
 * 它们会静默留下，而 events.summary 就是原文的压缩句——`memory_expand` 仍能
 * 把「删掉的人说过的话」读回来。这不是性能问题，是承诺问题。
 *
 * 两条路径分开验：
 *   访客：erase 立即生效，六层一起清零；
 *   朋友：冷静期内各层还在（可撤销的前提），deadline 过后由维护扫掉。
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const DB = fileURLToPath(new URL('./tmp-erase.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

const SESSION = 's-master';
const NOW = Date.now();
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

const loom = createLoom({ dbPath: DB, config: { maintenanceIntervalSeconds: 10 } });

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 5000');
db.prepare('INSERT INTO identities (id, name, role, status, created_at, last_active_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('u-visitor', '访客甲', 'visitor', 'active', NOW, NOW, '{}');
db.prepare('INSERT INTO identities (id, name, role, status, created_at, last_active_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('u-friend', '朋友乙', 'friend', 'active', NOW, NOW, '{}');
for (const [session, identity] of [['s-visitor', 'u-visitor'], ['s-friend', 'u-friend']]) {
  db.prepare('INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
    .run(session, identity, 'Asia/Shanghai', NOW, NOW);
  db.prepare('INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone, consolidated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)')
    .run(session, identity, 0, 'user', `${identity} 的原话`, '', NOW, 'Asia/Shanghai');
  const fact = db.prepare(`INSERT INTO facts
    (identity_id, text, tokens, kind, source, base, stability, stability_max, last_access_at, created_at, updated_at)
    VALUES (?, ?, ?, 'fact', 'rule', 1, 1, 1, ?, ?, ?)`).run(identity, `${identity} 的原话`, '', NOW, NOW, NOW);
  db.prepare(`INSERT INTO events
    (identity_id, session_id, title, summary, tokens, domain, started_at, ended_at, turn_from, turn_to, salience, l0_from, l0_to, created_at)
    VALUES (?, ?, ?, ?, '', 'other', ?, ?, 0, 0, 0.5, 1, 1, ?)`)
    .run(identity, session, `${identity} 说过的话`, `${identity} 说过的话`, NOW, NOW, NOW);
  db.prepare('INSERT INTO preferences (identity_id, text, tokens, created_at) VALUES (?, ?, ?, ?)')
    .run(identity, `${identity} 的偏好`, '', NOW);
  db.prepare('INSERT INTO diary (identity_id, entry, day_key, created_at) VALUES (?, ?, ?, ?)')
    .run(identity, `${identity} 的日记`, '2026-11-04', NOW);
  db.prepare('INSERT INTO impressions (identity_id, text, confidence, observations, updated_at) VALUES (?, ?, 0.5, 1, ?)')
    .run(identity, `${identity} 的印象`, NOW);
  db.prepare('INSERT INTO persona_overlays (identity_id, zone, text, updated_at) VALUES (?, ?, ?, ?)')
    .run(identity, 'tone', `${identity} 的语气`, NOW);
  // 一条指向自己的边：删事实时不清边的话，这里会留下孤儿行
  db.prepare('INSERT INTO memory_edges (from_id, to_id, edge_type, created_at) VALUES (?, ?, ?, ?)')
    .run(Number(fact.lastInsertRowid), Number(fact.lastInsertRowid), 'CORROBORATES', NOW);
}
const count = (sql, ...args) => Number(db.prepare(sql).get(...args).n);

console.log('[1] 访客：erase 立即清全层');
await loom.call('memory_identity', { action: 'erase', identityId: 'u-visitor' }, SESSION);
for (const [label, sql] of [
  ['原始对话 l0', 'SELECT COUNT(*) AS n FROM l0 WHERE identity_id = ?'],
  ['事实 facts', 'SELECT COUNT(*) AS n FROM facts WHERE identity_id = ?'],
  ['事件 events', 'SELECT COUNT(*) AS n FROM events WHERE identity_id = ?'],
  ['偏好 preferences', 'SELECT COUNT(*) AS n FROM preferences WHERE identity_id = ?'],
  ['日记 diary', 'SELECT COUNT(*) AS n FROM diary WHERE identity_id = ?'],
  ['印象 impressions', 'SELECT COUNT(*) AS n FROM impressions WHERE identity_id = ?'],
  ['人设覆写 overlays', 'SELECT COUNT(*) AS n FROM persona_overlays WHERE identity_id = ?'],
]) {
  const left = count(sql, 'u-visitor');
  check(`${label} 清零`, left === 0, `还剩 ${left} 行`);
}
const orphans = count(`SELECT COUNT(*) AS n FROM memory_edges e
  WHERE NOT EXISTS (SELECT 1 FROM facts f WHERE f.id = e.from_id)`);
check('memory_edges 没有孤儿边', orphans === 0, `${orphans} 条边指向已删事实`);

console.log('\n[2] 朋友：冷静期内保留，deadline 过后由维护扫掉');
await loom.call('memory_identity', { action: 'erase', identityId: 'u-friend' }, SESSION);
const kept = count('SELECT COUNT(*) AS n FROM events WHERE identity_id = ?', 'u-friend');
check('冷静期内事件仍在（可撤销的前提）', kept === 1, `events=${kept}`);
const stamped = count(`SELECT COUNT(*) AS n FROM identities
  WHERE id = 'u-friend' AND json_extract(metadata, '$.deletionDeadline') IS NOT NULL`);
check('deadline 已记在身份上', stamped === 1);

db.prepare(`UPDATE identities SET metadata = json_set(metadata, '$.deletionDeadline', ?) WHERE id = 'u-friend'`)
  .run(NOW - 1000);
db.close();

console.log('  …等一次维护（10s）');
await new Promise((resolve) => setTimeout(resolve, 10500));
const after = new DatabaseSync(DB, { readOnly: true });
const n = (sql) => Number(after.prepare(sql).get().n);
for (const [label, sql] of [
  ['事件 events', 'SELECT COUNT(*) AS n FROM events WHERE identity_id = ?'],
  ['偏好 preferences', 'SELECT COUNT(*) AS n FROM preferences WHERE identity_id = ?'],
  ['日记 diary', 'SELECT COUNT(*) AS n FROM diary WHERE identity_id = ?'],
  ['印象 impressions', 'SELECT COUNT(*) AS n FROM impressions WHERE identity_id = ?'],
]) {
  const left = n(sql);
  check(`${label} 到期后清零`, left === 0, `还剩 ${left} 行`);
}
const cleared = Number(after.prepare(`SELECT COUNT(*) AS n FROM identities
  WHERE id = 'u-friend' AND json_extract(metadata, '$.deletionDeadline') IS NULL`).get().n);
check('deadline 标记已清除（不会重复扫）', cleared === 1);
after.close();

loom.dispose();
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
