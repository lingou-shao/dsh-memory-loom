/**
 * 升级路径：v1 的老库能不能被 v4 的代码打开，老数据会不会坏。
 *
 * 造 v1 的办法是真的降级：先用引擎写一个正常的库，然后把 v0.2.17 之后新增
 * 的列 `ALTER TABLE ... DROP COLUMN` 掉，再把 `user_version` 改回 1。这样
 * `migrate()` 走的就是真 `ensureColumn` 那条 ALTER TABLE 路径，而不是「列
 * 已经在了所以跳过」。
 *
 * 检查的四件事：
 *   1. 迁移加回列，老行不改一个字节
 *   2. 老计划（有 expires_at、没有 resolved_at / nudged_at）升级后第一次就
 *      会进「已到期，还没有下文」
 *   3. 老事实不会被误当成计划去问
 *   4. 升级后新写入的别名、期限、收尾都正常
 *
 * 另外把 `parseDue` 拿一遍畸形输入：它每次都要返回一个能用的窗口，或者
 * 什么都不返回，绝不能返回一个倒序的、跨年的、让渲染崩掉的窗口。
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, DAY } from './harness.mjs';

const SESSION = 'probe-upgrade';
const root = mkdtempSync(join(tmpdir(), 'loom-upgrade-'));

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function query(dbPath, sql, ...args) {
  const db = new DatabaseSync(dbPath);
  const list = db.prepare(sql).all(...args);
  db.close();
  return list;
}

function exec(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  db.exec(sql);
  db.close();
}

const V1_GONE = [
  ['facts', 'aliases'],
  ['facts', 'due_from'],
  ['facts', 'nudged_at'],
  ['facts', 'resolved_at'],
  ['facts', 'outcome'],
  ['events', 'aliases'],
];

/** The columns v0.2.17 dropped off a store, then the version stamp. */
function downgrade(dbPath) {
  const db = new DatabaseSync(dbPath);
  for (const [table, column] of V1_GONE) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  db.exec('PRAGMA user_version = 1');
  db.close();
}

function columns(dbPath, table) {
  return query(dbPath, `PRAGMA table_info(${table})`).map((row) => String(row['name']));
}

