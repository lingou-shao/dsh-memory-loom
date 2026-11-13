/**
 * 库变大之后，每一轮、每一次取面要不要跟着变贵。
 *
 * 2026-11-13：自然榜 76 题跑了 33 分钟，拆开看不是「哪里坏了」，是两处成本
 * 随行数增长。同一段语料、同一个版本，只改库的规模：
 *
 *   - 每轮灌入 23 → 32 → 99 ms（1800 / 5000 行的库）；
 *   - `memoryBlock`（每一轮都要重建的那一段）在 1800 行库上**冷**启动 845 ms，
 *     温的 1 ms。原因是到期区「增量游标 + 内存缓存」，缓存挂在实例上：
 *     实例一换（评测每题 rewind、产品每次重启）就从 id=0 重扫全库。
 *
 * 两处都不是正确性问题，读数一字不差——所以只能靠这个探针抓：
 *
 * 1. **规模梯度**：同一个库从 200 轮灌到 800 轮，后段「每轮耗时 / 前段」不得
 *    超过 1.6 倍。修复前这个比值是 2 以上，且随规模继续涨。
 * 2. **冷启动**：新建实例后的第一次 `memoryBlock` 不得比温调用贵 20 倍以上。
 *    修复前是 845 倍。
 * 3. **不变的部分**：冷/温两次的块文本必须逐字相同（缓存不能改变答案）。
 *
 * 语料是这里造的，不依赖题库：每轮都带一个「下个月 N 号」，让到期区真的有
 * 东西可解析——不带的语料测不出这一项，修复前后都一样快。
 *
 *   node loom-e2e/probe-scale-cost.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-scale-session';
const root = mkdtempSync(join(tmpdir(), 'loom-scale-'));

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
 * 一轮语料，约 300 字——**长度必须接近真实语料**。
 *
 * 第一版每轮只有四十个字，2400 轮的库每轮还是 22 ms、梯度 ×1.24，全绿；
 * 换成真实 M02（353 字/轮）同规模是 99 ms/轮。整合的代价跟正文长度走，
 * 语料太短等于把被测对象缩小到看不见。
 */
function turnAt(i) {
  const day = (i % 28) + 1;
  const user =
    i % 2 === 0
      ? `今天是第${i}天，我打算下个月${day}号把那份材料交上去，别再拖了。` +
        `上午去了趟街道办，窗口的人说要先盖章，可章在科长那儿，他出差到下周三才回来。` +
        `我就在走廊里站了一会儿，回来的路上买了个煎饼，边吃边想这事到底值不值得跑三趟。`
      : `今天也没什么特别的，就是有点累，晚上想早点睡。这是第${i}天，` +
        `早上六点半醒的，比闹钟早了四十分钟，躺着也没睡着，就把手机摸过来看了一会儿天气。` +
        `预报说周末有雨，我还想着把阳台那两盆花搬进屋，可下班回来又忘了。`;
  const assistant =
    `好，我记着了。第${i}天的事我盯着。你说的那个章的事，要是科长下周三才回，` +
    `那材料最早也得下周四才交得上去，你心里先有个数，别自己跟自己较劲。`;
  return { user, assistant };
}

const EARLY = 400;
const LATE = 2400;
const BASE = Date.parse('2026-09-01T09:00:00+08:00');
const MIN = 60_000;

const dir = mkdtempSync(join(root, 'db-'));
const loom = createLoom({
  dbPath: join(dir, 'loom.db'),
  config: { consolidation: { triggerTokens: 0 } },
  settleRounds: 1,
});

const dbPath = join(dir, 'loom.db');
const cx = new DatabaseSync(dbPath, { readOnly: true });
async function feed(from, to) {
  const began = performance.now();
  for (let i = from; i < to; i += 1) {
    const one = turnAt(i);
    await loom.turn(SESSION, one.user, one.assistant, { at: BASE + i * 37 * MIN });
  }
  return (performance.now() - began) / (to - from);
}

