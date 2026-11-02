/**
 * probe-model-title.mjs — 模型路径的标题探针
 *
 * v0.2.16 改了两条标题规则：规则兜底不再写「领域·原句」，模型提示词要求
 * 标题带具体对象。但之前的探针全部跑在无 `llm` 的规则模式上，模型那条路
 * 一行都没被执行过——「提示词改好了」和「模型照做」是两件事。
 *
 * 这里用一个假的 `llm` 服务把那条路走通：它接收真正由插件发出的请求，返回
 * 一份忠实按提示词格式写的 JSON，然后检查落库的事件块是不是用了这份 JSON。
 * 假服务只在探针进程里存在，不接触真实库，也不改变插件行为。
 *
 * 断言：
 *   1. 模型路径真的被调用（不是静默退回规则）；
 *   2. 抽取提示词要求标题写具体对象；
 *   3. 抽取提示词给出「≤16 字」的标题上限；
 *   4. 模型给的标题被采用；
 *   5. 标题不超过 32 字（落库前的硬上限）；
 *   6. 模型给的摘要被采用，不是原句截断；
 *   7. 模型给的事实被写进事实表；
 *   8. 事件块能被 memory_episodes 按对象名检索到；
 *   9. 记忆块里出现该标题，对话下一轮能读到；
 *  10. 模型返回空标题时，落库标题退化成句子，而不是裸领域名；
 *  11. 空标题的块仍能用对话里的原词检索到；
 *  12. 模型返回非 JSON 时退回规则，块照样生成；
 *  13. 模型流抛错时对话不中断，块照样生成；
 *  14. 上述降级不写脏事实。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, mockLlm, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-model-title-'));
const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);
const textOf = (value) => (typeof value === 'string' ? value : String(value?.content?.[0]?.text ?? value));
const rowsOf = (text) => text.split('\n').filter((line) => /^\d+\. \[/u.test(line));
const titleOf = (row) => {
  const start = row.indexOf('] ');
  const end = row.indexOf(' —— ');
  return start < 0 ? '' : row.slice(start + 2, end < 0 ? undefined : end).trim();
};
/** The plugin sends its prompt as one text part, not as a `prompt` field. */
const promptOf = (request) => String(request.messages?.[0]?.content?.[0]?.text ?? '');
const isExtract = (request) => String(request.system ?? '').includes('记忆整理器');
const JUDGE_REPLY = '{"results":[{"index":0,"relation":"unrelated","target":null,"salience":0.2,"ttl":null}]}';

const GOOD = JSON.stringify({
  title: '星轨渲染器·glTF 材质丢失',
  summary: '星轨渲染器导出 glTF 时材质丢失，怀疑贴图路径没打成相对路径。',
  emotion: { valence: -0.2, arousal: 0.3, salience: 0.5 },
  impression: null,
  diary: null,
  facts: [{ text: '用户在做星轨渲染器这个项目', kind: 'fact', ttl: null, confidence: 0.9 }],
});

/**
 * One isolated plugin instance over a throwaway database.
 * @param reply - what the fake model answers.
 * @returns the loom plus the fake service, already booted.
 */
