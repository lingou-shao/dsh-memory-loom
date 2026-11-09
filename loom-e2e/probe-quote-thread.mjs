/**
 * 原话通道的选点：找到那一句之后，选哪两句、展开多长。
 *
 * 「找到了」和「读到了」是两件事，这一层改的就是后者。四处会悄悄退化的地方：
 *
 * 1. **虚词不能当内容词。** 「怎么说的」「当时是怎么说的」在原话里遍地都是，
 *    bm25 会把只含这些词的句子排到真正答了题的那句前面。这里放一句纯虚词的
 *    干扰话，断言它不是第一条。
 * 2. **两条指针要跨天。** 问「后来交了吗」，两条都落在当初那个晚上等于只给了
 *    一半；第二条必须落到另一个日子，而且优先落到完成态那一句（「写好了，交稿」）
 *    而不是未完成态（「还没交，逾期了」）。
 * 3. **命中一轮，读的是一小段。** 「想起来我爸」和「腰不好，久坐得垫个小枕头」
 *    不共享任何二元组，能连起来的只有对话的连续性。断言展开里两句都在。
 * 4. **「我爸」算锚点。** 代词本身不携带话题，但「我爸」常常是整道题唯一的落点。
 *
 *   node probe-quote-thread.mjs
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createLoom } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const dir = join(tmpdir(), `loom-quote-thread-${Date.now()}`);
const dbPath = join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const SID = 'thread';
const BASE = Date.parse('2026-04-01T21:00:00+08:00');
const DAY = 864e5;

/** 每天的对话按分钟排，日期跨得够开，好让「另一天」有意义。 */
const script = [
  [0, '我答应了下周三之前把渡口那篇稿子给你', '行，我记着。'],
  [2 * 60e3, '对了，想起我爸，他腰不好，久坐得垫个小枕头', '那小枕头他随身带？'],
  [4 * 60e3, '还爱听评书，外放特别大声，不吃芹菜', '那炒菜得给他单留一份。'],
  [DAY, '晚上好，她怎么说的，谈得顺不顺？', '问了心里踏实点吧。'],
  [4 * DAY, '那篇稿子还没交，逾期了', '这个真是我欠的。'],
  [5 * DAY, '写好了，交稿。渡口夜里起雾，她把纽扣攥在手里', '收到，我念一遍。'],
  [6 * DAY, '耳机送到公司前台了', '前台会帮你收着。'],
  [8 * DAY, '围巾寄到家里了', '那正好，天冷了。'],
  [9 * DAY, '对了，我还欠你三件夜班见闻，三天内讲完，先记着', '好，记下了，三件。'],
  [10 * DAY, '先还一件，王琳吃关东煮要加两包辣油，还剩两件', '两包辣油，是蘸着吃还是当汤喝']
];
for (const [offset, user, assistant] of script) await loom.turn(SID, user, assistant, { at: BASE + offset });
await loom.settle?.(8);

