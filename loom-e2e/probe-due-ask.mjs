/**
 * 「今天该做的事」里，商量的句子不该占掉陈述句的名额（2026-11-14）。
 *
 * 起因是 2.2 的 `M01-G019/s1`：2026-11-05 那个下午，同一件事（周日自己去老幺
 * 面馆看开不开）说了五遍：
 *
 *   t2216  对了周日的事
 *   t2221  行，这周日我自己跑一趟，看到底开不开     ← 唯一一句计划
 *   t2230  对了你说我周日去面馆，要不要喊上谁一起
 *   t2241  说起来周日去面馆，我在想是不是该带点啥
 *   t2252  那你也别嫌我周日回来跟你汇报一大堆
 *
 * 五条提前量都是 3 天，`DUE_INTENT` 一条也不命中 t2221，却因为「要不要」里的
 * 「要」和「是不是该」里的「该」命中了 t2230 / t2241——于是这两个商量句排在
 * 前面，两个名额全给了它们。
 *
 * 判据不是「加名额」（零和，§1），是把「问对方」放到 `DUE_INTENT` **之前**判：
 * 先问这句话是不是在商量，再问它像不像一件要办的事。层级反了就是让「要不要」
 * 里的「要」替商量句投票。
 *
 * 三组断言，缺一不可：
 *   1. 计划句进名额，两个商量句出局；
 *   2. 陈述句排在商量句前面（不是只把商量句删掉）；
 *   3. **候选里全是商量句时照样印**——这条判据只排序，不过滤。自问句
 *      （「下周体检要带啥来着」）也是要办的事，删掉就是新的一种漏。
 *
 *   node loom-e2e/probe-due-ask.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-due-ask';
const root = mkdtempSync(join(tmpdir(), 'loom-due-ask-'));

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

/* 时钟要能拨：`memoryBlock` 读 `Date.now()`，不拨表测到的永远是「今天」。 */
const realNow = Date.now;
let clock = Date.parse('2026-11-05T14:00:00+08:00');
Date.now = () => clock;

const SECTION = '【今天该做的事】';
/** 只取「今天该做的事」那一节的行，免得别的区里的同一句话把断言蒙对。 */
function dueLines(block) {
  const at = block.indexOf(SECTION);
  if (at === -1) return [];
  const rest = block.slice(at + SECTION.length);
  const end = rest.indexOf('\n【');
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));
}

/** 灌一段对话：`lines` 逐句说，同一分钟内说完（模拟那个下午）。 */
async function say(loom, lines, start) {
  let at = start;
  for (const text of lines) {
    await loom.turn(SESSION, text, '嗯。', { at });
    at += 60_000;
  }
}

try {
  // ── 1. 那个下午的五句话 ────────────────────────────────────────────────
  const first = mkdtempSync(join(root, 'cluster-'));
  const one = createLoom({ dbPath: join(first, 'loom.db'), config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
  await say(one, [
    '对了周日的事',
    '行，这周日我自己跑一趟，看到底开不开',
    '对了你说我周日去面馆，要不要喊上谁一起',
    '说起来周日去面馆，我在想是不是该带点啥',
    '那你也别嫌我周日回来跟你汇报一大堆',
  ], Date.parse('2026-11-05T14:10:00+08:00'));

  clock = Date.parse('2026-11-08T11:20:47+08:00');
  const block = one.memoryBlock(SESSION);
  const lines = dueLines(block);
  console.log(`\n== 五句同一天（now=2026-11-08 11:20）== 到期区 ${lines.length} 行`);
  for (const line of lines) console.log(`  ${line}`);

  check('块里有「今天该做的事」这一节', block.includes(SECTION));
  check('计划句进了名额', lines.some((line) => line.includes('看到底开不开')), lines.join(' | ') || '(空)');
  /* 只看这一节里的行：同一句话也可能躺在事实区或原话里，那不算占名额。 */
  check('商量句「要不要喊上谁」没占名额', !lines.some((line) => line.includes('要不要喊上谁')), lines.join(' | '));
  check('商量句「是不是该带点啥」没占名额', !lines.some((line) => line.includes('是不是该带点啥')), lines.join(' | '));
  check('到期区两行都不是商量句', !lines.some((line) => /要不要|是不是|该不该/.test(line)), lines.join(' | '));
  one.dispose();

  // ── 2. 只有商量句时，照样印出来（判据只排序，不过滤）────────────────
  const second = mkdtempSync(join(root, 'askonly-'));
  const two = createLoom({ dbPath: join(second, 'loom.db'), config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
  await say(two, [
    '下周一体检要不要空腹来着',
    '我在想是不是该周一把降压药停了',
  ], Date.parse('2026-11-05T09:00:00+08:00'));
  clock = Date.parse('2026-11-09T09:00:00+08:00');
  const onlyAsk = two.memoryBlock(SESSION);
  const askLines = dueLines(onlyAsk);
  console.log(`\n== 只有商量句（now=2026-11-09 09:00）== 到期区 ${askLines.length} 行`);
  for (const line of askLines) console.log(`  ${line}`);
  check('全是商量句时照样印，不整节消失', askLines.length > 0, askLines.join(' | ') || '(空)');
  check('印的是那两句之一', /要不要空腹|是不是该周一/.test(askLines.join(' ')), askLines.join(' | '));
  two.dispose();
} catch (error) {
  fail++;
  console.log(`  FAIL 探针自身抛错 — ${String(error?.stack ?? error).split('\n')[0]}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  Date.now = realNow;
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 项断言）`);
  process.exitCode = fail === 0 ? 0 : 1;
}
