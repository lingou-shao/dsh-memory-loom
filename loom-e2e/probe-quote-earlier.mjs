/**
 * 「最初是什么，后来改成什么」——一句话里两个时间端。
 *
 * 这类问句的种子几乎总是**后来**那一句：交付、改动、结果这类句子词面更丰富，
 * bm25 和内容词重排都会先抓到它。于是「后来改成什么」有答案了，「最初是什么」
 * 没有——而选点只会往种子之后找。
 *
 * 这一段测的就是把方向掰过来：问句点了「最初/最早/当初」，第二条往种子之前找。
 * 三件事都要成立：
 *
 * 1. 两个值都在结果里（橘猫 = 最初，纸折 = 后来）；
 * 2. 更早那条确实排在种子之后（不是因为种子恰好是早的那条）；
 * 3. 不问「最初」的时候不强行往前——否则「后来呢」那一类会被拽回第一天。
 *
 *   node probe-quote-earlier.mjs
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createLoom } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const dir = join(tmpdir(), `loom-quote-earlier-${Date.now()}`);
const dbPath = join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const SID = 'earlier';
const BASE = Date.parse('2026-04-01T21:00:00+08:00');
const DAY = 864e5;

/*
* 两句话隔了十九天，说的是同一只猫的两种形态。第一句是「故事里本来是什么」，
* 第二句是「后来改成什么」——两条都不含对方的关键词。
*/
const script = [
  [0, '开头想个小故事：钟表铺门口有只橘猫，每天守着一把没有主人的伞', '橘猫守伞，画面挺稳的。'],
  [3 * DAY, '白天去了趟旧书店，翻到一本讲修的，看着还行', '修东西的书，慢慢看。'],
  [19 * DAY, '那只猫我想改成纸折的，伞还是留在钟表铺门口', '纸折的更轻，风一吹就动。']
];
for (const [offset, user, assistant] of script) await loom.turn(SID, user, assistant, { at: BASE + offset });

/* ── 1. 两个时间端都拿到 ───────────────────────────────────────────── */
console.log('\n[1] 「最初是什么猫，后来又改成什么」两个值都在');
const both = String(await loom.call('memory_search', { query: '钟表铺守伞那段最初是什么猫？后来又改成什么？', limit: 10 }, SID));
const bothRefs = [...both.matchAll(/#L(\d+)(?:[-–~](\d+))?/gu)].map((m) => Number(m[1]));
const bodies = [];
for (const ref of both.matchAll(/#L(\d+)(?:[-–~](\d+))?/gu)) {
  bodies.push(String(await loom.call('memory_expand', { ref: `#${ref[0].slice(1)}` }, SID)));
}
const text = bodies.join('\n');
check('拿到了后来的说法（纸折）', both.includes('纸折'), both.split('\n').slice(1, 3).join(' ').slice(0, 90));
check('也拿到了当初的说法（橘猫）', text.includes('橘猫'), text.includes('橘猫') ? '' : text.slice(0, 120));

/* ── 2. 方向确实掰过来了 ───────────────────────────────────────────── */
console.log('\n[2] 更早那条排在后面，而不是被当成种子');
const firstRow = both.split('\n').find((line) => /#L\d/u.test(line)) ?? '';
check('第一条是后来的说法', firstRow.includes('纸折'), firstRow.slice(0, 80));
check('橘猫那条是第二条指针', /橘猫/u.test(bodies[bodies.length - 1] ?? ''), (bodies[bodies.length - 1] ?? '').slice(0, 80));
check('两条指针以内', bothRefs.length <= 2, `${bothRefs.length} 条`);

/* ── 3. 不问「最初」时不强行往前 ───────────────────────────────────── */
console.log('\n[3] 只问「后来」时不往回拽');
const later = String(await loom.call('memory_search', { query: '那只猫后来改成什么了', limit: 10 }, SID));
check('后来的说法在结果里', later.includes('纸折'), later.split('\n').slice(1, 2).join('').slice(0, 70));
const laterBody = [];
for (const ref of later.matchAll(/#L\d+(?:[-–~]\d+)?/gu)) laterBody.push(String(await loom.call('memory_expand', { ref: `#${ref[0].slice(1)}` }, SID)));
check(
  '没有把「最初」那条塞进来当答案',
  !laterBody.join('\n').includes('橘猫'),
  laterBody.join('\n').slice(0, 90)
);

loom.dispose();
rmSync(dir, { recursive: true, force: true });
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