const refsOf = (text) => [...new Set([...text.matchAll(/#(L\d+(?:-\d+)?)/gu)].map((one) => one[1]))];
const datesOf = (text) => [...text.matchAll(/\[(\d{4}-\d{2}-\d{2}) · 原话\]/gu)].map((one) => one[1]);

/* ── 1. 虚词不主导排序 ────────────────────────────────────────────── */
console.log('\n[1] 只含虚词的句子不该排第一');
const thin = String(await loom.call('memory_search', { query: '那次你答应的事，当时是怎么说的？后来办了吗', limit: 10 }, SID));
const thinFirst = thin.split('\n').find((line) => line.includes('原话')) ?? '';
check('第一条不是纯虚词那句', !thinFirst.includes('她怎么说的'), thinFirst.trim().slice(0, 60));
check('第一条命中了真正的约定', thinFirst.includes('渡口'), thinFirst.trim().slice(0, 60));

/* ── 2. 跨天 + 完成态优先 ────────────────────────────────────────── */
console.log('\n[2] 问「后来」时，第二条落到另一天的完成态');
const later = String(await loom.call('memory_search', { query: '我让你写的那篇渡口稿子后来交了吗', limit: 10 }, SID));
const laterRefs = refsOf(later);
const laterDates = datesOf(later);
check('给了两条指针', laterRefs.length === 2, `${laterRefs.length} 条：${laterRefs.join(' ')}`);
check('两条不在同一天', new Set(laterDates).size === laterDates.length, laterDates.join(' / '));
const laterBodies = [];
for (const ref of laterRefs) laterBodies.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
const joined = laterBodies.join('\n');
check('读到了完成态那一句', joined.includes('写好了，交稿'), joined.includes('写好了，交稿') ? '' : joined.slice(0, 80));
check('两条合起来既有一开始也有后来', joined.includes('下周三之前') && joined.includes('写好了，交稿'));

/* ── 3. 命中一轮，读一小段 ────────────────────────────────────────── */
console.log('\n[3] 命中一句，展开带出同一段对话');
const neck = String(await loom.call('memory_search', { query: '我爸吃饭有什么要注意的', limit: 10 }, SID));
const neckRefs = refsOf(neck);
const neckBodies = [];
for (const ref of neckRefs) neckBodies.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
const neckText = neckBodies.join('\n');
check('「我爸」进了候选', neck.includes('我爸'), neck.split('\n').find((line) => line.includes('原话'))?.trim().slice(0, 60) ?? neck.slice(0, 60));
check('展开里有小枕头', neckText.includes('小枕头'));
check('展开里有不吃芹菜', neckText.includes('芹菜'));

/* ── 4. 并列两件事，不能为了跨天把其中一件挤掉 ──────────────────── */
console.log('\n[4] 「分别」类问题要的是两件事，不是两个日子');
const pair = String(await loom.call('memory_search', { query: '耳机和围巾分别送到哪里了', limit: 10 }, SID));
const pairRefs = refsOf(pair);
const pairBodies = [];
for (const ref of pairRefs) pairBodies.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
const pairText = pairBodies.join('\n');
check('给了两条指针', pairRefs.length === 2, `${pairRefs.length} 条：${pairRefs.join(' ')}`);
check('读到了耳机那条', pairText.includes('前台'));
check('读到了围巾那条', pairText.includes('家里'));

/* ── 5. 承诺 → 履约 ──────────────────────────────────────────────── */
console.log('\n[5] 问到「欠着的事」时，把履约那句接上');
/*
* 问句只说「夜班见闻还欠着几件」。履约那句是「先还一件，王琳吃关东煮要加两包辣油，
* 还剩两件」——不提夜班、不提见闻、不提欠，一个二元组都对不上。它能不能出现，
* 全看承诺那一轮之后接不接得上。用「上次欠的事办了吗」这种问法测不出来：那种
* 句子自己就会命中「还/交」那些结果句。
*/
const owed = String(await loom.call('memory_search', { query: '夜班见闻我还欠着几件来着', limit: 10 }, SID));
const owedRefs = refsOf(owed);
const owedBodies = [];
for (const ref of owedRefs) owedBodies.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
const owedText = owedBodies.join('\n');
check('承诺那句在结果里', owed.includes('三件夜班见闻'), owed.split('\n').slice(0, 3).join(' ').slice(0, 90));
check('履约那句也被指到', owedText.includes('先还一件'), owedText.includes('先还一件') ? '' : owedText.slice(0, 100));
check('履约那条里带着讲的是谁', owedText.includes('王琳'));
/*
* 上面这两句由两个来源给出：承诺是派生层那条（抽取器把它记成了 event），履约
* 是链指针。链指针绕过 bm25 直接按对话顺序取，所以它不进候选池也读得到——
* 「先还一件」和「夜班见闻」共享零个二元组，这个查询压根没有命中过它。
*/

/* ── 5b. 承诺记在一段对话，兑现写在下一段 ──────────────────────── */
console.log('\n[5b] 换了一段对话才兑现，也接得上');
/*
* `turnsAfter` 按 `session_id` 走，因为轮号只在会话内部有意义。可承诺经常跨
* 会话兑现：今晚说「我欠你三份书单」，下周换了新会话才说「先还一份」。两段
* 对话的轮号各自从 1 起，`session_id` 对不上，只有 `created_at` 是同一条轴。
*
* 履约那句不写「书单」是有意的：问句里只有「欠」，两句之间零词面交集，能不能
* 接上全看链——同会话为空时退到按时间找。
*/
const OTHER = 'thread-later';
await loom.turn(SID, '对了，我还欠你三份书单，回头一起给你', '记着，回头给。', { at: BASE + 11 * DAY });
await loom.turn(OTHER, '先还一份吧，第一份《夜航西飞》，还剩两份', '好，记下了。', { at: BASE + 12 * DAY });
await loom.settle?.(8);
const across = String(await loom.call('memory_search', { query: '我还欠着几份来着', limit: 10 }, SID));
const acrossRefs = refsOf(across);
const acrossBodies = [];
for (const ref of acrossRefs) acrossBodies.push(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
check('承诺那句在结果里', across.includes('三份书单'), across.split('\n').slice(0, 3).join(' ').slice(0, 90));
check('另一段对话里的履约句也被指到', acrossBodies.join('\n').includes('还剩两份'), acrossBodies.join(' ').slice(0, 100));

/* ── 6. 回滚门还在 ────────────────────────────────────────────────── */
console.log('\n[6] 关掉原话通道，结果回到旧形状');
const off = createLoom({ dbPath, config: { retrieval: { rawSearch: false } } });
const without = String(await off.call('memory_search', { query: '我让你写的那篇渡口稿子后来交了吗', limit: 10 }, SID));
off.dispose();
check('没有 L 指针', !/#L\d/u.test(without), without.trim().slice(0, 60));

loom.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
