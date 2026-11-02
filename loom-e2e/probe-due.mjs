/**
 * Deadlines as intervals, and changing one without asking.
 *
 * Three questions this probe exists to answer:
 *   1. does "下周" mean a week and "下周一" mean a day — resolved on a fixed
 *      calendar, so the answer does not depend on when the probe runs
 *   2. does 过几天 produce a window instead of a made-up date, and does
 *      过段时间 produce nothing at all
 *   3. when a later sentence changes a stored date, is it staged and asked
 *      instead of silently overwritten
 *
 * Part 1 pins the base timestamp to Monday 2026-11-02 10:00 Shanghai, which is
 * also the case the calendar arithmetic is easiest to get wrong by one day
 * ("下周一" on a Monday is seven days out, not zero).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DAY, createLoom, mockLlm } from './harness.mjs';
import { parseDue } from '../lib/index.js';

const SESSION = 'probe-due-session';
const root = mkdtempSync(join(tmpdir(), 'loom-due-'));
const TZ = 'Asia/Shanghai';
/** Monday 2026-11-02 10:00 in Shanghai. */
const BASE = Date.UTC(2026, 10, 2, 2, 0, 0);
/** Consolidate every turn, so the probe does not wait for a threshold. */
const EAGER = { consolidation: { triggerTokens: 1, idleMinutes: 0 } };

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

/**
 * A fake model that answers the two prompts consolidation sends.
 *
 * The extraction reply pins the plan text and its time phrase; the judge reply
 * says "this duplicates fact #1", which is exactly what a real model says when
 * someone re-states the same plan on a different day. The interesting part is
 * what the *code* does with that answer, not what the model says.
 */
function twoStep(firstText, secondText, ttl = {}) {
  let extractCalls = 0;
  const plan = (text, ttl) => JSON.stringify({
    title: '计划',
    summary: text,
    emotion: { valence: 0, arousal: 0, salience: 0.5 },
    impression: null,
    diary: null,
    facts: [{ text, kind: 'plan', ttl, confidence: 0.9, aliases: [] }],
  });
  return mockLlm((request) => {
    const system = String(request.system ?? '');
    if (system.includes('记忆整理器')) {
      extractCalls += 1;
      if (extractCalls === 1) return plan(firstText, ttl.first === undefined ? ttlOf(firstText) : ttl.first);
      return plan(secondText, ttl.second === undefined ? ttlOf(secondText) : ttl.second);
    }
    return JSON.stringify({ results: [{ index: 0, relation: 'duplicate', target: 1, salience: 0.5, ttl: null }] });
  });
}

/** Pull the time phrase back out of the text, so the probe states it once. */
function ttlOf(text) {
  const match = /(下周三|下周一|下周|十二月二十号|十一月二十一号|十一月二十号)/u.exec(text);
  return match === null ? null : match[0];
}

/** The newest plan row's id — the block renders plans but does not number them. */
function onlyPlan(dbPath) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT id FROM facts WHERE kind = 'plan' ORDER BY id DESC LIMIT 1").get();
  db.close();
  return Number(row.id);
}

function boot(name, { config = {}, llm } = {}) {
  const dbPath = join(mkdtempSync(join(root, `${name}-`)), 'loom.db');
  return { loom: createLoom({ dbPath, config, llm }), dbPath };
}

/** `11-09` in Shanghai, for readable assertions. */
function label(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(5, 10);
}
function span(due) {
  return due === undefined ? 'none' : `${label(due.from)}~${label(due.to)}`;
}

