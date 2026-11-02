/**
 * Deadlines belong to promises, and a promise that reached its date gets one
 * question.
 *
 * Three claims this probe exists to check:
 *   1. a fact that *happened* carries no deadline — 「今天我把车卖了」 must not
 *      read 「已到期」 tomorrow, and must not be decayed for "missing" a date
 *      it never had
 *   2. an overdue plan puts one ask in the block — not every turn, but not
 *      only once either: an unanswered plan comes back after `planNudgeDays`
 *      — and the ask carries the id to answer with
 *   3. all three endings are recorded: 办成 / 没办成 / 不做了 each write a new
 *      fact, and the plan stops being a live plan either way — with 不做了 kept
 *      apart from 没办成, because a decision is not a failure
 *
 * The clock is the harness's, advanced by `gapMs`, so "tomorrow" really is
 * tomorrow and the plan is really overdue when the next turn runs.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, createLoomWithTimers, DAY, MIN } from './harness.mjs';

const SESSION = 'probe-plan-outcome';
const root = mkdtempSync(join(tmpdir(), 'loom-outcome-'));

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

function boot(name, config = {}) {
  const dbPath = join(mkdtempSync(join(root, `${name}-`)), 'loom.db');
  return { loom: createLoom({ dbPath, config }), dbPath };
}

/**
 * Push a plan's window into the past instead of waiting for the calendar.
 *
 * The engine's clock is the real one; `gapMs` only moves the harness's turn
 * timestamps. Rewriting the row is what the probe actually needs: a plan whose
 * date has gone by.
 */
function rewindPlans(dbPath, days = 1) {
  const at = Date.now() - days * DAY;
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE facts SET expires_at = ?, due_from = ?, expired_at = ? WHERE kind = 'plan'").run(at, at, at);
  db.close();
}

/**
 * Backdate the last ask, so "two days later" need not be waited for.
 *
 * Same reason as `rewindPlans`: the engine's clock is real time, so the only
 * way to test an interval is to move the stamp it measures from.
 */
function ageAsk(dbPath, days) {
  const at = Date.now() - days * DAY;
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE facts SET nudged_at = ? WHERE kind = 'plan' AND resolved_at IS NULL").run(at);
  db.close();
}

/** Put a pending date proposal on a plan, the shape `reconcileDue` writes. */
function proposeDue(dbPath, id, from, to) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT evidence FROM facts WHERE id = ?').get(id);
  const evidence = { ...JSON.parse(String(row.evidence ?? '{}')) };
  evidence.pendingDue = { from, to, kind: 'relative', precision: 'week', phrase: '下下周', relation: 'shift', proposedAt: Date.now() };
  db.prepare('UPDATE facts SET evidence = ? WHERE id = ?').run(JSON.stringify(evidence), id);
  db.close();
}

function rows(dbPath, sql, ...args) {
  const db = new DatabaseSync(dbPath);
  const list = db.prepare(sql).all(...args);
  db.close();
  return list;
}

/** The newest row of one kind, so the probe need not know ids in advance. */
function newest(dbPath, kind) {
  const list = rows(dbPath, "SELECT * FROM facts WHERE kind = ? ORDER BY id DESC LIMIT 1", kind);
  return list[0] ?? {};
}

