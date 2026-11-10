/**
 * probe-recall-relax.mjs — 严格 AND 的漏召回与第二遍 OR 的补救
 *
 * 背景：`compileMatch` 把查询切成二字组后用 FTS5 的隐式 AND 连接，要求**每个**
 * 二字组都出现在记忆原文里。「你还记得我不吃香菜这件事吗」有 11 个二字组，
 * 记忆里只要有 3 个就够人读懂，但 FTS 判定为不命中，于是这条记忆整条消失，
 * 而且不报错——0.2.15 抓到过一次，偏好整块变空。
 *
 * 0.2.17 加的第二遍：严格匹配命中太少时，用 OR 再查一次；命中按 bm25 归一后
 * 乘 0.55，永远排不到严格命中前面；与查询共享二字组不足 25% 的候选直接丢掉，
 * 否则一个「的」「了」就能把整库拖进来。
 *
 * 断言：
 *   1. 严格命中照常工作（没被放宽改坏）；
 *   2. 严格命中的那条排在靠放宽捞回来的那条前面；
 *   3. 用户用自己的话问，也能找回那条记忆（这是修的那个 bug）；
 *   4. 只共享少量二字组的候选不会被捞进来（守卫生效）；
 *   5. 完全无关的问题不会凑数；
 *   6. 关掉 relaxMatch，同一个问题重新变成找不到（证明差异来自这次改动）；
 *   7. relaxMinOverlap 调高后，同一个问题也找不到（守卫是活的旋钮）；
 *   8. 事件层：严格为空时也能靠放宽命中事件块；
 *   9. 事件层：无关问题不会命中事件；
 *  10. prompt 路径同样受益：被放宽捞回的事实会出现在记忆块里；
 *  11. 对照：关掉之后同一轮的记忆块里没有它（说明最近 8 条兜底没帮上忙）；
 *  12. 放宽不改变写入：事实条数在调用前后一致。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-relax-'));
const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);
const textOf = (value) => (typeof value === 'string' ? value : String(value?.content?.[0]?.text ?? value));
const rowsOf = (text) => text.split('\n').filter((line) => /^\d+\. \[/u.test(line));

const FACTS = [
  '我不吃香菜，闻到味道就反胃',
  '买菜时香菜便宜，不吃也行',
  '用户养了一只叫年糕的橘猫',
];
/* 九条填充，把上面三条挤出「最近 8 条」兜底，让 prompt 路径只能靠召回命中。 */
const FILLERS = [
  '部署脚本改成了 systemd 单元，日志走 journald',
  '周会上定了下个季度的排期，先做迁移再做监控',
  '笔记本风扇异响，拆开清了灰',
  '年糕把键盘上的空格键抠下来了',
  '给客户端加了重试，退避从 200ms 起',
  '周末去看了房子，采光一般',
  '把索引重建挪到启动阶段，省一次写盘',
  '换了个新的机械键盘，青轴太吵',
  '数据库开了 WAL，读不再被写挡住',
];

const LOOSE_QUERY = '你还记得我不吃香菜这件事吗';
const STRICT_QUERY = '我不吃香菜';
const NOISE_QUERY = '明天上午几点开会';
const EVENT_QUERY = '材质缓存搞得怎么样了';

const setup = (name, retrieval, consolidation) => {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const loom = createLoom({
    dbPath: join(dir, 'loom.db'),
    config: {
      timezone: 'Asia/Shanghai',
      // 默认要攒到 20000 token 才整合，探针等不起。
      consolidation: consolidation ?? { triggerTokens: 1, idleMinutes: 0 },
      ...(retrieval === undefined ? {} : { retrieval }),
    },
  });
  return loom;
};

const seed = async (loom, { withFillers = true } = {}) => {
  for (const text of FACTS) await loom.call('memory_write', { text }, 's1');
  if (!withFillers) return;
  for (const text of FILLERS) await loom.call('memory_write', { text }, 's1');
};

/* ---- 主实例：放宽开启（默认值） ---- */
const open = setup('open');
/* ---- 对照：放宽关闭 ---- */
const closed = setup('closed', { relaxMatch: false });
/* ---- 对照：守卫收紧 ----
*
* `solidOverlap` 必须一起关掉（§71）。那条旁路与这里的比例守卫是**并列**关系：
* 共享 ≥3 个内容词就放行，不除以问句长度，所以把 `relaxMinOverlap` 调到 0.9 也拦不住
* 「我不吃香菜」这一句（它共享香菜/不吃/这件事）。不关掉它，这条断言量的是旁路，
* 不是旋钮。
*/
const strictGuard = setup('guard', { relaxMinOverlap: 0.9, solidOverlap: 0 });
/*
* 记忆块那一组单独起两个实例，并且关掉整合：整合会从用户那句话里抽出新事实，
* 新事实必然排在最前面，那样无论放宽与否记忆块里都有「香菜」，测不出差异。
*/
const blockOn = setup('block-on', undefined, { enabled: false });
const blockOff = setup('block-off', { relaxMatch: false }, { enabled: false });

