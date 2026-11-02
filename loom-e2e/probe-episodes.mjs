/**
 * probe-episodes.mjs — 事件块枚举探针
 *
 * 插件不建「项目」维度：它从不读工作目录，也就无从知道两段对话属于同一个
 * 仓库。它有的是「一段一个块、每块带标题和摘要」。要让 AI 或用户自己把这些
 * 块按项目归拢，前提是块能**被枚举**——`memory_search` 只有在你已经说出
 * 关键词时才找得到，而那正是你已经不需要索引的时候。
 *
 * 断言：
 *   1. 空库时明确说没有块，不抛错；
 *   2. 聊过之后能按时间倒序列出块；
 *   3. 标题不带「技术·」这类零信息领域前缀；
 *   4. 两块标题各自带各自的对象名（能当项目节点用）；
 *   5. 标题不被摘要重复一遍；
 *   6. query 只命中相关块；
 *   7. days 过滤掉更早的块；
 *   8. 换会话之后，上个会话的块仍在同一份列表里；
 *   9. limit 生效；
 *  10. 每块带 E 编号，能交给 memory_expand；
 *  11. 只读：调用前后记忆块与事实条数不变。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-episodes-'));
const dbPath = join(root, 'loom.db');

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);
const textOf = (value) => (typeof value === 'string' ? value : String(value?.content?.[0]?.text ?? value));
const rowsOf = (text) => text.split('\n').filter((line) => /^\d+\. \[/u.test(line));
const stampOf = (row) => (row.match(/\[(\d{2}-\d{2} \d{2}:\d{2})/u) ?? ['', ''])[1];

const loom = createLoom({
  dbPath,
  config: {
    timezone: 'Asia/Shanghai',
    // 默认要攒到 20000 token 才整合一段，探针等不起，也不该等。
    consolidation: { triggerTokens: 1, idleMinutes: 0 },
  },
});

try {
  // 1. 空库
  const empty = textOf(await loom.call('memory_episodes', {}, 's1'));
  check('空库不抛错并说明原因', empty.includes('没有'), empty.slice(0, 24));

  // 2. 两件事，中间隔 35 分钟（超过 segmentation.gapMinutes=30，硬切）
  await loom.turn('s1', '我把 loom 这个记忆插件的软切改成了按事件分块，每块单独写摘要', '这样同一件事的几段就能自己归拢了。', { gapMs: 2 * MIN });
  await loom.turn('s1', 'loom 的 event 表现在有 title 和 summary 两列', '两列都进了 FTS 索引。', { gapMs: 2 * MIN });
  await loom.turn('s1', '另外帮我看看 Blender 那个天线模型的导出为什么老是丢材质', '贴图路径可能没打成相对路径。', { gapMs: 35 * MIN });
  await loom.turn('s1', 'Blender 导出 glTF 时材质丢了，先记一下', '记下了。', { gapMs: 2 * MIN });
  await loom.settle();

  const list = textOf(await loom.call('memory_episodes', {}, 's1'));
  const rows = rowsOf(list);

  check('列出事件块', rows.length >= 2, `${rows.length} 块`);
  check('有汇总行', /共 \d+ 块/u.test(list), '');
  check('按时间倒序', rows.length >= 2 && stampOf(rows[0]) >= stampOf(rows[rows.length - 1]), `${stampOf(rows[0])} ≥ ${stampOf(rows[rows.length - 1])}`);
  check('无「领域·」标题前缀', !/(?:技术|工作|日常|情感|财务|健康|家庭)·/u.test(list), '');
  check('标题带项目名 loom', rows.some((row) => row.includes('loom')), '');
  check('标题带项目名 Blender', rows.some((row) => row.includes('Blender')), '');
  check('每块带 E 编号', rows.every((row) => /· E\d+/u.test(row)), '');
  check('至少一块带关联事实数', /\d+ 条事实/u.test(list), '');

  // 标题与摘要不再重复同一句
  const repeated = rows.some((row) => {
    const at = row.indexOf(' —— ');
    if (at < 0) return false;
    const title = row.slice(row.indexOf('] ') + 2, at);
    const body = row.slice(at + 4);
    return title.replace(/…$/u, '').startsWith(body.slice(0, 8));
  });
  check('标题不被摘要重复', !repeated, repeated ? '出现同一句两次' : '');

  // 3. query 过滤
  const filtered = textOf(await loom.call('memory_episodes', { query: 'Blender' }, 's1'));
  const filteredRows = rowsOf(filtered);
  check('query 命中相关块', filteredRows.length >= 1 && filteredRows.every((row) => row.includes('Blender')), `${filteredRows.length} 块`);
  check('query 排除无关块', !/\bloom\b/u.test(filtered.replace(/memory_episodes/gu, '')), '');

  // 4. days 过滤（块的虚拟时间在 3 天前）
  const recentOnly = textOf(await loom.call('memory_episodes', { days: 1 }, 's1'));
  check('days 过滤更早的块', rowsOf(recentOnly).length === 0, '');

  // 5. limit
  const limited = textOf(await loom.call('memory_episodes', { limit: 2 }, 's1'));
  check('limit 生效', rowsOf(limited).length === 2, `${rowsOf(limited).length} 块`);

  // 6. 跨会话 —— 换个会话聊，上一个会话的块还在
  await loom.turn('s2', 'loom 的 memory_episodes 能不能看到上个会话', '同一个身份，能看到。', { gapMs: 2 * MIN });
  await loom.settle();
  const across = textOf(await loom.call('memory_episodes', {}, 's1'));
  check('跨会话块合并列出', /来自 2 个会话/u.test(across), across.split('\n').pop()?.slice(0, 40) ?? '');
  check('上个会话的块仍在', across.includes('Blender'), '');

  // 7. 只读
  const before = loom.memoryBlock('s1');
  await loom.call('memory_episodes', { limit: 50 }, 's1');
  await loom.call('memory_episodes', { query: 'loom' }, 's1');
  check('调用不改变记忆块', before === loom.memoryBlock('s1'), '');

  const doctor = textOf(await loom.call('memory_doctor', {}, 's1'));
  check('自检仍报库连接正常', doctor.includes('✓ 库连接'), '');

  if (process.env.LOOM_PROBE_VERBOSE === '1') {
    console.log('--- list ---');
    console.log(list);
    console.log('--- end ---');
  }
} finally {
  loom.dispose();
}

const width = Math.max(...results.map(([label]) => [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
let failed = 0;
console.log('=== 事件块 ===');
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
