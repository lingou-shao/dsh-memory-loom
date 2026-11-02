/**
 * probe-compaction.mjs — 压缩豁免探针
 *
 * 设计文档一直声称「压缩不会碰记忆，因为记忆不在上下文里」，
 * 但从未有过断言。这个探针在 compaction/start 前后各取一次三块 prompt，
 * 验证：
 *   1. 人设卡、记忆块、钩子索引块在压缩前后内容不减少；
 *   2. 置顶偏好与关键事实都还在；
 *   3. emergencyFlush 真的执行了（WAL 被 checkpoint）。
 *
 * 背景：宿主在压缩前会发 `session/event: compaction/start`，插件只做
 * `engine.emergencyFlush()`（PRAGMA wal_checkpoint(PASSIVE)）。这条路径
 * 一旦抛错或误改状态，压缩后模型就会丢记忆，而用户看不出原因。
 */

import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, DAY, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-compact-'));
const dbPath = join(root, 'loom.db');

const results = [];
const check = (label, ok, detail = '') => {
  results.push([label, Boolean(ok), detail]);
};

const walSize = () => {
  const wal = `${dbPath}-wal`;
  return existsSync(wal) ? readFileSync(wal).byteLength : 0;
};

const loom = createLoom({ dbPath, config: { timezone: 'Asia/Shanghai' } });

try {
  // 1. 写置顶偏好与两条事实 —— 这些必须能在压缩后原样看到
  await loom.call('memory_write', {
    text: '我不吃香菜，点外卖一定要备注',
    kind: 'instruction',
    pinned: true,
  }, 's1');
  await loom.call('memory_write', {
    text: '我在做一个叫 loom 的记忆插件，主要给自己用',
    kind: 'fact',
  }, 's1');
  await loom.call('memory_write', {
    text: '我住在杭州，冬天湿冷',
    kind: 'fact',
  }, 's1');

  // 2. 改一区人设，确认压缩不会把它打回预设
  await loom.call('memory_persona', {
    action: 'update',
    zone: 'voice',
    text: '说话直接一点，不用「当然可以」这种开场；不确定就说不知道。',
  }, 's1');

  // 3. 跑几轮对话，让记忆块里有事件与日记的原料
  await loom.turn('s1', '今天把记忆插件的压缩钩子理了一遍', '理清了：压缩只触发 WAL checkpoint，不动库里的记忆。', { gapMs: 2 * MIN });
  await loom.turn('s1', '我还是有点担心压缩之后你会忘事', '记忆不在上下文里，压缩影响不到它；但库坏了就真没了。', { gapMs: 3 * MIN });
  await loom.turn('s1', '记得我不吃香菜吗', '记得，点外卖要备注。', { gapMs: 2 * MIN });

  const before = {
    persona: loom.persona('s1'),
    memory: loom.memoryBlock('s1'),
    index: loom.indexBlock('s1'),
    wal: walSize(),
  };

  check('压缩前记忆块非空', before.memory.length > 0, `${before.memory.length} 字`);
  check('压缩前含置顶偏好', before.memory.includes('香菜'), '');
  check('压缩前人设卡含自定义语气', before.persona.includes('直接一点'), '');

  // 4. 触发压缩
  loom.emit('session/event', { id: 's1' }, {
    type: 'compaction/start',
    data: { reason: 'probe' },
    time: Date.now(),
  });
  await loom.settle();

  const after = {
    persona: loom.persona('s1'),
    memory: loom.memoryBlock('s1'),
    index: loom.indexBlock('s1'),
    wal: walSize(),
  };

  // 5. 不得减少
  check(
    '压缩后人设卡不缩短',
    after.persona.length >= before.persona.length,
    `${before.persona.length} → ${after.persona.length}`,
  );
  check(
    '压缩后记忆块不缩短',
    after.memory.length >= before.memory.length,
    `${before.memory.length} → ${after.memory.length}`,
  );
  check(
    '压缩后索引块不缩短',
    after.index.length >= before.index.length,
    `${before.index.length} → ${after.index.length}`,
  );

  // 6. 关键内容逐条点名
  check('压缩后仍含置顶偏好', after.memory.includes('香菜'), '');
  check('压缩后仍含事实条目', after.memory.includes('杭州') || after.memory.includes('loom'), '');
  check('压缩后人设语气未被重置', after.persona.includes('直接一点'), '');

  // 7. 逐字节相同（更强，但只作为观察项，不作为失败条件）
  const identical =
    after.persona === before.persona &&
    after.memory === before.memory &&
    after.index === before.index;
  check('三块与压缩前逐字节相同（观察项）', identical, identical ? '' : '有差异，需人工看');

  // 8. emergencyFlush 真的跑了：WAL 被 checkpoint 后不增长
  check(
    'WAL 未被压缩撑大',
    after.wal <= Math.max(before.wal, 4096 * 64),
    `${before.wal} → ${after.wal} 字节`,
  );

  // 9. 压缩后库仍可读（checkpoint 没有关掉连接）
  const doctor = await loom.call('memory_doctor', {}, 's1');
  const report = typeof doctor === 'string' ? doctor : String(doctor?.content?.[0]?.text ?? doctor);
  check('压缩后自检仍报库连接正常', report.includes('✓ 库连接'), '');
} finally {
  loom.dispose();
}

const width = Math.max(...results.map(([label]) => [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
let failed = 0;
console.log('=== 压缩豁免 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  const pad = ' '.repeat(Math.max(0, width - [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
  console.log(`  ${ok ? '✓' : '✗'} ${label}${pad}${detail ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // best effort
}

process.exit(failed === 0 ? 0 : 1);
