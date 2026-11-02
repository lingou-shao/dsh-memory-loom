/**
 * probe-handoff.mjs — 交接卡探针
 *
 * 换会话、换模型时，最怕的是「规矩」和「关系」跟着自动摘要一起被压掉。
 * `memory_handoff` 因此只读：它把身份、关系、边界、长期偏好**原文引用**出来，
 * 未完成的事列成清单，下一步留空给人填。
 *
 * 断言：
 *   1. 五个格子齐全；
 *   2. 规矩是原文，不是概括；
 *   3. 计划类事实进「未完成」；
 *   4. 「下一步」是空的，没有被模型代填；
 *   5. 卡片不写库（调完之后事实条数不变）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-handoff-'));
const dbPath = join(root, 'loom.db');

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const loom = createLoom({ dbPath, config: { timezone: 'Asia/Shanghai' } });

try {
  await loom.call('memory_persona', {
    action: 'update',
    zone: 'voice',
    text: '说话直接，不铺垫，不用「当然可以」开场。',
  }, 's1');
  await loom.call('memory_persona', {
    action: 'update',
    zone: 'boundaries',
    text: '不要在我没同意的情况下改我写过的代码；不要把聊天内容发给任何第三方。',
    confirm: true,
  }, 's1');
  await loom.call('memory_write', { text: '我不吃香菜，点外卖一定要备注', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '下周要把 0.2.15 发出去，先推代码再打 tag', kind: 'plan' }, 's1');
  await loom.turn('s1', '今天先到这', '行，剩下的明天说。', { gapMs: 2 * MIN });

  const before = loom.memoryBlock('s1');
  const card = await loom.call('memory_handoff', {}, 's1');
  const text = typeof card === 'string' ? card : String(card?.content?.[0]?.text ?? card);

  check('卡片非空', text.length > 0, `${text.length} 字`);
  check('有「我是谁」', text.includes('我是谁'), '');
  check('有「我们是什么关系」', text.includes('我们是什么关系'), '');
  check('有「不能破的规矩」', text.includes('不能破的规矩'), '');
  check('有「未完成」', text.includes('未完成'), '');
  check('有「下一步」', text.includes('下一步'), '');

  check('边界是原文引用', text.includes('不要把聊天内容发给任何第三方'), '');
  check('语气是原文引用', text.includes('不用「当然可以」开场'), '');
  check('长期偏好进规矩区', text.includes('我不吃香菜'), '');
  check('计划进未完成区', text.includes('0.2.15'), '');
  check('下一步留空', text.includes('留空'), '');
  check('标明不代改规矩', text.includes('不改动它们'), '');
  check('关系角色出现', text.includes('master'), '');

  // 只读：调用前后记忆块一致，事实条数不变
  const after = loom.memoryBlock('s1');
  check('调用不改变记忆块', before === after, before === after ? '' : '记忆被改动了');

  if (process.env.LOOM_PROBE_VERBOSE === '1') {
    console.log('--- card ---');
    console.log(text);
    console.log('--- end ---');
  }
} finally {
  loom.dispose();
}

let failed = 0;
console.log('=== 交接卡 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && !ok ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // best effort
}

process.exit(failed === 0 ? 0 : 1);