function boot(reply) {
  const dir = join(root, `db-${Math.random().toString(36).slice(2, 8)}`);
  const llm = mockLlm(reply);
  const loom = createLoom({
    dbPath: join(dir, 'loom.db'),
    llm,
    // 默认要攒 20000 token，探针等不起。
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  return { loom, llm };
}

try {
  // ---- 正常路径 ----------------------------------------------------------
  const good = boot((request) => (isExtract(request) ? GOOD : JUDGE_REPLY));
  const loom = good.loom;
  const llm = good.llm;

  await loom.turn('s1', '星轨渲染器导出 glTF 的时候材质又丢了，贴图全变粉色', '贴图路径没打成相对路径，改一下导出设置。', { gapMs: 2 * MIN });
  await loom.settle();

  const extracts = llm.calls.filter(isExtract);
  check('模型路径被调用', extracts.length >= 1, `${llm.calls.length} 次请求`);

  const prompt = extracts.length > 0 ? promptOf(extracts[0]) : '';
  check('提示词要求标题写具体对象', prompt.includes('具体对象'), '');
  check('提示词给出 ≤16 字上限', prompt.includes('≤16 字'), '');

  const rows = rowsOf(textOf(await loom.call('memory_episodes', {}, 's1')));
  const title = rows.length > 0 ? titleOf(rows[0]) : '';
  check('模型标题被采用', title.includes('星轨渲染器'), title || '(无块)');
  check('标题不超过 32 字', title.length > 0 && title.length <= 32, `${title.length} 字`);

  const body = rows[0]?.split(' —— ')[1] ?? '';
  check('模型摘要被采用', body.includes('相对路径'), body.slice(0, 24));

  const found = textOf(await loom.call('memory_search', { query: '星轨渲染器' }, 's1'));
  check('模型事实被写入', found.includes('· fact ·') && found.includes('星轨渲染器'), found.split('\n')[2]?.slice(0, 40) ?? '');
  check('块可按对象名检索', rowsOf(textOf(await loom.call('memory_episodes', { query: '星轨' }, 's1'))).length >= 1, '');

  const block = loom.memoryBlock('s1');
  check('记忆块里出现该标题', block.includes('星轨渲染器'), block.split('\n')[3]?.slice(0, 30) ?? '');
  loom.dispose();

  // ---- 空标题 ------------------------------------------------------------
  const blank = boot((request) => (isExtract(request)
    ? JSON.stringify({ title: '  ', summary: '', emotion: {}, impression: null, diary: null, facts: [] })
    : JUDGE_REPLY));
  await blank.loom.turn('s2', 'loom 的 memory_episodes 现在能按天过滤了', '可以，days 参数就是。', { gapMs: 2 * MIN });
  await blank.loom.settle();

  const blankRows = rowsOf(textOf(await blank.loom.call('memory_episodes', {}, 's2')));
  const blankTitle = blankRows.length > 0 ? titleOf(blankRows[0]) : '';
  check(
    '空标题退化成句子标题',
    blankTitle.includes('loom') && !/^(?:技术|other|工作)$/u.test(blankTitle),
    blankTitle || '(无块)',
  );
  /*
   * 空标题的兜底摘要与标题同源，清单渲染的公共前缀去重会只印标题，
   * 所以这里不查摘要行，改查「用对话里的对象名仍能搜到这块」。
   */
  const blankHits = rowsOf(textOf(await blank.loom.call('memory_episodes', { query: 'memory_episodes' }, 's2')));
  check('空标题时块仍可按原文检索', blankHits.length >= 1, `${blankHits.length} 块`);
  blank.loom.dispose();

  // ---- 非 JSON -----------------------------------------------------------
  const broken = boot((request) => (isExtract(request) ? '抱歉，我无法完成这个请求。' : JUDGE_REPLY));
  let brokenThrew = null;
  try {
    await broken.loom.turn('s3', 'Blender 那台机器的显卡驱动退回旧版本了，先别升级', '记下了。', { gapMs: 2 * MIN });
    await broken.loom.settle();
  } catch (error) {
    brokenThrew = error;
  }
  const brokenRows = rowsOf(textOf(await broken.loom.call('memory_episodes', {}, 's3')));
  check('非 JSON 时退回规则', brokenRows.length >= 1 && Boolean(brokenRows[0]?.includes('Blender')), brokenRows[0]?.slice(0, 40) ?? '(无块)');
  check('非 JSON 时对话不中断', brokenThrew === null, brokenThrew?.message ?? '');
  broken.loom.dispose();

  // ---- 模型流抛错 --------------------------------------------------------
  const boom = mockLlm(() => GOOD);
  boom.stream = async function* fail() {
    boom.calls.push({ system: '记忆整理器', messages: [] });
    throw new Error('probe: stream exploded');
  };
  const boomDir = join(root, 'db-boom');
  const boomLoom = createLoom({
    dbPath: join(boomDir, 'loom.db'),
    llm: boom,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  let boomThrew = null;
  try {
    await boomLoom.turn('s4', '香菜我确实不吃，别再往汤里放了', '记住了，以后不放。', { gapMs: 2 * MIN });
    await boomLoom.settle();
  } catch (error) {
    boomThrew = error;
  }
  const boomRows = rowsOf(textOf(await boomLoom.call('memory_episodes', {}, 's4')));
  check('模型抛错时对话不中断', boomThrew === null && boomLoom.memoryBlock('s4').includes('【'), boomThrew?.message ?? '');
  check('模型抛错时块照样生成', boomRows.length >= 1, `${boomRows.length} 块`);
  const boomFound = textOf(await boomLoom.call('memory_search', { query: '星轨渲染器' }, 's4'));
  check('模型抛错时不写脏事实', !boomFound.includes('星轨渲染器'), boomFound.slice(0, 40));
  boomLoom.dispose();

  if (process.env.LOOM_PROBE_VERBOSE === '1') {
    console.log('--- first extraction prompt ---');
    console.log(prompt);
    console.log('--- rows ---');
    console.log(rows.join('\n'));
  }
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

const width = Math.max(...results.map(([label]) => [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
let failed = 0;
console.log('=== 模型标题 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  const pad = ' '.repeat(Math.max(0, width - [...label].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
  console.log(`  ${ok ? '✓' : '✗'} ${label}${pad}${detail && !ok ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

process.exit(failed === 0 ? 0 : 1);
