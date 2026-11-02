/**
 * probe-preference-resident.mjs — 长期偏好是否常驻
 *
 * v0.2.15 之前，`preferences` 只有一条召回路径：`preferences_fts MATCH`，
 * 而 match 是把用户这句话的每个 CJK bigram 用空格连起来 —— FTS5 里这是隐式
 * AND。于是「记得我不吃香菜吗」被拆成 记得/得我/我不/不吃/吃香/香菜/菜吗，
 * 要求七个词全部出现在偏好文本里，实际一个都命中不了，整块记忆变成空串。
 *
 * 这个探针固定三条：
 *   1. 与话题无关的轮次，最近的偏好仍然出现（常驻）；
 *   2. `residentPreferences: 0` 时回到旧行为（证明这是可关的开关，不是硬编码）；
 *   3. 偏好条数超过常驻上限时，超出的仍能被关键词召回。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, MIN } from './harness.mjs';

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const withLoom = async (name, overrides, body) => {
  const root = mkdtempSync(join(tmpdir(), `loom-pref-${name}-`));
  const loom = createLoom({ dbPath: join(root, 'loom.db'), config: { timezone: 'Asia/Shanghai', ...overrides } });
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

// 1. 默认配置：偏好常驻
await withLoom('on', {}, async (loom) => {
  await loom.call('memory_write', { text: '我不吃香菜，点外卖一定要备注', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '叫我老张，别叫老板', kind: 'instruction' }, 's1');

  const blocks = [];
  for (const query of ['记得我不吃香菜吗', '今天天气不错', '帮我看看这段代码', '这个 bug 怎么修']) {
    await loom.turn('s1', query, '收到。', { gapMs: 2 * MIN });
    blocks.push(loom.memoryBlock('s1'));
  }

  check(
    '四轮无关话题都带着偏好',
    blocks.every((block) => block.includes('香菜') && block.includes('老张')),
    blocks.map((block) => (block.includes('香菜') ? '1' : '0')).join(''),
  );
  check('偏好区标题出现', blocks[3].includes('长期偏好'), '');
});

// 2. 关掉常驻：无关话题不再带出偏好，但明确命中关键词时仍能召回
await withLoom('off', { retrieval: { residentPreferences: 0 } }, async (loom) => {
  await loom.call('memory_write', { text: '我不吃香菜，点外卖一定要备注', kind: 'instruction' }, 's1');

  await loom.turn('s1', '今天天气不错', '适合出门。', { gapMs: 2 * MIN });
  const unrelated = loom.memoryBlock('s1');
  check('residentPreferences=0 时无关话题不带出偏好', !unrelated.includes('香菜'), unrelated === '' ? '整块为空' : unrelated.slice(0, 30));

  await loom.turn('s1', '记得我不吃香菜吗', '记得。', { gapMs: 2 * MIN });
  const matched = loom.memoryBlock('s1');
  check('查询里有明确关键词时仍能召回（OR 匹配）', matched.includes('香菜'), matched.includes('香菜') ? '' : '召回失败');
});

// 3. 超出常驻上限的偏好，仍能被明确的关键词召回
await withLoom('overflow', { retrieval: { residentPreferences: 1 } }, async (loom) => {
  await loom.call('memory_write', { text: '我讨厌开会，超过半小时的会直接走', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我的生日是三月十二号', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我对花生过敏，很严重', kind: 'instruction' }, 's1');

  await loom.turn('s1', '花生过敏要注意什么', '避免交叉污染，外卖要问清楚。', { gapMs: 2 * MIN });
  const block = loom.memoryBlock('s1');

  check('超出常驻上限的偏好被关键词召回', block.includes('花生过敏'), block.includes('花生过敏') ? '' : '召回失败');
  check('最近一条偏好常驻', block.includes('花生过敏'), block.includes('花生过敏') ? '' : '常驻失败');
  check('被挤出常驻位的旧偏好没有出现', !block.includes('生日'), block.includes('生日') ? '不该出现' : '');
});

let failed = 0;
console.log('=== 长期偏好常驻 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

process.exit(failed === 0 ? 0 : 1);