try {
  console.log('\n[1] 固定日历上的解析（基准 = 2026-11-02 周一）');
  {
    const cases = [
      ['下周一我要交材料', 'day', '11-09~11-09'],
      ['下周三前把简历改完', 'day', '11-11~11-11'],
      ['下周我要搬家', 'week', '11-09~11-15'],
      ['这周得把报税弄完', 'week', '11-02~11-08'],
      ['11月9日面试', 'day', '11-09~11-09'],
      ['2026-11-09 面试', 'day', '11-09~11-09'],
      ['明天去医院', 'day', '11-03~11-03'],
      ['三天后出发', 'day', '11-05~11-05'],
      ['三天内给他答复', 'fuzzy', '11-02~11-05'],
      ['过几天把简历改完', 'fuzzy', '11-04~11-12'],
      ['下个月换租房', 'month', '12-01~12-31'],
      ['月底前报销', 'month', '11-02~11-30'],
      ['下周一的会推到下周五', 'day', '11-09~11-09'],
      ['下下周五交初稿', 'day', '11-20~11-20'],
      ['下下周开评审会', 'week', '11-16~11-22'],
      ['下周末搬家', 'day', '11-14~11-15'],
      ['这周末在家做饭', 'day', '11-07~11-08'],
      ['周天去爬山', 'day', '11-08~11-08'],
      ['周日给他回电话', 'day', '11-08~11-08'],
      ['星期天休息', 'day', '11-08~11-08'],
      ['周四前给答复', 'day', '11-05~11-05'],
      ['下个月五号交房租', 'day', '12-05~12-05'],
      ['下个月5号交房租', 'day', '12-05~12-05'],
      ['这个月20号体检', 'day', '11-20~11-20'],
      ['下下个月入职', 'month', '01-01~01-31'],
      ['明晚一起吃饭', 'day', '11-03~11-03'],
      ['后天下午开会', 'day', '11-04~11-04'],
      ['大后天出发', 'day', '11-05~11-05'],
      ['十二月二十号回家', 'day', '12-20~12-20'],
      ['昨天说的，明天必须交', 'day', '11-03~11-03'],
      ['next week I move', 'week', '11-09~11-15'],
    ];
    for (const [text, precision, expected] of cases) {
      const due = parseDue(text, BASE, TZ);
      check(`「${text}」→ ${expected}`, span(due) === expected, `${precision}/${span(due)}`);
      if (due !== undefined) check(`  精度 = ${precision}`, due.precision === precision, due.precision);
    }
  }

  console.log('\n[2] 语焉不详的，不记');
  {
    for (const text of ['过段时间再说吧', '以后有空再聊这个', '改天请你吃饭', '这事早晚要办']) {
      const due = parseDue(text, BASE, TZ);
      check(`「${text}」→ 不记`, due === undefined, span(due));
    }
  }

  /*
   * A window that has already closed is history, not a deadline. Storing one
   * makes the fact read 「截止 11-01 · 已到期」 the moment it is written, and a
   * plan would count as overdue from birth. The 10月15号 case is the one that
   * used to be worse than useless: the year-bump turned a past deadline into
   * one eleven months in the future.
   */
  console.log('\n[2b] 过去的日子不是期限，是历史');
  {
    for (const text of [
      '昨天我把车卖了',
      '前天聊的那个事',
      '上周五签的合同',
      '上周末加了两天班',
      '10月15号就交过了',
      '9月1号入职的',
    ]) {
      const due = parseDue(text, BASE, TZ);
      check(`「${text}」→ 不记`, due === undefined, span(due));
    }
  }

  console.log('\n[2c] 习惯不是一次性的期限');
  {
    for (const text of ['我每周一都要汇报', '我每天七点起床', '每月5号交房租']) {
      const due = parseDue(text, BASE, TZ);
      check(`「${text}」→ 不记`, due === undefined, span(due));
    }
  }

  console.log('\n[3] 写进库里的是一条区间，不是编出来的某一天');
  {
    const { loom } = boot('write');
    await loom.call('memory_write', { text: '用户打算下周去换个热水器', kind: 'plan' }, SESSION);
    await loom.call('memory_write', { text: '用户打算过几天把简历改完', kind: 'plan' }, SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    const ranged = /\[\d\d-\d\d~\d\d-\d\d · 截止\] 用户打算下周去换个热水器/u.test(block);
    check('「下周」渲染成区间', ranged, block.split('\n').find((line) => line.includes('热水器')) ?? '(无)');
    const fuzzy = /\[约 \d\d-\d\d~\d\d-\d\d · 截止\] 用户打算过几天把简历改完/u.test(block);
    check('「过几天」带「约」', fuzzy, block.split('\n').find((line) => line.includes('简历')) ?? '(无)');
    check('没有把「过几天」记成单日', !/\[\d\d-\d\d · 截止\] 用户打算过几天/u.test(block));
    loom.dispose();
  }

  console.log('\n[4] 改时间：先问，别直接改');
  {
    const { loom, dbPath } = boot('pending', { config: EAGER, llm: twoStep('用户打算下周去看房子', '用户打算下周一去看房子') });
    /*
     * Push the virtual clock onto "now" before the first turn.
     *
     * `harness` starts every session at `Date.now() - 3 * DAY`, but the plugin
     * decides 截止 vs 已到期 against the *real* clock. A first turn at the
     * default 60s gap therefore anchors 「下周X」 to three days ago: on
     * 2026-11-03 the virtual start is 10-30 (Fri), 下周一 resolves to 11-02,
     * and a date that was written as future is already past — the probe goes
     * red on a day when nothing changed. Skipping 3 * DAY puts the virtual
     * start at now, so 「下周X」 is future on any run date.
     */
    await loom.turn(SESSION, '我下周要去看房子', '好', { gapMs: 3 * DAY });
    await loom.settle(8);
    const first = onlyPlan(dbPath);
    await loom.turn(SESSION, '改一下，我下周一去看房子', '好', { gapMs: 60000 });
    await loom.settle(8);
    const block = loom.memoryBlock(SESSION);
    const line = block.split('\n').find((row) => row.includes('房子')) ?? '(无)';
    check('块里出现「时间待确认」', block.includes('时间待确认'), line);
    check('待确认里写了原记录', block.includes('原记'));
    check('待确认行给出 settle 的 id', new RegExp(`memory_settle\\(id=${String(first)}\\)`, 'u').test(block));
    check('收窄而不是改期 → 说细到', block.includes('说细到'), line);
    check('原区间还在（没被静默改掉）', /\[\d\d-\d\d~\d\d-\d\d · 截止\] 用户打算下周去看房子/u.test(block));

    const accepted = await loom.call('memory_settle', { id: first, accept: true }, SESSION);
    check('accept 落定', String(accepted).includes('改成新时间'), String(accepted));
    const after = loom.memoryBlock(SESSION);
    check('改成单日（区间收窄成一天）', /\[\d\d-\d\d · 截止\] 用户打算下周去看房子/u.test(after), after.split('\n').find((row) => row.includes('房子')) ?? '(无)');
    check('待确认消失', !after.includes('时间待确认'));
    loom.dispose();
  }

  console.log('\n[5] 否决之后不该再问一遍');
  {
    const { loom, dbPath } = boot('reject', { config: EAGER, llm: twoStep('用户打算下周三去体检', '用户打算十二月二十号去体检') });
    await loom.turn(SESSION, '我下周三去体检', '好', { gapMs: 3 * DAY });
    await loom.settle(8);
    const first = onlyPlan(dbPath);
    await loom.turn(SESSION, '体检改到十二月二十号', '好', { gapMs: 60000 });
    await loom.settle(8);
    const before = loom.memoryBlock(SESSION);
    check('换了日子 → 出现待确认', before.includes('时间待确认'));
    check('换日子 → 改到', before.includes('改到'), before.split('\n').find((row) => row.includes('体检')) ?? '(无)');
    const rejected = await loom.call('memory_settle', { id: first, accept: false }, SESSION);
    check('accept=false 保留原时间', String(rejected).includes('保留'), String(rejected));
    const after = loom.memoryBlock(SESSION);
    check('待确认不再出现', !after.includes('时间待确认'));
    check('原日期没变', /\[\d\d-\d\d · 截止\] 用户打算下周三去体检/u.test(after), after.split('\n').find((row) => row.includes('体检')) ?? '(无)');
    loom.dispose();
  }

  console.log('\n[6] 原来没有期限，后来给了：直接落定，不用问');
  {
    const { loom, dbPath } = boot('fill', {
      config: EAGER,
      llm: twoStep('用户打算去看房子', '用户打算去看房子', { second: '下周一' }),
    });
    await loom.turn(SESSION, '我打算去看房子', '好', { gapMs: 3 * DAY });
    await loom.settle(8);
    const first = onlyPlan(dbPath);
    check('第一次没有期限', loom.memoryBlock(SESSION).includes('未定期限'));
    await loom.turn(SESSION, '下周一去看房子', '好', { gapMs: 60000 });
    await loom.settle(8);
    const block = loom.memoryBlock(SESSION);
    check('补上期限不需要问', !block.includes('时间待确认'), block.split('\n').find((row) => row.includes('房子')) ?? '(无)');
    check('日期已落地', /\[\d\d-\d\d · 截止\] 用户打算去看房子/u.test(block), block.split('\n').find((row) => row.includes('房子')) ?? '(无)');
    const nothing = await loom.call('memory_settle', { id: first, accept: true }, SESSION);
    check('没有待确认时 settle 明说不改', String(nothing).includes('没有待确认'), String(nothing));
    loom.dispose();
  }
} catch (error) {
  // A probe that throws is a failed probe, not a crashed one: print why and
  // keep the exit code meaningful.
  fail++;
  console.log(`  FAIL 探针自身抛错 — ${String(error?.stack ?? error).split('\n')[0]}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 项断言）`);
  process.exitCode = fail === 0 ? 0 : 1;
}
