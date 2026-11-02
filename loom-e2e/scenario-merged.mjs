/**
 * 场景 C：索引工具的完整闭环（全部走真实工具调用）
 *
 * 融合进主插件后，验证：
 *   1. memory_expand 的取回、分页、续读
 *   2. memory_pack 挂钩子 / 拒绝挂 T / 生成独立 D
 *   3. memory_index 的 view / search / promote / rebuild / gc
 *   4. 遗忘级联：memory_forget 之后正文必须取不回来
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const DB = fileURLToPath(new URL('./tmp-merged.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};
const SESSION = 's1';

/* 超小 expand 预算（配置下限 200），逼出分页路径 */
const loom = createLoom({
  dbPath: DB,
  config: {
    consolidation: { triggerTokens: 150 },
    index: { expandBudgetTokens: 200 },
  },
});

console.log('[1] 写入一段值得记住的长谈');
const TALK = [
  ['我最近一直在想辞职的事，今天又加班到十点。她问我在怕什么，我说怕的不是没钱，是怕自己没本事。', '你怕的其实是「证明不了自己」，不是收入。如果留下来的理由是怕输，那走也不会让你安心。'],
  ['那你说我该不该辞？房贷还有十八年，孩子明年上小学。', '先把问题拆开：收入风险是可计算的部分，写清楚存款能撑几个月；「证明不了自己」是不可计算的部分，它不会因为多待一年就消失。'],
  ['算了一下存款能撑十一个月。其实我心里已经想走很久了，就是不敢跟她直说。', '那这次对话真正的结论不是「要不要辞职」，而是「怎么开口」。挑一个没有工作话题的晚上，先说感受再说计划，计划里带上那十一个月。'],
  [
    `再说点背景吧。${'我把这份工作从头捋了一遍：入职五年，前两年学东西，中间两年纯重复，最近一年开始纯消耗。我也怀疑过是不是我自己的问题，可每次想到「再干十年大概率就是这个样子」，身体比脑子先抗拒，周日晚上开始失眠，周一进电梯手心出汗。我也试过内部转岗，可是集团冻结 HC 冻了半年；试过跟领导谈，他只说「再扛扛，明年有项目」。明年有项目这话我听了三年了。'.repeat(3)}所以我还是倾向于走，只是怎么跟她开口还没想好。`,
    '背景记下了。五年、消耗、内部路径也堵死了——这不是冲动，是验证过的结论。所以真正的课题只剩一个：怎么开口。挑一个没有工作话题的晚上，先说感受再说计划，计划里带上那十一个月。',
  ],
];
for (const [user, assistant] of TALK) await loom.turn(SESSION, user, assistant);
await loom.settle(8);

const hooks = loom.indexBlock(SESSION);
console.log(hooks);
check('长谈进了索引', /E\d+/u.test(hooks));

/* ---------------- expand 与分页 ---------------- */

console.log('\n[2] memory_expand：取回与分页');
/* 选正文最长的事件，保证分页路径被真实触发 */
const probe = new DatabaseSync(DB);
const biggestId = probe.prepare(`
  SELECT e.id FROM events e
  ORDER BY COALESCE((SELECT SUM(LENGTH(l.text)) FROM l0 l WHERE l.id BETWEEN e.l0_from AND e.l0_to), 0) DESC
  LIMIT 1
`).get().id;
probe.close();
const eventRef = `E${biggestId}`;
const page1 = await loom.call('memory_expand', { ref: eventRef }, SESSION);
check('首屏带标题头', page1.startsWith('【正文'), page1.split('\n')[0]);
const offset = Number(/offset=(\d+)/u.exec(page1)?.[1] ?? NaN);
check('长文触发分页并返回续读指令', !page1.includes('已返回完') && Number.isFinite(offset), `offset=${offset}，首屏 ${page1.length} 字`);
const page2 = await loom.call('memory_expand', { ref: eventRef, offset }, SESSION);
check('续读接得上', page2.includes('（接上'), page2.split('\n')[0]);
const offset2 = /offset=(\d+)/u.exec(page2)?.[1];
const finalPage = offset2 === undefined ? page2 : await loom.call('memory_expand', { ref: eventRef, offset: Number(offset2) }, SESSION);
check('全文最终读完', finalPage.includes('已返回完'), `${finalPage.length} 字`);

console.log('\n[3] 边界：垃圾输入');
const bad1 = await loom.call('memory_expand', { ref: 'E999' }, SESSION);
check('不存在的编号给明确原因', bad1.includes('没有事件'), bad1);
const bad2 = await loom.call('memory_expand', { ref: 'hello' }, SESSION);
check('无法识别的编号给明确原因', bad2.includes('无法识别'), bad2);

/* ---------------- pack ---------------- */