try {
  await seed(open);
  await seed(closed);
  for (const text of FACTS) await strictGuard.call('memory_write', { text }, 's1');

  /* 1. 严格命中照常 */
  const strictHits = rowsOf(textOf(await open.call('memory_search', { query: STRICT_QUERY }, 's1')));
  check('严格命中照常工作', strictHits.some((row) => row.includes('闻到味道就反胃')), `${strictHits.length} 条`);

  /* 2. 严格命中的排在放宽命中的前面 */
  const strictIndex = strictHits.findIndex((row) => row.includes('闻到味道就反胃'));
  const relaxedIndex = strictHits.findIndex((row) => row.includes('买菜时香菜便宜'));
  check(
    '严格命中排在放宽命中之前',
    strictIndex >= 0 && (relaxedIndex < 0 || strictIndex < relaxedIndex),
    `strict@${strictIndex} relaxed@${relaxedIndex}`,
  );

  /* 3. 用自己的话问，也能找回 */
  const looseText = textOf(await open.call('memory_search', { query: LOOSE_QUERY }, 's1'));
  const looseHits = rowsOf(looseText);
  check('用自己的话问也能找回', looseHits.some((row) => row.includes('闻到味道就反胃')), `${looseHits.length} 条`);

  /* 4. 只共享两个二字组的候选不进来 */
  check(
    '共享过少的候选被守卫挡住',
    !looseText.includes('买菜时香菜便宜'),
    looseText.includes('买菜时香菜便宜') ? '竟然出现了' : '',
  );

  /* 5. 无关问题不凑数 */
  const noiseText = textOf(await open.call('memory_search', { query: NOISE_QUERY }, 's1'));
  check('无关问题不凑数', rowsOf(noiseText).length === 0, noiseText.slice(0, 24));

  /* 6. 关掉之后重新变成找不到 */
  const closedText = textOf(await closed.call('memory_search', { query: LOOSE_QUERY }, 's1'));
  check('关掉 relaxMatch 后找不到', rowsOf(closedText).length === 0, closedText.slice(0, 24));

  /* 7. 守卫调高之后也找不到 */
  const guardedText = textOf(await strictGuard.call('memory_search', { query: LOOSE_QUERY }, 's1'));
  check('relaxMinOverlap 调高后找不到', rowsOf(guardedText).length === 0, guardedText.slice(0, 24));

  /* 8. 事件层：严格为空时靠放宽命中 */
  await open.turn('s1', '我把星轨渲染器的材质缓存做完了，法线贴图以后再说', '收到，先记着。', { gapMs: 2 * MIN });
  await open.settle();
  const eventText = textOf(await open.call('memory_search', { query: EVENT_QUERY }, 's1'));
  check('事件块能被放宽命中', eventText.includes('星轨') || eventText.includes('材质缓存'), eventText.slice(0, 40));

  /* 9. 事件层：无关问题不命中 */
  const eventNoise = textOf(await open.call('memory_search', { query: '明天上午几点开会' }, 's1'));
  check('无关问题不命中事件块', !eventNoise.includes('星轨'), eventNoise.slice(0, 32));

  /* 10. prompt 路径：被放宽捞回的事实进得了记忆块 */
  await seed(blockOn);
  await blockOn.turn('s1', LOOSE_QUERY, '记得。', { gapMs: 2 * MIN });
  await blockOn.settle();
  const openBlock = blockOn.memoryBlock('s1');
  check('记忆块里出现该事实', openBlock.includes('不吃香菜'), openBlock.length > 0 ? '' : '记忆块为空');

  /* 11. 对照：关掉之后同一轮的记忆块里没有它 */
  await seed(blockOff);
  await blockOff.turn('s1', LOOSE_QUERY, '记得。', { gapMs: 2 * MIN });
  await blockOff.settle();
  const closedBlock = blockOff.memoryBlock('s1');
  check(
    '对照：关掉后记忆块里没有它',
    !closedBlock.includes('不吃香菜') && closedBlock.length > 0,
    closedBlock.length === 0 ? '记忆块为空' : '',
  );

  /* 12. 只读：调用前后事实条数一致 */
  const before = textOf(await open.call('memory_profile', {}, 's1'));
  await open.call('memory_search', { query: LOOSE_QUERY }, 's1');
  const after = textOf(await open.call('memory_profile', {}, 's1'));
  check('放宽不改写入', before === after && before.length > 0, before.length === 0 ? '人设卡为空' : '');
} finally {
  open.dispose();
  closed.dispose();
  strictGuard.dispose();
  blockOn.dispose();
  blockOff.dispose();
}

const width = Math.max(...results.map(([label]) => [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
let failed = 0;
console.log('=== 宽松召回 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  const pad = ' '.repeat(Math.max(0, width - [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
  console.log(`  ${ok ? '✓' : '✗'} ${label}${pad}${detail && !ok ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // best effort
}

process.exit(failed === 0 ? 0 : 1);
