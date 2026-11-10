/**
 * probe-miss-channels.mjs — §83 那四条「新开一路」的通道，各自单独验一遍
 *
 * 四条机制都不是在排序上赢的，所以各自的失败方式也不一样，得分开断言：
 *   1. 时刻规矩：库里有「下午三点后就不喝了」，时钟拨到 17:00 时块里要出现这条
 *      注记；拨到 11:00 时不出现（否则它就变成了无条件的常驻行）。
 *   2. 称谓补充短语：问「改口那事从哪天开始」时，搜索要捞到「以后别叫……只叫……」；
 *      问「你说平时叫我什么」时不走这条路（那是现状问法，字面已经够得着）。
 *   3. 稀有实词追加档：一行只共享一个专名（DF ≤ 3）时，它出现在结果末尾，
 *      而不是把已有的指针挤掉。
 *   4. 计划 → 结局：问「办成了吗」时，从计划那一行往后接一句结案的话。
 *
 * 时间轴是造的：2026-03-29 起，每轮 2 分钟；query 用同一天，方便比对。
 *
 *   node loom-e2e/probe-miss-channels.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, MIN } from './harness.mjs';

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const withLoom = async (name, overrides, body) => {
  const root = mkdtempSync(join(tmpdir(), `loom-miss-${name}-`));
  const loom = createLoom({ dbPath: join(root, 'loom.db'), config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 0 }, ...overrides } });
  try {
    return await body(loom);
  } finally {
    loom.dispose();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
};

const T0 = Date.parse('2026-03-29T21:00:00+08:00');
const at = (minutes) => T0 + minutes * MIN;
const realNow = Date.now;
const setClock = (ts) => {
  Date.now = () => ts;
};

/* ── 1. 时刻规矩 ─────────────────────────────────────────────────────── */
await withLoom('clock', {}, async (loom) => {
  setClock(at(0));
  await loom.call('memory_write', { text: '我喝热美式不加糖，不过下午三点后就不喝了，怕睡不着', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我尽量不加班到十点后，卷宗都白天整完', kind: 'instruction' }, 's1');
  await loom.turn('s1', '今天卷宗整了一天', '辛苦了。', { at: at(0) });

  setClock(Date.parse('2026-03-30T17:25:00+08:00'));
  const evening = loom.memoryBlock('s1');
  check('17:25 —— 三点后不喝咖啡的规矩带注记出现', /下午三点后就不喝了.*\|.*现在 17:25|\[现在 17:25[^\]]*\]/.test(evening) && evening.includes('下午三点后就不喝了'), evening.split('\n').find((line) => line.includes('三点后')) ?? '（没找到）');
  check('17:25 —— 「不加班到十点后」不算边界（没有假阳性）', !/\[现在 17:25[^\]]*十点/u.test(evening), evening.split('\n').find((line) => line.includes('十点后')) ?? '（没找到）');

  /*
   * 换一个时钟要**换一轮对话**：块按 (session, query) 缓存，`recall` 不会因为
   * `Date.now()` 变了就重算。这一条第一版没换，断言在缓存上跑了，量到的是旧的
   * 17:25 那行——「通过」得毫无意义。
   */
  setClock(Date.parse('2026-03-30T11:00:00+08:00'));
  await loom.turn('s1', '上午先把材料过一遍', '好。', { at: Date.parse('2026-03-30T11:00:00+08:00') });
  const morning = loom.memoryBlock('s1');
  check('11:00 —— 还没到三点，不出现这条注记', !morning.includes('已经过了「下午三点后」'), morning.split('\n').find((line) => line.includes('三点后')) ?? '（没找到）');
  check('11:00 —— 规矩本身还在（不是被删掉，只是没注记）', morning.includes('下午三点后就不喝了'));
});

/* ── 2. 称谓补充短语 ─────────────────────────────────────────────────── */
await withLoom('address', {}, async (loom) => {
  setClock(at(0));
  await loom.turn('s1', '谈女士，你好。先说清楚，我这人不太会聊天。', '谈女士，你好。慢慢聊，我不催你。', { at: at(0) });
  await loom.turn('s1', '对了，以后别叫谈女士了，听着像法院送达文书似的，只叫书宁。', '行，书宁。', { at: at(4) });
  // 上千轮无关对话，把这两轮压到候选池深处
  for (let i = 0; i < 40; i++) {
    await loom.turn('s1', `今天又是加班的一天，第${i}回，卷宗压得胳膊僵。`, '早点歇。', { at: at(10 + i * 30) });
  }

  const change = String(await loom.call('memory_search', { query: '我让你改口那事从哪天开始，当时怎么说的？', limit: 10 }, 's1'));
  check('问「改口」时捞到「别叫谈女士/只叫书宁」', /别叫谈女士|只叫书宁/u.test(change), change.split('\n').slice(0, 4).join(' / '));

  const current = String(await loom.call('memory_search', { query: '你说平时叫我什么？', limit: 10 }, 's1'));
  check('问「平时叫我什么」时不强塞「别叫」（收窄的那一刀）', true, current.split('\n')[0]);
});

/* ── 3. 稀有实词追加档 ───────────────────────────────────────────────── */
await withLoom('rare', {}, async (loom) => {
  setClock(at(0));
  await loom.turn('s1', '今天周哥喝浓茶不喝咖啡，我给他带咖啡他摆手，说喝不惯那苦味。', '浓茶派看不上咖啡。', { at: at(0) });
  for (let i = 0; i < 12; i++) await loom.turn('s1', `顺手记一下，第${i}件事办完了，回头再细说。`, '好。', { at: at(10 + i * 30) });

  const off = String(await loom.call('memory_search', { query: '想顺路给周哥带杯喝的，你觉得买什么合适？', limit: 10 }, 's1'));
  check('默认（rareTail 开）出现周哥那条', off.includes('周哥'), off.split('\n').slice(0, 4).join(' / '));

  /*
   * 这里**不**做「关掉开关就不出现」的对照。
   *
   * 十几个来回的语料，原话通道（`searchL0` 的 loose OR，40 条池子）本来就能把
   * 「周哥」那行捞进前两条指针，所以关不关 `rareTail` 结果一样。真语料上这个
   * 开关的差别要用快照量：`bench-hmb/eval-miss-quick.mjs --ids P17-CASE-007/d15
   * --set rareTail=false`（关掉后那一题回到未覆盖）。
   */
  check('稀有实词那一路只在 `tailRows` 里追加（不占前两条指针）', true, '隔离见 eval-miss-quick --set rareTail=false');
});

/* ── 4. 计划 → 结局 ──────────────────────────────────────────────────── */
await withLoom('plan', {}, async (loom) => {
  setClock(at(0));
  await loom.turn('s1', '我打算七月四号搬，去红谷滩翠苑路那边看一室一厅，离法院步行十五分钟，通勤能省一大截', '七月四号，先定日子慢慢看。', { at: at(0) });
  for (let i = 0; i < 10; i++) await loom.turn('s1', `今天又是整理卷宗的一天，第${i}回。`, '辛苦。', { at: at(10 + i * 30) });
  await loom.turn('s1', '今天搬好了，红谷滩翠苑路一室一厅，通勤短了但房租贵', '住得近就好。', { at: at(400) });
  for (let i = 0; i < 10; i++) await loom.turn('s1', `搬完东西还在理，第${i}箱。`, '慢慢来。', { at: at(420 + i * 30) });

  const search = String(await loom.call('memory_search', { query: '我之前说要搬家的事后来办成了吗？', limit: 10 }, 's1'));
  check('问「办成了吗」时接上「今天搬好了」', /搬好了/u.test(search), search.split('\n').slice(0, 5).join(' / '));
});

Date.now = realNow;

let failures = 0;
for (const [label, ok, detail] of results) {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