try {
  console.log('\n[1] 事实没有期限');
  {
    const { loom, dbPath } = boot('fact');
    await loom.call('memory_write', { text: '用户今天把车卖了', kind: 'fact' }, SESSION);
    await loom.call('memory_write', { text: '用户明天要去医院复查', kind: 'plan' }, SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: MIN });
    const block = loom.memoryBlock(SESSION);
    const factRow = newest(dbPath, 'fact');
    check('事实没拿到期限字段', factRow.expires_at === null && factRow.due_from === null, `expires_at=${String(factRow.expires_at)}`);
    check('事实行不显示「截止」', !/· 截止\][^\n]*车卖了/u.test(block), block.split('\n').find((row) => row.includes('车卖了')) ?? '(块里没有这条)');
    check('时间原话仍然留在 evidence 里', String(factRow.evidence).includes('今天'), String(factRow.evidence));
    const planRow = newest(dbPath, 'plan');
    check('计划仍然拿到期限', planRow.expires_at !== null, `expires_at=${String(planRow.expires_at)}`);
    check('计划行照旧标「截止」', block.includes('截止'), block.split('\n').find((row) => row.includes('医院')) ?? '(无)');
    loom.dispose();
  }

  console.log('\n[2] 过了期限，块里提一句');
  {
    const { loom, dbPath } = boot('nudge');
    await loom.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: MIN });
    const fresh = loom.memoryBlock(SESSION);
    check('还没到期时不问', !fresh.includes('后来成了吗'), fresh.split('\n').find((row) => row.includes('交材料')) ?? '(无)');
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    const late = loom.memoryBlock(SESSION);
    const line = late.split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('到期后问一句', line.includes('后来成了吗'), line);
    check('问的时候给出 id', /memory_resolve\(id=\d+/u.test(line), line);
    check('仍标着已到期', line.includes('已到期'), line);
    const asked = rows(dbPath, "SELECT nudged_at FROM facts WHERE kind = 'plan' ORDER BY id DESC LIMIT 1")[0];
    check('nudged_at 落库', asked.nudged_at !== null, String(asked.nudged_at));
    await loom.turn(SESSION, '今天先这样', '好', { gapMs: MIN });
    const again = loom.memoryBlock(SESSION);
    const line2 = again.split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('第二轮不再问', !line2.includes('后来成了吗'), line2);
    loom.dispose();
  }

  console.log('\n[2b] 没有回音，隔两天再问一次');
  {
    const { loom, dbPath } = boot('reask');
    await loom.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    const firstLine = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('到期后第一次问', firstLine.includes('后来成了吗'), firstLine);
    const firstAsk = Number(newest(dbPath, 'plan').nudged_at);

    await loom.turn(SESSION, '今天先这样', '好', { gapMs: MIN });
    const soon = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('不满两天不问', !soon.includes('后来成了吗'), soon);

    ageAsk(dbPath, 3);
    await loom.turn(SESSION, '最近怎么样', '还行', { gapMs: MIN });
    const again = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('超过两天再问一次', again.includes('后来成了吗'), again);
    const firstId = /memory_resolve\(id=(\d+)/u.exec(firstLine)?.[1];
    const againId = /memory_resolve\(id=(\d+)/u.exec(again)?.[1];
    check('问的还是同一条计划', firstId !== undefined && firstId === againId, `${String(firstId)} / ${String(againId)}`);
    const secondAsk = Number(newest(dbPath, 'plan').nudged_at);
    check('nudged_at 被刷新', secondAsk > firstAsk, `${String(firstAsk)} → ${String(secondAsk)}`);
    check('计划没有因此重复写一条', rows(dbPath, "SELECT COUNT(*) AS n FROM facts WHERE kind = 'plan'")[0].n === 1, '');

    await loom.turn(SESSION, '还是有点忙', '嗯', { gapMs: MIN });
    const steady = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('再下一轮又不问', !steady.includes('后来成了吗'), steady);
    check('没结果就一直留在计划区', steady.includes('交材料'), steady);
    loom.dispose();
  }

  console.log('\n[2c] planNudgeDays=0 恢复成只问一次');
  {
    const { loom, dbPath } = boot('once', { retrieval: { planNudgeDays: 0 } });
    await loom.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    check('先问一次', loom.memoryBlock(SESSION).includes('后来成了吗'), '');
    ageAsk(dbPath, 30);
    await loom.turn(SESSION, '今天先这样', '好', { gapMs: MIN });
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('关了重问就不再问', !line.includes('后来成了吗'), line);
    check('计划仍然留在计划区', line.includes('交材料'), line);
    loom.dispose();
  }

  console.log('\n[2d] 名额不够时，最久没问的先问');
  {
    const { loom, dbPath } = boot('rotate');
    await loom.call('memory_write', { text: '用户打算去交材料', kind: 'plan' }, SESSION);
    await loom.call('memory_write', { text: '用户打算去看房', kind: 'plan' }, SESSION);
    await loom.call('memory_write', { text: '用户打算去体检', kind: 'plan' }, SESSION);
    rewindPlans(dbPath, 1);
    // 最早那条十天前已经问过，另外两条从没问过。
    const oldest = rows(dbPath, "SELECT id FROM facts WHERE kind = 'plan' ORDER BY id ASC LIMIT 1")[0].id;
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE facts SET nudged_at = ? WHERE id = ?').run(Date.now() - 10 * DAY, oldest);
    db.close();

    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: MIN });
    const first = loom.memoryBlock(SESSION);
    check('两个名额先给从没问过的', !first.includes('交材料') && first.includes('看房') && first.includes('体检'), first.split('\n').filter((row) => row.includes('打算')).join(' | '));

    await loom.turn(SESSION, '今天先这样', '好', { gapMs: MIN });
    const second = loom.memoryBlock(SESSION);
    check('第二轮轮到十天前那条', second.includes('交材料') && second.includes('后来成了吗'), second.split('\n').filter((row) => row.includes('打算')).join(' | '));
    check('刚问过的这一轮不再问', (second.match(/后来成了吗/gu) ?? []).length === 1, String((second.match(/后来成了吗/gu) ?? []).length));

    await loom.turn(SESSION, '还是有点忙', '嗯', { gapMs: MIN });
    const third = loom.memoryBlock(SESSION);
    check('三条都刚问过，一轮不问任何一条', !third.includes('后来成了吗'), third.split('\n').filter((row) => row.includes('打算')).join(' | '));
    loom.dispose();
  }

  console.log('\n[3] 办成了 → 记成办成的事实');
  {
    const { loom, dbPath } = boot('done');
    await loom.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '';
    const id = Number(/memory_resolve\(id=(\d+)/u.exec(line)?.[1] ?? 0);
    check('拿到计划 id', id > 0, String(id));
    const said = await loom.call('memory_resolve', { id, outcome: 'done', note: '上午去交了' }, SESSION);
    check('工具回话是「办成了」', String(said).includes('办成了'), String(said));
    const outcome = newest(dbPath, 'fact');
    check('新事实写了结果', String(outcome.text).includes('已办成'), String(outcome.text));
    check('新事实带上用户原话', String(outcome.text).includes('上午去交了'), String(outcome.text));
    check('新事实本身没有期限', outcome.expires_at === null, String(outcome.expires_at));
    const plan = rows(dbPath, 'SELECT * FROM facts WHERE kind = ? ORDER BY id ASC LIMIT 1', 'plan')[0];
    check('计划被标成已收尾', plan.resolved_at !== null && plan.outcome === 'done', `${String(plan.resolved_at)}/${String(plan.outcome)}`);
    check('计划原文没被改写', String(plan.text) === '用户打算明天去交材料', String(plan.text));
    await loom.turn(SESSION, '那件事弄完了', '好', { gapMs: MIN });
    const after = loom.memoryBlock(SESSION);
    check('计划区不再出现这条', !/\S+ · 已到期.*交材料/u.test(after), after.split('\n').find((row) => row.includes('交材料')) ?? '(无)');
    const twice = await loom.call('memory_resolve', { id, outcome: 'missed' }, SESSION);
    check('收过尾的再调不重复写', String(twice).includes('之前已经收过尾了'), String(twice));
    /*
     * 第二次传的是 missed，但库里存的是 done。回话必须说库里那个 ——
     * 照着入参复述会让模型以为结局被改了，接着把它当成「没去」用。
     */
    check('重复调用报的是库里那个结局，不是这次传的', String(twice).includes('办成了') && !String(twice).includes('没办成'), String(twice));
    check('重复调用没多写一条事实', rows(dbPath, "SELECT id FROM facts WHERE kind = 'fact'").length === 1, String(rows(dbPath, "SELECT id FROM facts WHERE kind = 'fact'").length));
    loom.dispose();
  }

  console.log('\n[4] 没办成 → 也记成事实');
  {
    const { loom, dbPath } = boot('missed');
    await loom.call('memory_write', { text: '用户打算明天去看房', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('看房')) ?? '';
    const id = Number(/memory_resolve\(id=(\d+)/u.exec(line)?.[1] ?? 0);
    const said = await loom.call('memory_resolve', { id, outcome: 'missed' }, SESSION);
    check('工具回话是「没办成」', String(said).includes('没办成'), String(said));
    const outcome = newest(dbPath, 'fact');
    check('新事实写了没办成', String(outcome.text).includes('没办成'), String(outcome.text));
    const plan = rows(dbPath, 'SELECT * FROM facts WHERE kind = ? ORDER BY id ASC LIMIT 1', 'plan')[0];
    check('计划标成 missed', plan.outcome === 'missed', String(plan.outcome));
    check('计划区不再重复问', !/\S+ · 已到期.*看房/u.test(loom.memoryBlock(SESSION)), '');
    loom.dispose();
  }

  console.log('\n[4b] 不去了 → 第三种结局，不是「没办成」');
  {
    const { loom, dbPath } = boot('cancelled');
    await loom.call('memory_write', { text: '用户打算周五去看房', kind: 'plan' }, SESSION);
    const id = Number(newest(dbPath, 'plan').id);
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('看房')) ?? '';
    /*
     * 未到期的行只给两个结局：还没到日子，谈不上「没办成」。
     * 只给 done 的话，用户说「不去了」时模型只有「不调」和「记成没办成」两条路。
     */
    check('还没到期的行给的是「做了」和「不做了」两个结局', /outcome=done\|cancelled/u.test(line) && !line.includes('后来成了吗'), line);
    const said = await loom.call('memory_resolve', { id, outcome: 'cancelled' }, SESSION);
    check('工具回话是「已取消」', /已取消/u.test(String(said)) && !/没办成/u.test(String(said)), String(said));
    const outcome = newest(dbPath, 'fact');
    check('新事实写的是取消，不是没办成', String(outcome.text).includes('已取消') && !String(outcome.text).includes('没办成'), String(outcome.text));
    const plan = rows(dbPath, 'SELECT * FROM facts WHERE id = ?', id)[0];
    check('计划标成 cancelled', plan.resolved_at !== null && plan.outcome === 'cancelled', `${String(plan.resolved_at)}/${String(plan.outcome)}`);
    check('计划原文没被改写', String(plan.text) === '用户打算周五去看房', String(plan.text));
    await loom.turn(SESSION, '今天先这样', '好', { gapMs: MIN });
    const after = loom.memoryBlock(SESSION);
    check(
      '计划区不再出现它（留下的是不带期限的事实）',
      !after.split('\n').some((row) => row.includes('看房') && (row.includes('· 截止') || row.includes('已到期'))),
      after.split('\n').find((row) => row.includes('看房')) ?? '(无)',
    );
    const doctor = String(await loom.call('memory_doctor', {}, SESSION));
    check('医生把它算成已有结果，不算待确认', /1 条已有结果/u.test(doctor) && !/\d+ 条时间待确认/u.test(doctor), doctor.split('\n').find((row) => row.includes('计划与矛盾')) ?? '');
    /*
     * 块里靠「计划区不含已收尾」避免误读，搜索结果没有分区，只能靠这一句标记。
     * 不带标记的话，模型搜到「用户打算周五去看房」会当成还没去。
     */
    const found = String(await loom.call('memory_search', { query: '看房' }, SESSION));
    check('搜索结果里那条计划标着已取消', /用户打算周五去看房（已取消）/u.test(found), found.split('\n').find((row) => row.includes('看房')) ?? '(无)');
    /*
     * 改期工具也要报库里那个结局。它对一条取消的计划说「没办成」，
     * 就是把这次分开的两件事又并回去了。
     */
    const late = String(await loom.call('memory_settle', { id, accept: true }, SESSION));
    check('取消之后改期被挡下，且说的是「已取消」', /已经有结果了（已取消）/u.test(late), late);
    loom.dispose();
  }

  console.log('\n[4c] 过了日子还是可以取消');
  {
    const { loom, dbPath } = boot('cancelled-late');
    await loom.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '';
    check('催问那一行三个结局都给', /outcome=done\|missed\|cancelled/u.test(line), line);
    const id = Number(/memory_resolve\(id=(\d+)/u.exec(line)?.[1] ?? 0);
    const said = await loom.call('memory_resolve', { id, outcome: 'cancelled', note: '后来不去了' }, SESSION);
    check('过期了也能记成取消', /已取消/u.test(String(said)), String(said));
    const fact = newest(dbPath, 'fact');
    check('事实写的是取消，并带上用户原话', String(fact.text).includes('已取消') && String(fact.text).includes('后来不去了'), String(fact.text));
    check('计划区不再问它', !/· 已到期[^\n]*交材料/u.test(loom.memoryBlock(SESSION)), '');
    loom.dispose();
  }

  console.log('\n[4d] 收过尾的计划不再被标成过期');
  {
    /*
     * 维护是真实使用里那颗 60 秒的定时器。抓下来手动跑一次，跑的是同一段代码：
     * 一条已经收尾的计划，日子过后不该被打上 `expired_at` —— 打上之后
     * `scoreFact` 的 `expiryFactor` 会按天把它从检索里减半，最后 `factsDueForPurge`
     * 会把这条唯一记录删掉，而 `resolve()` 刻意不改写它就是为了留下这句原话。
     *
     * 同一格里放一条没结果的计划做对照：它必须照旧被打上，否则这条断言
     * 只是在测「维护没跑」。
     */
    const dbPath = join(mkdtempSync(join(root, 'expired-')), 'loom.db');
    const { loom, timers } = createLoomWithTimers({ dbPath, config: { consolidation: { enabled: false } } });
    await loom.call('memory_write', { text: '用户打算周五去看房', kind: 'plan' }, SESSION);
    await loom.call('memory_write', { text: '用户打算周五去交材料', kind: 'plan' }, SESSION);
    const idOf = (needle) => Number(rows(dbPath, "SELECT id FROM facts WHERE kind = 'plan' AND text LIKE ?", `%${needle}%`)[0].id);
    await loom.call('memory_resolve', { id: idOf('看房'), outcome: 'cancelled' }, SESSION);
    /*
     * 只把日期拨到过去，不碰 `expired_at` —— `rewindPlans` 会连这个字段一起写，
     * 而这一组要测的正是「维护会不会写它」。
     */
    const at = Date.now() - DAY;
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE facts SET expires_at = ?, due_from = ? WHERE kind = 'plan'").run(at, at);
    raw.close();
    check('维护定时器被抓住了', timers.length > 0, `${timers.length} 个`);
    await timers[0].callback();
    const closed = rows(dbPath, "SELECT * FROM facts WHERE kind = 'plan' AND text LIKE '%看房%'")[0];
    const open = rows(dbPath, "SELECT * FROM facts WHERE kind = 'plan' AND text LIKE '%交材料%'")[0];
    check('已经收尾的计划没被打上过期', closed.expired_at === null, `expired_at=${String(closed.expired_at)}`);
    check('同一轮里没结果的计划照旧打上（证明维护真的跑了）', open.expired_at !== null, `expired_at=${String(open.expired_at)}`);
    loom.dispose();
  }

  console.log('\n[5] 收尾只对计划有效');
  {
    const { loom } = boot('guard');
    const written = await loom.call('memory_write', { text: '用户养了一只猫叫锅贴', kind: 'fact' }, SESSION);
    const id = Number(/#(\d+)/u.exec(String(written))?.[1] ?? 0);
    const said = await loom.call('memory_resolve', { id, outcome: 'done' }, SESSION);
    check('事实拒绝收尾', String(said).includes('不是计划'), String(said));
    const missing = await loom.call('memory_resolve', { id: 999999, outcome: 'done' }, SESSION);
    check('不存在的 id 明说找不到', String(missing).includes('没有找到'), String(missing));
    const bogus = await loom.call('memory_resolve', { id, outcome: 'whatever' }, SESSION).then((text) => String(text), (error) => String(error));
    check('枚举之外的值在进引擎之前就被挡下', /结局只能|invalid|enum/u.test(bogus), bogus.split('\n')[0]);
    loom.dispose();
  }

  console.log('\n[5b] 改期提案与「成了吗」不打架');
  {
    const { loom, dbPath } = boot('pending');
    await loom.call('memory_write', { text: '用户打算下周去交材料', kind: 'plan' }, SESSION);
    const id = Number(newest(dbPath, 'plan').id);
    rewindPlans(dbPath);
    proposeDue(dbPath, id, Date.now() + 7 * DAY, Date.now() + 13 * DAY);

    await loom.turn(SESSION, '材料那事改到下周了', '好', { gapMs: MIN });
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '(无)';
    check('有改期提案时只问时间', line.includes('memory_settle') && !line.includes('memory_resolve'), line);
    check('改期提案照常显示', line.includes('时间待确认'), line);

    // 没有提案的计划仍然会问——`pendingDue` 缺失时是 undefined，不是 null。
    await loom.call('memory_write', { text: '用户打算明天去取快递', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '今天先这样', '好', { gapMs: MIN });
    const other = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('取快递')) ?? '(无)';
    check('没有提案的计划照常问', other.includes('memory_resolve'), other);

    // 收尾之后，改期提案不再被接受，日期也不动。
    const before = Number(newest(dbPath, 'plan').expires_at);
    const said = await loom.call('memory_resolve', { id, outcome: 'done' }, SESSION);
    check('先收尾', String(said).includes('办成了'), String(said));
    const settled = await loom.call('memory_settle', { id, accept: true }, SESSION);
    check('收尾后拒绝改期', String(settled).includes('已经有结果'), String(settled));
    const row = rows(dbPath, 'SELECT expires_at, resolved_at, outcome, evidence FROM facts WHERE id = ?', id)[0];
    check('收尾后日期没被改', Number(row.expires_at) === before, `${before} → ${String(row.expires_at)}`);
    check('收尾后提案被清掉', !String(row.evidence).includes('pendingDue'), String(row.evidence));
    check('收尾后结果落库', row.resolved_at !== null && row.outcome === 'done', `${String(row.resolved_at)}/${String(row.outcome)}`);

    const doctor = await loom.call('memory_doctor', {}, SESSION);
    check('doctor 不再把已收尾的算成待确认时间', !/\d+ 条时间待确认/u.test(String(doctor)), String(doctor).split('\n').find((row) => row.includes('时间')) ?? '(没有时间行)');
    loom.dispose();
  }

  console.log('\n[6] doctor 把结果数出来');
  {
    const { loom, dbPath } = boot('doctor');
    await loom.call('memory_write', { text: '用户打算明天去交材料', kind: 'plan' }, SESSION);
    rewindPlans(dbPath);
    await loom.turn(SESSION, '这两天有点忙', '嗯', { gapMs: 5 * DAY });
    const line = loom.memoryBlock(SESSION).split('\n').find((row) => row.includes('交材料')) ?? '';
    const id = Number(/memory_resolve\(id=(\d+)/u.exec(line)?.[1] ?? 0);
    await loom.call('memory_resolve', { id, outcome: 'done' }, SESSION);
    const report = String(await loom.call('memory_doctor', {}, SESSION));
    const row = report.split('\n').find((item) => item.includes('条计划')) ?? '(无)';
    check('报告里有「已有结果」', row.includes('已有结果'), row);
    check('报告里有「已到期」', row.includes('已到期'), row);
    loom.dispose();
  }
} catch (error) {
  fail++;
  console.log(`  FAIL 探针自身抛错 — ${String(error?.stack ?? error).split('\n')[0]}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 项断言）`);
  process.exitCode = fail === 0 ? 0 : 1;
}
