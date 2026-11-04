/**
 * 相对时间词：句子写的是「明天」，三个月后读到的是哪一天。
 *
 * 这里守的不是「显示好看」，是一件更硬的事：`[08-05] 用户明天要去医院复查`
 * 在 11 月被读到时，前面那个 08-05 是**他哪天说的**，不是**哪天要去**。
 * 一个照着「明天」回答的助手会把人指到一个月前。
 *
 * 于是要同时守住两头：
 *   1. 说得准的词要补出日期，且日期按写入那天算（昨天/前天/大后天/上周三）；
 *   2. 原本不是时间的词一个都不能补（后天免疫、先天与后天、明天出版社）。
 * 第二条比第一条重要：补错日期是往记忆里写了一句假话，而且带上了一个看起来
 * 很权威的括号。
 *
 * 还有一条不能破的：**库里存的必须是原话**。补注只活在渲染层，改了就分不清
 * 「他说错了」和「我们记错了」。
 *
 * 两个库：记忆块一趟只渲染有限条，混在一起会因为预算与衰减挤掉后半截，
 * 断言就变成在测「谁进得去预算」。要补的和不该补的各自一个库。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-rel-'));
const SESSION = 'relative';
const DAY = 86400000;

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

function lineWith(block, needle) {
  return String(block).split('\n').find((line) => line.includes(needle)) ?? '';
}

/** `MM-DD` 往前推 n 天（n 为负则往后），跨月跨年都算对。 */
function shift(mmdd, n) {
  const [month, day] = mmdd.split('-').map(Number);
  const at = new Date(Date.UTC(2026, month - 1, day));
  at.setUTCDate(at.getUTCDate() - n);
  return `${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

/** 行里被补上的 `（MM-DD）`。行首的 `[MM-DD · …]` 是方括号，不会混进来。 */
function stampIn(line) {
  return /[（(](\d{2}-\d{2})[）)]/u.exec(line)?.[1] ?? '';
}

function headIn(line) {
  return /\[(\d{2}-\d{2}) · /u.exec(line)?.[1] ?? '';
}

// `days` 相对写入那天：负数在过去（前天），正数在未来（明天）。
// 「上周三」不能用 days 表示：它是命名星期，落在上一个自然周的周三，和写入日
// 是周几有关。写成 days:-7 只在写入日恰好是周三时成立——fixture 的写入日是
// 「今天减 90 天」，日期一漂这个断言就假失败（2026-11-04 跑出来 2026-08-06，
// 周四，上周三 = 07-29，而 -7 给出 07-30）。
const CASES = [
  { text: '用户前天把明信片寄出去了，收件人是他在成都的姐姐', needle: '明信片', word: '前天', days: -2 },
  { text: '用户明天要去医院复查心脏，挂的是上午的号', needle: '要去医院复查', word: '明天', days: 1 },
  { text: '用户昨天开始吃降压药，早上一片', needle: '降压药', word: '昨天', days: -1 },
  { text: '用户大后天要交房租', needle: '要交房租', word: '大后天', days: 3 },
  { text: '用户上周三跟房东谈过续租，租金涨了两百', needle: '房东', word: '上周三', weeks: -1, weekday: 3 }
];
const NOISE = [
  { text: '用户说先天和后天都重要，习惯是后天养成的', stamp: '' },
  { text: '用户后天免疫这块不太懂，想问问医生', stamp: '' },
  { text: '用户提到明天出版社那本书，说下周去取', stamp: '' },
  { text: '用户前阵子换了工作，还在适应', stamp: '' },
  { text: '用户打算上个月把车卖了，一直没办', stamp: '' },
  { text: '用户明天（11-04）要去取体检报告', stamp: '11-04' }
];

/** 写一批事实，把写入时间拨到 90 天前，再开一次。 */
async function seed(name, rows) {
  const dbPath = join(root, `${name}.db`);
  const first = createLoom({ dbPath });
  for (const row of rows) await first.call('memory_write', typeof row === 'string' ? { text: row, kind: 'fact' } : { text: row.text, kind: row.kind ?? 'fact' }, SESSION);
  first.dispose();
  const raw = new DatabaseSync(dbPath);
  raw.exec(`UPDATE facts SET created_at = created_at - ${90 * DAY}, updated_at = updated_at - ${90 * DAY}`);
  raw.close();
  const loom = createLoom({ dbPath });
  await loom.turn(SESSION, '最近有点乱，帮我理理', '好。');
  return { dbPath, loom };
}

console.log('[1] 三个月后，记忆块里说的是哪天');
/** ISO 星期（周一=1），与 `shift` 同一套 2026 年口径。 */
function isoOf(mmdd) {
  const [month, day] = mmdd.split('-').map(Number);
  const weekday = new Date(Date.UTC(2026, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

const main = await seed('main', CASES);
const block = main.loom.memoryBlock(SESSION);
for (const line of block.split('\n').filter((row) => row.startsWith('- '))) console.log(`      ${line}`);
for (const item of CASES) {
  const line = lineWith(block, item.needle);
  const head = headIn(line);
  const want = head === '' ? '' : item.weeks === undefined
    ? shift(head, -item.days)
    : shift(head, isoOf(head) - 1 - item.weeks * 7 - (item.weekday - 1));
  check(`「${item.word}」补出写入那天的日期`, stampIn(line) === want && want !== '', `行首 ${head || '?'}，补注 ${stampIn(line) || '无'}，应为 ${want || '?'}`);
}

console.log('\n[2] 本来不是时间的词，一个都不补');
const noise = await seed('noise', NOISE);
const noiseBlock = noise.loom.memoryBlock(SESSION);
for (const item of NOISE) {
  const line = lineWith(noiseBlock, item.text.slice(0, 9));
  check(`「${item.text.slice(0, 12)}…」`, line !== '' && stampIn(line) === item.stamp, `补注 ${stampIn(line) || '无'}，应为 ${item.stamp || '无'}`);
}

console.log('\n[3] 库里还是原话');
{
  const db = new DatabaseSync(main.dbPath, { readOnly: true });
  const rows = db.prepare('SELECT text FROM facts').all().map((row) => String(row.text));
  const polluted = rows.filter((text) => /[（(]\d{2}-\d{2}[）)]/u.test(text) && !text.includes('11-04'));
  check('没有一条事实被改写成带日期的样子', polluted.length === 0, polluted[0] ?? '');
  check('句子里的「前天」原样躺在库里', rows.some((text) => text === '用户前天把明信片寄出去了，收件人是他在成都的姐姐'), '');
  db.close();
}

console.log('\n[4] 搜索命中也补');
const hit = String(await main.loom.call('memory_search', { query: '明信片' }, SESSION));
const hitLine = hit.split('\n').find((line) => line.includes('明信片')) ?? '';
const hitHead = /\[(?:\d{4}-)?(\d{2}-\d{2}) · fact/u.exec(hitLine)?.[1] ?? '';
check('搜索结果里带上了换算后的日期', hitHead !== '' && stampIn(hitLine) === shift(hitHead, 2), hitLine);

console.log('\n[5] 计划行：有期限的不重复补，没期限的才补');
await main.loom.call('memory_write', { text: '用户说明天要去银行开个户', kind: 'plan' }, SESSION);
await main.loom.call('memory_write', { text: '用户说前天就该去银行开户，一直拖到现在', kind: 'plan' }, SESSION);
await main.loom.turn(SESSION, '还有什么', '没有了。');
const planBlock = main.loom.memoryBlock(SESSION);
const datedPlan = planBlock.split('\n').find((line) => line.includes('明天要去银行开个户')) ?? '';
check('有期限的计划不重复补（行首已经是那个词的答案）', datedPlan !== '' && !datedPlan.includes('明天（'), datedPlan);
const pastPlan = planBlock.split('\n').find((line) => line.includes('就该去银行开户')) ?? '';
check('没有期限的计划里，句子中的时间词照样补', /前天（\d{2}-\d{2}）/u.test(pastPlan), pastPlan);

console.log('\n[6] 同一天说的话不补「今天」');
await main.loom.call('memory_write', { text: '用户今天把合同签了', kind: 'fact' }, SESSION);
await main.loom.turn(SESSION, '嗯', '嗯。');
const todayLine = main.loom.memoryBlock(SESSION).split('\n').find((line) => line.includes('把合同签了')) ?? '';
check('「今天」不补（行首日期就是那天）', todayLine !== '' && !todayLine.includes('今天（'), todayLine);

main.loom.dispose();
noise.loom.dispose();

console.log(`\n${failed === 0 ? '全部通过' : '有失败'}：${passed} 项通过，${failed} 项失败`);
if (failed > 0) process.exitCode = 1;
