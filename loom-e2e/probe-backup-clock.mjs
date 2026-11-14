/**
 * 「上一份备份是什么时候」不能靠文件 mtime（2026-11-14，§111）。
 *
 * 2.2 自然榜在 2,100 轮之后每轮从 38 ms 跳到 190 ms，一路不回落——§105.9 把它
 * 记成「可能是一次查询计划翻转」。真实原因不是查询：`tick()` 里的滚动备份
 * 每一轮都做了一次 `VACUUM INTO`（每次 110–200 ms）。
 *
 * 为什么会每轮都做：`snapshotStore` 用**最新快照文件的 mtime** 判断「上一份是
 * 什么时候」，而判断用的是 `now`。评测桥把 `Date.now` 换成了语料的逻辑时钟，
 * 于是逻辑时钟一旦走到「真实 mtime + everyHours」之后，判断就永远成立：
 * 每拍一份新快照，它的 mtime 仍然是真实的现在，仍然比逻辑现在早一天。
 *
 * 判据：让逻辑时钟领先真实时钟 3 天，连灌 30 轮。**只该有 1 份快照**；按旧的
 * 「看 mtime」写法是 30 份，而且这个数字就是那 150 ms/轮。
 *
 *   node loom-e2e/probe-backup-clock.mjs
 */

import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-backup-clock';
const root = mkdtempSync(join(tmpdir(), 'loom-backup-clock-'));
const DAY = 864e5;

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const realNow = Date.now;
let clock = 0;
Date.now = () => clock;

const snapshots = (dir) => {
  try {
    return readdirSync(dir).filter((name) => /^loom-\d{4}-\d{2}-\d{2}-\d{4}\.db$/u.test(name)).sort();
  } catch {
    return [];
  }
};

const dirOf = join(root, 'backups');
const loom = createLoom({
  dbPath: join(root, 'loom.db'),
  config: { consolidation: { triggerTokens: 0 }, backup: { enabled: true, keep: 3, everyHours: 24 } },
  settleRounds: 2,
});

/** 一轮对话 + 让 `tick()` 有机会跑完（它不在 `turn` 的 await 链上）。 */
async function turn(user, at) {
  clock = at;
  await loom.turn(SESSION, user, '嗯，我记着了', { at });
  await new Promise((resolve) => setTimeout(resolve, 20));
}

/* 起点：逻辑时钟领先真实时钟 3 天——评测里就是这个形状，正常使用时两者一致。 */
const start = realNow() + 3 * DAY;

console.log('== 空库 ==');
/* 没有内容时不备份（`hasContent`）。先只建实例，不灌轮。 */
check('新库还没有快照', snapshots(dirOf).length === 0, snapshots(dirOf).join(', '));

console.log('\n== 逻辑时钟领先真实时钟 3 天（评测的形状）==');
await turn('今天风大，出门记得戴帽子', start);
const afterFirst = snapshots(dirOf);
check('第一轮之后有 1 份快照', afterFirst.length === 1, afterFirst.join(', '));

for (let i = 1; i <= 30; i += 1) await turn(`第 ${i} 句闲聊`, start + i * 60000);
const afterRun = snapshots(dirOf);
check('再连灌 30 轮仍然只有 1 份快照', afterRun.length === 1, `${afterRun.length} 份：${afterRun.join(', ')}`);

console.log('\n== 过了 everyHours 才该有第二份 ==');
await turn('过了 25 小时', start + 30 * 60000 + 25 * 36e5);
const afterDay = snapshots(dirOf);
check('25 小时之后有 2 份', afterDay.length === 2, afterDay.join(', '));

await turn('再过一分钟', start + 30 * 60000 + 25 * 36e5 + 60000);
check('紧接着的一轮不再新增', snapshots(dirOf).length === 2, snapshots(dirOf).join(', '));

console.log('\n== 时钟被拨回去不该风暴 ==');
await turn('拨回 30 小时', start + 30 * 60000 + 25 * 36e5 + 60000 - 30 * 36e5);
check('拨回去之后不新增', snapshots(dirOf).length === 2, snapshots(dirOf).join(', '));
await turn('拨回后再走一轮', start + 30 * 60000 + 25 * 36e5 + 60000 - 30 * 36e5 + 60000);
check('拨回后连走也不新增', snapshots(dirOf).length === 2, snapshots(dirOf).join(', '));

console.log('\n== 备份文件被删掉要立刻补一份 ==');
/* 库里记着「上次备份在一小时前」，可文件被用户删了——记录只有在文件还在时
 * 才算数，否则备份就永远停了。 */
for (const name of snapshots(dirOf)) rmSync(join(dirOf, name), { force: true });
check('备份目录已清空', snapshots(dirOf).length === 0, snapshots(dirOf).join(', '));
await turn('删了备份之后的一轮', start + 30 * 60000 + 25 * 36e5 + 3 * 60000);
check('下一轮立刻重新备份', snapshots(dirOf).length === 1, snapshots(dirOf).join(', '));

console.log('\n== keep 仍然剪枝 ==');
for (let i = 1; i <= 4; i += 1) {
  await turn(`第 ${i} 天`, start + 30 * 60000 + (25 + 25 * i) * 36e5);
}
const pruned = snapshots(dirOf);
check('keep=3 时只留 3 份', pruned.length === 3, `${pruned.length} 份：${pruned.join(', ')}`);

loom.dispose?.();
Date.now = realNow;
rmSync(root, { recursive: true, force: true });

console.log(`\n${pass} 项通过${fail > 0 ? `，${fail} 项失败` : ''}`);
process.exit(fail > 0 ? 1 : 0);
