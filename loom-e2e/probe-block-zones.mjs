/**
 * Does the standing-preference zone survive a block full of facts?
 *
 * Before 0.2.19 the preference zone was appended last through `pushWhole`, which
 * compares against the *hard* cap. Any turn whose facts filled the target
 * therefore dropped it — silently. Nothing errored, the config still said the
 * zone was on, the block just stopped carrying "我不吃香菜".
 *
 * That is the one failure mode this probe exists to pin: not "is the preference
 * rendered when there is room", but "is it rendered when there is none".
 *
 * The second half checks order. Preferences and plans answer "what must I
 * remember without being asked"; facts answer "what is relevant right now". The
 * first question has to be answered first, or a long fact list pushes it past
 * the point where the model is still reading carefully.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-zone-session';
const root = mkdtempSync(join(tmpdir(), 'loom-zones-'));
/*
 * 时钟固定成上午十点（§91.5）。
 *
 * [4] 断言「无关话题下偏好区为空」，可它的偏好里有「不接受在晚上十点后收到
 * 消息」——22 点之后跑，钟点规矩（`clockRules`，§83）会把它当「现在正在生效
 * 的规矩」追进偏好区，于是这一项每天都随本机钟点翻脸：白天绿、深夜红。
 * 一条断言不应该依赖运行时刻；这里把 `Date.now` 钉住，让它只在被断言的行为
 * 变化时才红。
 */
const REAL_NOW = Date.now;
Date.now = () => Date.parse('2026-04-06T10:00:00+08:00');

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
  const dir = mkdtempSync(join(root, `${name}-`));
  const loom = createLoom({ dbPath: join(dir, 'loom.db'), config });
  return loom;
}

const PREFERENCES = [
  '用户对香菜过敏，点外卖一定要备注不要香菜',
  '用户不吃甜的，奶茶永远点无糖',
  '用户不接受在晚上十点后收到消息',
];

const FILLER = [
  '用户在上海做前端，主要写 React',
  '用户的键盘换了静音轴体',
  '用户租的房子在地铁终点站',
  '用户每周跑三次五公里',
  '用户学过大提琴，拉了两年',
  '用户喜欢拍胶片，手上有台奥林巴斯',
  '用户的移动硬盘里有十几年的照片备份',
  '用户家里有一台半自动咖啡机',
  '用户考过六级，听力分数一般',
  '用户的论文查重率降到了百分之八',
  '用户想换一台二十七寸的显示器',
  '用户的降噪耳机左耳接触不良',
  '用户收藏了一块机械表，舍不得戴',
  '用户家的路由器放在客厅角落',
  '用户的洗衣机甩干时有异响',
  '用户习惯把包裹放在楼下驿站',
  '用户办过一张储蓄卡，专存旅行基金',
  '用户的医保卡绑在手机小程序上',
  '用户的身份证快到期了，得回户籍地换',
  '用户睡觉前一定把手机调成飞行模式',
  '用户参加过一次数学建模比赛',
  '用户在为考研做准备，专业课选了数据结构',
  '用户去年瘦了八公斤，靠控制晚饭',
  '用户的房东不肯换热水器',
];

function roughTokens(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/gu) ?? []).length;
  return Math.round(cjk * 0.65) + Math.round((text.length - cjk) * 0.25);
}

try {
  console.log('\n[1] 事实吃满预算时，偏好区必须还在');
  {
    // A deliberately cramped budget: 24 facts cannot fit next to anything.
    const loom = boot('crowded', { retrieval: { budgetTokens: 400, hardCapTokens: 450 } });
    for (const text of PREFERENCES) await loom.call('memory_write', { text, kind: 'instruction' }, SESSION);
    for (const text of FILLER) await loom.call('memory_write', { text }, SESSION);
    // Every fact starts with 「用户」, so this one bigram matches all 24 and the
    // fact zone really does fight the preference zone for the budget. With a
    // natural question only `recentFacts(8)` comes back and nothing competes.
    await loom.turn(SESSION, '用户', '嗯', { gapMs: 60000 });

    const block = loom.memoryBlock(SESSION);
    check('偏好区出现', block.includes('你的长期偏好与要求'));
    const shown = PREFERENCES.filter((text) => block.includes(text.replace('用户', ''))).length;
    check('至少一条偏好在块里', shown >= 1, `${shown}/${PREFERENCES.length}`);
    check('事实区也还在', block.includes('关于你（事实）'));
    const factShown = FILLER.filter((text) => block.includes(text.replace('用户', ''))).length;
    check('事实确实把预算吃掉了', factShown >= 8, `${factShown} 条事实`);
    loom.dispose();
  }

  console.log('\n[2] 顺序：偏好 → 计划 → 事实 → 事件');
  {
    const loom = boot('order');
    for (const text of PREFERENCES) await loom.call('memory_write', { text, kind: 'instruction' }, SESSION);
    await loom.call('memory_write', { text: '用户打算明天去银行开一张储蓄卡', kind: 'plan' }, SESSION);
    for (const text of FILLER.slice(0, 8)) await loom.call('memory_write', { text }, SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: 60000 });

    const block = loom.memoryBlock(SESSION);
    const atPref = block.indexOf('你的长期偏好与要求');
    const atPlan = block.indexOf('你说过要做的事');
    const atFact = block.indexOf('关于你（事实）');
    check('三个区都在', atPref >= 0 && atPlan >= 0 && atFact >= 0, `${atPref}/${atPlan}/${atFact}`);
    check('偏好在计划之前', atPref >= 0 && atPlan > atPref);
    check('计划在事实之前', atPlan >= 0 && atFact > atPlan);
    loom.dispose();
  }

  console.log('\n[3] 总预算不涨');
  {
    const loom = boot('budget', { retrieval: { budgetTokens: 500, hardCapTokens: 700 } });
    for (const text of PREFERENCES) await loom.call('memory_write', { text, kind: 'instruction' }, SESSION);
    for (const text of FILLER) await loom.call('memory_write', { text }, SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    const tokens = roughTokens(block);
    // The cap is soft by design (the second facts pass may run past `target`),
    // but it must stay under the hard cap it advertises.
    check('块在硬顶之内', tokens <= 900, `约 ${tokens} token / 硬顶 700`);
    loom.dispose();
  }

  console.log('\n[4] residentPreferences: 0 时偏好区回到检索驱动');
  {
    const loom = boot('resident-off', { retrieval: { residentPreferences: 0 } });
    for (const text of PREFERENCES) await loom.call('memory_write', { text, kind: 'instruction' }, SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    check('无关话题下偏好区为空', !block.includes('你的长期偏好与要求'));
    loom.dispose();
  }
} finally {
  Date.now = REAL_NOW;
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
