/**
 * 审计探针 3：驻留预算是否真的守住、挂载不存在编号会怎样。
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';
import { estimateTokens } from '../lib/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SESSION = 'probe3';

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const info = (label, detail) => console.log(`  ..   ${label} — ${detail}`);

const fresh = (name) => {
  const db = `${HERE}tmp-a3-${name}.db`;
  for (const s of ['', '-wal', '-shm']) rmSync(`${db}${s}`, { force: true });
  return db;
};
const rows = (db, sql, ...args) => {
  const conn = new DatabaseSync(db, { readOnly: true });
  const r = conn.prepare(sql).all(...args);
  conn.close();
  return r;
};

/* ── 1. 大量事件下，驻留块是否守住 budget 与条数 ───────────── */
console.log('\n[1] 驻留预算上限');
{
  const db = fresh('budget');
  const loom = createLoom({
    dbPath: db,
    config: { consolidation: { triggerTokens: 1 }, index: { maxHooks: 16, hooksBudgetTokens: 300 } }
  });
  // 造 40 段互不相同的事件，逼满候选池
  for (let i = 0; i < 40; i++) {
    await loom.turn(SESSION,
      `第 ${i} 个话题：编号${i}的独立事情，关于${['旅行', '工作', '健康', '家人', '学习'][i % 5]}的第 ${i} 次讨论，细节完全不同以免被折叠。`,
      `收到第 ${i} 条，这条的记录要点是 ${i} 号。`);
  }
  await loom.settle(20);
  await loom.call('memory_index', { action: 'rebuild' }, SESSION);
  const block = loom.indexBlock(SESSION);
  const tokens = estimateTokens(block);
  const lines = block.split('\n').filter((l) => /[EFDT]\d+/u.test(l)).length;
  const resident = rows(db, 'SELECT COUNT(*) AS n FROM loom_hooks WHERE resident = 1')[0].n;

  info('索引块 token', String(tokens));
  info('索引行数 / 驻留行数', `${lines} / ${resident}`);
  check('驻留块不超过 hooksBudgetTokens', tokens <= 300, `${tokens} token`);
  check('驻留条数不超过 maxHooks', Number(resident) <= 16, `${resident} 条`);
  check('索引块非空（真的有钩子）', lines > 0, `${lines} 行`);
  loom.dispose();
}

/* ── 2. memory_pack 挂到不存在的编号 ──────────────────────── */
console.log('\n[2] 挂载不存在的编号');
{
  const db = fresh('bogus');
  const loom = createLoom({ dbPath: db, config: { consolidation: { triggerTokens: 1 } } });
  await loom.turn(SESSION, '随便聊一句', '好');
  const packed = await loom.call('memory_pack', { title: '挂空编号', text: '正文内容随便写点什么。', ref: 'E9999' }, SESSION);
  info('pack(ref=E9999) 回执', packed.slice(0, 80));

  const links = rows(db, 'SELECT ref FROM loom_links');
  const bogus = links.filter((r) => r.ref === 'E9999').length;
  check('不会给不存在的编号建链接', bogus === 0, bogus === 0 ? '已拒绝/忽略' : `仍建了 ${bogus} 条指向 E9999 的链接`);

  const expand = await loom.call('memory_expand', { ref: 'E9999' }, SESSION);
  info('expand(E9999) 返回', expand.slice(0, 70));
  loom.dispose();
}

/* ── 3. 驻留快照跨轮次是否逐字一致（抗漂移不变式）────────── */
console.log('\n[3] 驻留快照稳定性');
{
  const db = fresh('stable');
  const loom = createLoom({ dbPath: db, config: { consolidation: { triggerTokens: 1 } } });
  for (let i = 0; i < 6; i++) await loom.turn(SESSION, `第 ${i} 件事，聊点不一样的：${'甲乙丙丁戊己'[i]}方案。`, `记下第 ${i} 件。`);
  await loom.settle(15);
  const a = loom.indexBlock(SESSION);
  await loom.settle(15);
  const b = loom.indexBlock(SESSION);
  check('两次渲染逐字一致', a === b, a === b ? `${a.length} 字相同` : '出现漂移');
  loom.dispose();
}

console.log(fails === 0 ? '\n探针 3：全部通过' : `\n探针 3：${fails} 项异常`);
for (const n of ['budget', 'bogus', 'stable']) {
  for (const s of ['', '-wal', '-shm']) rmSync(`${HERE}tmp-a3-${n}.db${s}`, { force: true });
}
process.exit(fails === 0 ? 0 : 1);