console.log('\n== 规模梯度 ==');
const earlyMs = await feed(0, EARLY);
const lateMs = await feed(EARLY, LATE);
const ratio = lateMs / earlyMs;
const rows = Number(cx.prepare('SELECT COUNT(*) AS n FROM l0').get()['n']);
console.log(`  ${EARLY} 轮 ${earlyMs.toFixed(1)} ms/轮 → 第 ${EARLY}–${LATE} 轮 ${lateMs.toFixed(1)} ms/轮（库 ${rows} 行）`);
check('后段每轮不超过前段的 1.6 倍', ratio < 1.6, `实际 ×${ratio.toFixed(2)}`);

/* 三条随行数退化的查询，单独量：它们藏在一轮的总耗时里，被别的固定开销稀释。 */
const now = BASE + LATE * 37 * MIN;
const time = (fn, n = 20) => {
  const began = performance.now();
  for (let i = 0; i < n; i += 1) fn();
  return (performance.now() - began) / n;
};
/* 检索在这里**不设阈值**：这份语料每轮都在说同一件事（「章」「材料」「科长」），
 * 于是任何一个词都命中全库，检索耗时量到的是语料的自相似度，不是产品的规模
 * 行为。真实语料下 5000 行的检索是 60–380 ms（`bench-22/probe-hot-path.mjs`
 * 有分项），改索引前后都在这条线上。 */
const searchMs = async () => {
  const began = performance.now();
  for (let i = 0; i < 3; i += 1) await loom.call('memory_search', { query: '那个章的事科长回来了吗', limit: 10 }, SESSION);
  return (performance.now() - began) / 3;
};
console.log(`  memory_search ${(await searchMs()).toFixed(1)} ms/次（库 ${rows} 行，语料自相似，仅供参考）`);

console.log('\n== 冷启动 ==');
/* 换实例：等价于评测里的 rewind 重建、产品里的重启。 */
loom.dispose();
const fresh = createLoom({
  dbPath,
  config: { consolidation: { triggerTokens: 0 } },
  settleRounds: 1,
});
const t0 = performance.now();
const cold = fresh.memoryBlock(SESSION, { at: now });
const coldMs = performance.now() - t0;
const t1 = performance.now();
const warm = fresh.memoryBlock(SESSION, { at: now });
const warmMs = performance.now() - t1;
console.log(`  新实例第一次 ${coldMs.toFixed(0)} ms，第二次 ${warmMs.toFixed(1)} ms，块 ${cold.length} 字`);
check('块非空（到期区真的解析出了东西）', cold.includes('【') && cold.length > 200, `${cold.length} 字`);
check('冷/温两次文本逐字相同', cold === warm);
/*
 * 断言写成**绝对阈值**而不是「冷的 / 温的」比值：温调用是查一次表（0.4–0.8 ms），
 * 冷调用多的是「建实例 + 第一次准备语句」，那点固定成本除下来是几十倍，比值
 * 没有信息量。真正要挡的是「重扫全库」——修复前 4800 行库上是 900 ms（3600 行
 * 是 343 ms），修好之后是 60–75 ms 且不随行数涨。取 200 ms 作分界，两边都留了
 * 三倍以上余量。
 */
check('冷启动 < 200 ms（4800 行库）', coldMs < 200, `${coldMs.toFixed(0)} ms（温 ${warmMs.toFixed(1)} ms）`);

/* 迁移：老库（没有 due 缓存表）打开后，第一次 block 结果必须和新建的库一样。 */
console.log('\n== 迁移 ==');
check(
  'schema 版本已升',
  Number(cx.prepare('PRAGMA user_version').get()['user_version']) >= 8,
  `v${Number(cx.prepare('PRAGMA user_version').get()['user_version'])}`,
);
const hasDue = cx.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'l0_due'").get()['n'];
check('到期缓存表存在', Number(hasDue) === 1);
const dueRows = Number(hasDue) === 1 ? Number(cx.prepare('SELECT COUNT(*) AS n FROM l0_due').get()['n']) : -1;
console.log(`  l0_due ${dueRows} 行 / l0 ${rows} 行`);
check('缓存表只存命中的行，不是全表拷贝', dueRows > 0 && dueRows < rows, `${dueRows} 行`);

fresh.dispose();
cx.close();
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