console.log('\n[4] memory_pack：整理版与挂钩');
const packed = await loom.call('memory_pack', {
  title: '辞职纠结的来龙去脉',
  text: '那天加班到十点，回家路上第一次说出口。怕的不是没钱，是怕自己没本事。存款能撑十一个月。真正要练的是怎么开口：先说感受再说计划。',
  ref: eventRef,
}, SESSION);
check('打包成功并挂上钩子', packed.includes('已挂到'), packed.split('。')[0]);
const viaHook = await loom.call('memory_expand', { ref: eventRef }, SESSION);
check('挂钩后 expand 优先返回整理版', viaHook.includes('十一个月') && viaHook.length < 600, `${viaHook.length} 字`);

const tailPack = await loom.call('memory_pack', { title: '不该挂尾巴', text: '正文', ref: 'T' }, SESSION);
check('T 拒绝挂固定正文并生成 D', /D\d+/u.test(tailPack), tailPack.split('。')[1] ?? '');
const dref = /D\d+/u.exec(tailPack)?.[0];
const viaD = await loom.call('memory_expand', { ref: dref }, SESSION);
check('D 编号独立可取', viaD.includes('正文'), dref);

/* ---------------- index 管理 ---------------- */

console.log('\n[5] memory_index：view / search / promote / rebuild / gc');
const view = await loom.call('memory_index', { action: 'view' }, SESSION);
check('view 显示驻留与候选池', view.includes('驻留') && view.includes('候选池'));
const search = await loom.call('memory_index', { action: 'search', query: '辞职' }, SESSION);
check('search 能命中冷区钩子', search.includes('E1'), search.split('\n')[0]);
const promoted = await loom.call('memory_index', { action: 'promote', ref: 'E1' }, SESSION);
check('promote 可用', promoted.includes('E1'), promoted);
const rebuilt = await loom.call('memory_index', { action: 'rebuild' }, SESSION);
check('rebuild 返回统计', /驻留 \d+ 条 \/ 候选 \d+ 条/u.test(rebuilt), rebuilt);

/* ---------------- 遗忘级联 ---------------- */

console.log('\n[6] 遗忘级联：用户说忘掉之后');
await loom.call('memory_write', { text: '用户正在考虑辞职，真正怕的是证明不了自己', kind: 'fact', pinned: true }, SESSION);
await loom.settle(4);
const searchHit = await loom.call('memory_search', { query: '辞职' }, SESSION);
const factLine = searchHit.split('\n').find((line) => /· fact ·/u.test(line));
const eventLine = searchHit.split('\n').find((line) => /· event ·/u.test(line));
const factRef = /\(#(F\d+)\)/u.exec(factLine ?? '')?.[1];
const searchEventRef = /\(#(E\d+)\)/u.exec(eventLine ?? '')?.[1];
check('search 结果带可直接使用的 ref', factRef !== undefined, `事实 → #${factRef ?? '缺失'}；经历 → #${searchEventRef ?? '缺失'}`);
const factId = Number(factRef?.slice(1) ?? NaN);
check('造出一条可删的事实', Number.isFinite(factId), factLine?.slice(0, 50) ?? '无 fact 行');
if (factRef !== undefined) {
  const direct = await loom.call('memory_expand', { ref: factRef }, SESSION);
  check('search 给的 ref 能直接喂给 memory_expand', !direct.includes('无法识别的编号'), direct.split('\n')[0]);
}
if (searchEventRef !== undefined) {
  const direct = await loom.call('memory_expand', { ref: searchEventRef }, SESSION);
  check('经历编号同样能直接取回正文', direct.includes('【正文'), direct.split('\n')[0]);
}
if (Number.isFinite(factId)) {
  const forget = await loom.call('memory_forget', { id: factId, permanent: true }, SESSION);
  check('遗忘成功', forget.includes('已彻底删除'), forget);
  const afterForget = await loom.call('memory_expand', { ref: `F${factId}` }, SESSION);
  check('删除后 expand 拒绝返回', afterForget.includes('没有事实') || afterForget.includes('已被删除'), afterForget);
  const gc = await loom.call('memory_index', { action: 'gc' }, SESSION);
  check('gc 报告或确认无孤儿', gc.includes('孤儿') || gc.includes('没有需要'), gc);
  const view2 = await loom.call('memory_index', { action: 'view' }, SESSION);
  check('被删钩子不再驻留', !view2.split('\n').some((line) => line.startsWith(`- F${factId} `)), `F${factId} 已从索引移除`);
}

loom.dispose();

/* ---------------- 快照与自建表 ---------------- */

console.log('\n[7] 快照与自建表');
const db = new DatabaseSync(DB);
check('自建表存在', db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'loom_%'").get().n >= 3, 'loom_docs / loom_links / loom_hooks');
const hookRows = db.prepare("SELECT COUNT(*) AS n FROM loom_hooks WHERE resident = 1").get().n;
check('落盘快照仍在', hookRows > 0, `${hookRows} 条驻留`);
db.close();

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
