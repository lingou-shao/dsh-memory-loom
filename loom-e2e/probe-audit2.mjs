/**
 * 审计探针 2：配置项是否真的生效、检索转义、本地化。
 * 针对「文档宣传了什么」与「代码实际做了什么」的偏差。
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SESSION = 'probe2';

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const info = (label, detail) => console.log(`  ..   ${label} — ${detail}`);

const fresh = (name) => {
  const db = `${HERE}tmp-a2-${name}.db`;
  for (const s of ['', '-wal', '-shm']) rmSync(`${db}${s}`, { force: true });
  return db;
};
const rows = (db, sql) => {
  const conn = new DatabaseSync(db, { readOnly: true });
  const r = conn.prepare(sql).all();
  conn.close();
  return r;
};
const count = (db, sql) => {
  const conn = new DatabaseSync(db, { readOnly: true });
  const n = Number(conn.prepare(sql).get().n);
  conn.close();
  return n;
};

const TALK = [
  ['我最近一直在想辞职的事，今天又加班到十点。', '你怕的不是没钱，是怕证明不了自己。'],
  ['存款能撑十一个月，可我还是不敢跟她直说。', '那结论不是要不要辞，是怎么开口。'],
  ['我想先去学一门手艺，再决定走不走。', '先算清十一个月能覆盖哪些成本。']
];

/* ── 1. consolidation.enabled = false 是否真的关掉整合 ─────── */
console.log('\n[1] consolidation.enabled 开关');
{
  const on = fresh('on');
  const a = createLoom({ dbPath: on, config: { consolidation: { triggerTokens: 1 } } });
  for (const [u, s] of TALK) await a.turn(SESSION, u, s);
  await a.settle(10);
  const factsOn = count(on, 'SELECT COUNT(*) AS n FROM facts');
  const eventsOn = count(on, 'SELECT COUNT(*) AS n FROM events');
  a.dispose();

  const off = fresh('off');
  const b = createLoom({ dbPath: off, config: { consolidation: { triggerTokens: 1, enabled: false } } });
  for (const [u, s] of TALK) await b.turn(SESSION, u, s);
  await b.settle(10);
  const factsOff = count(off, 'SELECT COUNT(*) AS n FROM facts');
  const eventsOff = count(off, 'SELECT COUNT(*) AS n FROM events');
  b.dispose();

  info('enabled=true 时 facts / events', `${factsOn} / ${eventsOn}`);
  info('enabled=false 时 facts / events', `${factsOff} / ${eventsOff}`);
  check('对照组 enabled=true 确实整合了', eventsOn > 0, `${eventsOn} 个事件`);
  check('enabled=false 完全不整合', eventsOff === 0 && factsOff === 0,
    `关掉后仍有 ${factsOff} 条事实、${eventsOff} 个事件`);
}

/* ── 2. memory_index search 的 LIKE 转义 ──────────────────── */
console.log('\n[2] search 通配符转义');
{
  const db = fresh('like');
  const loom = createLoom({ dbPath: db, config: { consolidation: { triggerTokens: 1 } } });
  for (const [u, s] of TALK) await loom.turn(SESSION, u, s);
  await loom.settle(10);

  const pct = await loom.call('memory_index', { action: 'search', query: '%' }, SESSION);
  const pctLines = pct.split('\n').filter((l) => /[EFD]\d+/u.test(l)).length;
  check('搜 % 不会命中全部钩子', pctLines <= 3, `命中 ${pctLines} 行 → ${pct.slice(0, 60)}`);

  const under = await loom.call('memory_index', { action: 'search', query: '_' }, SESSION);
  check('搜 _ 不会崩', typeof under === 'string', under.slice(0, 50));

  const quote = await loom.call('memory_index', { action: 'search', query: "'; DROP TABLE facts; --" }, SESSION);
  check('搜注入串不会崩且表还在', typeof quote === 'string' && count(db, 'SELECT COUNT(*) AS n FROM facts') >= 0, quote.slice(0, 50));
  loom.dispose();
}

/* ── 3. ownerName 是否被消费 ──────────────────────────────── */
console.log('\n[3] ownerName');
{
  const db = fresh('owner');
  const loom = createLoom({ dbPath: db, config: { ownerName: '阿邵' } });
  await loom.turn(SESSION, '你好', '你好');
  const owner = rows(db, "SELECT name FROM identities WHERE role = 'master'");
  const found = owner.some((r) => r.name === '阿邵');
  info('master 身份名', owner.map((r) => r.name).join(',') || '(无)');
  check('ownerName 落到 master 身份上（抽取提示与关系印象会用它）', found,
    found ? '已消费' : '未被使用（配置项可能是死的）');
  loom.dispose();
}

/* ── 4. locale=en 是否真的切换文案 ────────────────────────── */
console.log('\n[4] locale=en');
{
  const db = fresh('en');
  const loom = createLoom({ dbPath: db, config: { locale: 'en' } });
  await loom.turn(SESSION, 'hello', 'hi');
  const proto = loom.protocol();
  check('协议文本切成英文', /Memory index protocol|^\[/mu.test(proto) || proto.startsWith('Memory'), proto.slice(0, 50).replace(/\n/gu, ' '));
  loom.dispose();
}

console.log(fails === 0 ? '\n探针 2：全部通过' : `\n探针 2：${fails} 项异常`);
for (const n of ['on', 'off', 'like', 'owner', 'en']) {
  for (const s of ['', '-wal', '-shm']) rmSync(`${HERE}tmp-a2-${n}.db${s}`, { force: true });
}
process.exit(fails === 0 ? 0 : 1);