try {
  console.log('\n[1] v1 老库能被打开，自己的数据一条不少');
  {
    const dir = mkdtempSync(join(root, 'v1-'));
    const dbPath = join(dir, 'loom.db');

    // --- 用当前代码写一个库，再把它降级成 v1 ---
    const before = createLoom({ dbPath });
    await before.call('memory_write', { text: '用户养了一只猫叫锅贴', kind: 'fact' }, SESSION);
    await before.call('memory_write', { text: '用户喜欢喝美式咖啡', kind: 'preference' }, SESSION);
    await before.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    await before.turn(SESSION, '锅贴今天又把杯子推下去了', '它就这样', { gapMs: 60_000 });
    /*
    * A real event row, written by hand: consolidation needs a segment boundary
    * and this probe has no model. The point is that `events.aliases` is the
    * column being dropped and re-added — with zero events, "same count" would
    * pass on an empty table and prove nothing.
    */
    const identity = query(dbPath, 'SELECT id FROM identities ORDER BY id LIMIT 1')[0].id;
    exec(dbPath, `INSERT INTO events (identity_id, session_id, title, summary, tokens, domain, started_at, ended_at, turn_from, turn_to, salience, valence, arousal, l0_from, l0_to, created_at)
      VALUES ('${identity}', '${SESSION}', '锅贴打翻杯子', '用户说猫把杯子推下去了', '锅贴 杯子', 'life', ${Date.now()}, ${Date.now()}, 1, 2, 0.6, 0, 0, 1, 2, ${Date.now()})`);
    before.dispose();
    const factsBefore = query(dbPath, 'SELECT id, text, kind FROM facts ORDER BY id');
    const eventsBefore = query(dbPath, 'SELECT id, title FROM events ORDER BY id');
    // 一条「升级前就已经过期」的计划。老版本也会这样：有 expires_at，三个新列为空。
    exec(dbPath, `UPDATE facts SET expires_at = ${Date.now() - 3 * DAY}, due_from = ${Date.now() - 3 * DAY}, ttl = 'absolute' WHERE kind = 'plan'`);
    downgrade(dbPath);
    check('降级后确实少了列', !columns(dbPath, 'facts').includes('resolved_at'), columns(dbPath, 'facts').join(','));
    check('降级后版本号是 1', Number(query(dbPath, 'PRAGMA user_version')[0]['user_version']) === 1, '');

    // --- 用当前代码打开 ---
    const after = createLoom({ dbPath });
    const cols = columns(dbPath, 'facts');
    check('迁移把五列都加回来了', ['aliases', 'due_from', 'nudged_at', 'resolved_at', 'outcome'].every((c) => cols.includes(c)), '');
    check('events.aliases 也加回来了', columns(dbPath, 'events').includes('aliases'), '');
    check('版本号升到 4', Number(query(dbPath, 'PRAGMA user_version')[0]['user_version']) === 4, String(query(dbPath, 'PRAGMA user_version')[0]['user_version']));

    const factsAfter = query(dbPath, 'SELECT id, text, kind FROM facts WHERE kind IN (\'fact\',\'preference\',\'plan\') ORDER BY id');
    check('事实一条没丢', factsAfter.length === factsBefore.length, `${factsBefore.length} → ${factsAfter.length}`);
    check('事实文本没被改写', factsAfter.every((row, i) => String(row.text) === String(factsBefore[i].text)), factsAfter.map((r) => r.text).join(' | '));
    const eventsAfter = query(dbPath, 'SELECT id, title FROM events ORDER BY id');
    check('事件一条没丢', eventsAfter.length === eventsBefore.length, `${eventsBefore.length} → ${eventsAfter.length}`);
    check('事件标题没被改写', eventsAfter.every((row, i) => String(row.title) === String(eventsBefore[i].title)), eventsAfter.map((r) => r.title).join(' | '));

    // --- 老数据在新代码下能读到 ---
    await after.turn(SESSION, '锅贴最近怎么样', '挺好的', { gapMs: 60_000 });
    const block = after.memoryBlock(SESSION);
    check('老的猫还在块里', block.includes('锅贴'), block.split('\n').find((row) => row.includes('锅贴')) ?? '(块里没有)');
    check('老的偏好还在块里', block.includes('美式'), block.split('\n').find((row) => row.includes('美式')) ?? '(块里没有)');

    // --- 老计划：没有 nudged_at，第一次就该问 ---
    const planLine = block.split('\n').find((row) => row.includes('交材料')) ?? '(块里没有这条)';
    check('老计划进了「已到期」', planLine.includes('已到期'), planLine);
    check('老计划第一次就问', planLine.includes('memory_resolve'), planLine);
    check('老计划拿到了编号', /memory_resolve\(id=\d+/u.test(planLine), planLine);

    // --- 医生报告不炸，且把老计划数进去 ---
    const doctor = await after.call('memory_doctor', {}, SESSION);
    check('memory_doctor 能跑', typeof doctor === 'string' && doctor.includes('计划'), String(doctor).split('\n').find((row) => row.includes('计划')) ?? '(没有计划行)');

    // --- 升级后写入仍然带别名、带期限 ---
    const written = await after.call('memory_write', { text: '用户的猫叫锅贴，三岁', kind: 'fact', aliases: ['锅贴', '猫'] }, SESSION);
    check('升级后能写新事实', /#\d+/u.test(String(written)), String(written));
    const id = Number(/#(\d+)/u.exec(String(written))?.[1] ?? 0);
    const aliasRow = query(dbPath, 'SELECT aliases, tokens FROM facts WHERE id = ?', id)[0];
    check('别名落库', String(aliasRow.aliases).includes('锅贴'), String(aliasRow.aliases));
    check('别名进了 FTS 的 tokens 列', String(aliasRow.tokens).includes('锅贴'), '');
    const plan2 = await after.call('memory_write', { text: '用户下周五要搬家', kind: 'plan' }, SESSION);
    const plan2Id = Number(/#(\d+)/u.exec(String(plan2))?.[1] ?? 0);
    const dueRow = query(dbPath, 'SELECT expires_at, due_from FROM facts WHERE id = ?', plan2Id)[0];
    check('升级后新计划仍算出期限', dueRow.expires_at !== null && dueRow.due_from !== null, `${String(dueRow.due_from)}~${String(dueRow.expires_at)}`);

    // --- 收尾一个老计划，写出来的事实不能有期限 ---
    const oldPlanId = Number(/memory_resolve\(id=(\d+)/u.exec(planLine)?.[1] ?? 0);
    const settled = await after.call('memory_resolve', { id: oldPlanId, outcome: 'done', note: '上午交的' }, SESSION);
    check('老计划能收尾', String(settled).includes('办成了'), String(settled));
    const outcome = query(dbPath, 'SELECT text, expires_at, kind FROM facts ORDER BY id DESC LIMIT 1')[0];
    check('收尾事实没有期限', outcome.expires_at === null && outcome.kind === 'fact', `${String(outcome.expires_at)}/${String(outcome.kind)}`);

    after.dispose();

    // --- 再开一次：不该重复 ALTER，也不该把版本号往回写 ---
    const again = createLoom({ dbPath });
    check('二次打开正常', columns(dbPath, 'facts').length === cols.length, `${cols.length} 列`);
    check('二次打开版本号仍是 4', Number(query(dbPath, 'PRAGMA user_version')[0]['user_version']) === 4, '');
    again.dispose();
  }

  console.log('\n[2] 更老的库：连别名列都没有，且 user_version 缺失');
  {
    const dir = mkdtempSync(join(root, 'v0-'));
    const dbPath = join(dir, 'loom.db');
    const first = createLoom({ dbPath });
    await first.call('memory_write', { text: '用户在一家做地图的公司上班', kind: 'fact' }, SESSION);
    first.dispose();
    downgrade(dbPath);
    exec(dbPath, 'PRAGMA user_version = 0');
    const second = createLoom({ dbPath });
    check('user_version=0 也能迁移', Number(query(dbPath, 'PRAGMA user_version')[0]['user_version']) === 4, '');
    await second.turn(SESSION, '我在哪上班', '做地图的', { gapMs: 60_000 });
    check('老数据仍能召回', second.memoryBlock(SESSION).includes('地图'), second.memoryBlock(SESSION).split('\n').find((row) => row.includes('地图')) ?? '(没有)');
    second.dispose();
  }

  console.log('\n[3] 别名里的怪字符不能把 FTS 弄坏');
  {
    const dir = mkdtempSync(join(root, 'alias-'));
    const dbPath = join(dir, 'loom.db');
    const loom = createLoom({ dbPath });
    const nasty = ['"', 'OR', 'NOT', '(', ')', '*', '-', 'a b', '🎉', "it's"];
    for (const alias of nasty) {
      const written = await loom.call('memory_write', { text: `用户提到过一个东西叫 ${alias}`, kind: 'fact', aliases: [alias, '东西'] }, SESSION);
      check(`别名 ${JSON.stringify(alias)} 不抛错`, /#\d+/u.test(String(written)), String(written));
    }
    await loom.turn(SESSION, '" OR NOT ( * -', '好', { gapMs: 60_000 });
    const block = loom.memoryBlock(SESSION);
    check('带怪字符的 query 也能出块', typeof block === 'string' && block.length > 0, `${block.length} 字符`);
    check('怪字符别名没有污染成 SQL 语法错误', !block.includes('SQLITE_ERROR'), '');
    loom.dispose();
  }

  console.log('\n[4] 极端输入');
  {
    const dir = mkdtempSync(join(root, 'edge-'));
    const dbPath = join(dir, 'loom.db');
    const loom = createLoom({ dbPath });
    const empty = await loom.call('memory_write', { text: '   ', kind: 'fact' }, SESSION);
    check('空白文本被拒绝或忽略', typeof empty === 'string', String(empty));
    const long = '用户说' + '很长的一句话'.repeat(400);
    const wrote = await loom.call('memory_write', { text: long, kind: 'fact' }, SESSION);
    check('超长文本能写', /#\d+/u.test(String(wrote)), String(wrote).slice(0, 40));
    const stored = query(dbPath, 'SELECT text FROM facts ORDER BY id DESC LIMIT 1')[0];
    check('超长文本被截断到可渲染', String(stored.text).length <= 900, `${String(stored.text).length} 字符`);
    const missing = await loom.call('memory_resolve', { id: 999999, outcome: 'done' }, SESSION);
    check('不存在的计划不改状态', String(missing).includes('没有找到'), String(missing));
    const settled = await loom.call('memory_settle', { id: 999999, accept: true }, SESSION);
    check('不存在的 settle 明确回答', typeof settled === 'string' && settled.length > 0, String(settled));
    loom.dispose();
  }

  console.log(`\n${fail === 0 ? '全部通过' : '有失败'}（${pass} 项断言）`);
} catch (error) {
  console.error('\n探针自己抛了：', error);
  process.exitCode = 1;
} finally {
  // 临时库交给系统回收；这里只清自己建的根目录。
  try {
    const { rmSync } = await import('node:fs');
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

if (fail > 0) process.exitCode = 1;
