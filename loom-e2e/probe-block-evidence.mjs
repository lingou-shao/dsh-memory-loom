/**
 * 从块到证据这条链，三处会被悄悄弄断的地方。
 *
 * 1. **事件行重复自己。** `title：summary` 是模型写事件时的形状（短标题 + 一段
 *    摘要），但规则路径没有模型，它把用户那句话同时写进两个字段，于是同一个
 *    句子印两遍，一行吃掉一行半的位置。这一节故意不带模型——这个形状只在
 *    没有模型时出现，手工改库反而测不到：FTS 的 `tokens` 列是写入时算好的，
 *    改 title/summary 不会重算，检索根本找不到改过的事件。
 *
 * 2. **叙事在吃自己的输出。** 重写叙事的 prompt 里带着「上一版」，等于每次
 *    都对摘要再做一次摘要。级联压缩是这条链上最陡的失真（arXiv 2603.17781：
 *    第二次压缩就把 95% 的约束打到 10% 量级）。断言直接看第二次请求里的
 *    prompt 有没有第一版的正文。
 *
 * 3. **块没有计量。** `budgetTokens` 是上限，实测块只有它的两成左右；屏幕上
 *    只有上限那个数，读的人会以为给了多少就记得多少。断言 `memory_doctor`
 *    把实际用量报出来。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createLoomWithTimers, mockLlm, MIN } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const dir = join(tmpdir(), `loom-block-evidence-${Date.now()}`);
const SENTENCE = '那张穿校服的旧照片给你看归看，别发给别人。';

/* ── 1. 规则路径：事件行不能重复自己 ───────────────────────────────── */
{
  const dbPath = join(dir, 'rule.db');
  const { loom, timers } = createLoomWithTimers({
    dbPath,
    config: { consolidation: { triggerTokens: 0 }, segmentation: { gapMinutes: 5 } }
  });
  const SID = 'rule';
  await loom.turn(SID, SENTENCE, '记下了，不给别人。', { gapMs: 2 * MIN });
  await loom.turn(SID, '还有，明晚夜班前提醒我吃香蕉。', '好，记着。', { gapMs: 40 * MIN });
  /*
   * 两句连着说：规则路径把第一句当标题、整段当摘要，于是摘要以标题开头。
   * 只判等号盖不住这个形状——它是「标题 + 后半句」，不是「标题 = 摘要」。
   */
  await loom.turn(SID, '今天不想动脑子了。阿桔那条线改天再理，我先去把腰活动活动。', '那先去歇着。', { gapMs: 40 * MIN });
  for (const timer of timers) await timer.callback();
  await loom.settle(8);

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const events = db.prepare('SELECT id, title, summary FROM events').all();
  db.close();
  const same = events.filter((event) => event.title === event.summary);
  const prefixed = events.filter((event) => event.title !== event.summary && event.summary.startsWith(event.title) && event.title.length > 0);

  const hits = String(await loom.call('memory_search', { query: '穿校服', limit: 5 }, SID));
  const hitLine = hits.split('\n').find((line) => line.includes('穿校服')) ?? '';
  const block = String(loom.memoryBlock(SID));

  console.log('\n[1] 事件行不重复自己');
  check('规则路径确实产出 title == summary 的事件', same.length > 0, `${same.length}/${events.length} 条`);
  check('搜索命中行里这句话只出现一次', (hitLine.split(SENTENCE).length - 1) === 1, hitLine.trim().slice(0, 90));
  check('没有「句子：同一句子」', !hits.includes(`${SENTENCE}：${SENTENCE}`));
  check('块里也不重复', (block.split(SENTENCE).length - 1) <= 1, `出现 ${block.split(SENTENCE).length - 1} 次`);
  check('规则路径确实产出「摘要以标题开头」的事件', prefixed.length > 0, `${prefixed.length}/${events.length} 条`);
  for (const event of prefixed) {
    check(`  前缀形状不再印两遍：${event.title.slice(0, 12)}…`, !block.includes(`${event.title}：${event.title}`));
  }
  loom.dispose();
}

/* ── 2/3. 带模型：叙事不级联、块有计量 ─────────────────────────────── */
let narrativeCalls = 0;
const replyOf = (request) => {
  const text = JSON.stringify(request);
  if (text.includes('自我叙事')) {
    narrativeCalls += 1;
    return `这是第 ${narrativeCalls} 版自我叙事，我很克制。`;
  }
  const line = String(request?.messages?.[0]?.content?.[0]?.text ?? '').split('\n').find((row) => row.includes('用户：')) ?? '';
  return JSON.stringify({
    title: '一条测试',
    summary: '一条测试摘要。',
    facts: [{ text: '用户在测试块的计量。', kind: 'fact', confidence: 0.8, quote: line.slice(0, 24) }],
    aliases: [],
    emotion: { salience: 0.4, valence: 0, arousal: 0.2 },
    impression: null,
    diary: null
  });
};

const llm = mockLlm(replyOf);
const dbPath = join(dir, 'model.db');
const { loom, timers } = createLoomWithTimers({
  dbPath,
  llm,
  config: {
    consolidation: { triggerTokens: 0, narrativeEvidence: 2, dailyLlmCalls: 500 },
    segmentation: { gapMinutes: 5 }
  }
});
const SID = 'model';
/*
 * 每轮之间隔久一点，让切段把它们分开：叙事只在「新的 episode 攒够 N 个」时才重写，
 * 全挤在一段里就一次都不会触发。
 */
for (let turn = 1; turn <= 5; turn++) {
  await loom.turn(SID, `第 ${turn} 轮，随便说点别的。`, '记下了。', { gapMs: 40 * MIN });
}
for (const timer of timers) await timer.callback();
await loom.settle(8);

console.log('\n[2] 叙事不从上一版重写');
check('叙事至少重写过两次', narrativeCalls >= 2, `${narrativeCalls} 次`);
const narrativePrompts = llm.calls.filter((call) => JSON.stringify(call).includes('自我叙事'));
if (narrativePrompts.length >= 2) {
  const second = JSON.stringify(narrativePrompts[1]);
  check('第二次请求不带「上一版」字样', !second.includes('上一版'));
  check('第二次请求不含第一版正文', !second.includes('这是第 1 版'));
  check('第二次请求带事实证据', second.includes('近期事实'));
}

console.log('\n[3] 块用量有计量');
// 计量写在渲染路径里，所以先让宿主像平时那样要一次块。
loom.memoryBlock(SID);
const doctor = String(await loom.call('memory_doctor', {}, SID));
const usage = doctor.split('\n').find((line) => line.includes('块用量')) ?? '';
check('自检报出块用量', usage.length > 0, usage.trim());
check('用量后面跟着预算', /\d+ \/ \d+ token/.test(usage), usage.trim());
check('说清了上限与真实约束的区别', usage.includes('maxItems') || usage.includes('触到预算上限'));

loom.dispose();
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
