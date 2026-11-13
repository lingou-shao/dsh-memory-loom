/**
 * 到期窗口落到 `l0_due` 之后，「今天该做的事」还在不在（2026-11-13）。
 *
 * 0.2.72 把到期区从「渲染时全库扫」改成「写入时算好、落到 `l0_due`」。改完第一
 * 遍读数就掉了：「沾到」34 → 31，2.2 的 76 题里有 32 条到期行消失。原因是表里
 * 两个窗口列写成了 `NOT NULL`，而**只在节日模式命中的句子**（「中秋前三天得把
 * 材料交上去」——普通模式解不出日子）在普通列上是 NULL，插入直接违反约束。
 *
 * 这个失败最贵的地方不是插不进去，是**插不进去没有任何声音**：`quotesOnDay`
 * 外面那层 catch 把它吞成「到期区为空」，块照样渲染，只是少了一整节。所以探针
 * 要同时钉住三件事：
 *
 * 1. 只有节日窗口的行也写得进去（两列都空的那一半是合法的）；
 * 2. 块里真的有这一节，不是空的；
 * 3. 普通窗口的行不受影响。
 *
 *   node loom-e2e/probe-due-store.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-due-session';
const root = mkdtempSync(join(tmpdir(), 'loom-due-'));
const DB = join(root, 'loom.db');

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

/* 时钟要能拨：`memoryBlock` 读的是 `Date.now()`，跟 `bench-22/loom-bridge.mjs`
 * 一个做法。不拨表就只能测「今天」，而「今天」不会有节日。 */
const realNow = Date.now;
let clock = Date.parse('2026-08-01T10:00:00+08:00');
Date.now = () => clock;

const loom = createLoom({
  dbPath: DB,
  config: { consolidation: { triggerTokens: 0 } },
  settleRounds: 1,
});

/* ① 普通模式就能解出的单日（提前量够）。 */
await loom.turn(SESSION, '下个月十号得把那份材料交到街道办，别再拖了', '好，我记着了。', { at: clock });
/* ② 只有节日模式命中的：普通模式解不出「中秋」，festive 解得出。 */
await loom.turn(SESSION, '中秋前三天得把楼道的灯全换一遍，物业催了两回了', '记下了，到时候提醒你。', { at: clock });

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db.prepare('SELECT l0_id, due_from, due_to, fest_from, fest_to, tz, text FROM l0_due ORDER BY l0_id').all();
db.close();

console.log(`\n== 入库 ==  l0_due ${rows.length} 行`);
for (const one of rows) console.log(`  #${one.l0_id}  due=${one.due_from === null ? 'NULL' : '有'}  fest=${one.fest_from === null ? 'NULL' : '有'}  ${String(one.text).slice(0, 26)}`);

check('两句都进了到期表', rows.length === 2, `${rows.length} 行`);
const plain = rows.find((one) => String(one.text).includes('材料'));
const festive = rows.find((one) => String(one.text).includes('中秋'));
check('普通单日那句两个窗口都有', plain !== undefined && plain.due_from !== null && plain.fest_from !== null);
check(
  '只有节日窗口的那句：due_from 是 NULL、fest_from 有值',
  festive !== undefined && festive.due_from === null && festive.fest_from !== null,
  festive === undefined ? '整行都没进去' : `due=${festive.due_from} fest=${festive.fest_from}`,
);

console.log('\n== 渲染 ==');
const at = Number(festive.fest_from) + 12 * 3600_000;
clock = at;
const block = loom.memoryBlock(SESSION, {});
const section = block.includes('【今天该做的事】');
check('块里有「今天该做的事」这一节', section);
check('这一节里有节日那句', block.includes('中秋前三天'), block.length > 0 ? '' : '块是空的');

/* 换到普通那句的到期日，确认它也出得来。 */
clock = Number(plain.due_from) + 12 * 3600_000;
const block2 = loom.memoryBlock(SESSION, {});
check('普通窗口那句在自己到期日出得来', block2.includes('材料'));

loom.dispose();
rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
