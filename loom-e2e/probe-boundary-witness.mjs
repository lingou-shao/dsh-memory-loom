/**
 * 界线按「有第三方在场」端出来（§62）。
 *
 * §61 那条通道只认一种情形：这个人情绪低。但界线还有另一种情形——**这句话会
 * 被第三个人看到**：
 *
 *   周宁就在旁边，我想找画册，帮我问一句。
 *     → 「我想给周宁留张手写小卡，等她周末回家再给。先别在她面前提，我怕惊喜没了。」
 *   读者群想听近况，帮我写一句感谢支持的话。
 *     → 「之前那封信，公开的时候也别提那位读者的名字。」
 *
 * 两句话和界线一个实词都不共享，按相似度永远够不着；共有的只是「有听众」这个
 * 运行时状态。这一版把 `BOUNDARY_WITNESS` 挂到同一条通道上，并补了一条标记——
 * 「先别**在她面前**提」中间夹了「在谁面前」，原来的表要求「别」紧贴动词，一句
 * 都抽不出来。
 *
 *   node probe-boundary-witness.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, DAY } from './harness.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const BASE = Date.parse('2026-05-01T21:10:00+08:00');

/** 一条「当面别提」的界线 + 一条公开分享的界线，放在两个人格里分开测。 */
const GIFT = [
	['我想给周宁留张手写小卡，等她周末回家再给。先别在她面前提，我怕惊喜没了。', '行，我不提。'],
	['这两天在改第三章，写得慢。', '慢点写也行。']
];
const PUBLIC = [
	['有位读者写了封私信支持我。具体写了什么就留在私信里，公开说有读者支持就行。', '好，公开只说有人支持你。'],
	['之前那封信，公开的时候也别提那位读者的名字。', '明白，名字留在私下。'],
	['这两天在改第三章，写得慢。', '慢点写也行。']
];

/** 每个场景一个库：同一批语料里两个场景会互相串（§60 踩过）。 */
async function boot(name, script) {
	const dir = mkdtempSync(join(tmpdir(), `loom-witness-${name}-`));
	const loom = createLoom({ dbPath: join(dir, 'loom.db'), config: { consolidation: { triggerTokens: 0 } } });
	let at = BASE;
	for (const [user, reply] of script) {
		await loom.turn(`w-${name}`, user, reply, { at });
		at += DAY;
	}
	await loom.ready?.();
	return { loom, sid: `w-${name}` };
}

const searchOf = async (loom, sid, query) => String(await loom.call('memory_search', { query, limit: 10 }, sid));

/* ── 1. 有人在旁边：界线以原话指针出现 ───────────────────────────── */
console.log('\n[1] 「周宁就在旁边，我想找画册，帮我问一句」要翻到那条界线');
const gift = await boot('gift', GIFT);
const giftHit = await searchOf(gift.loom, gift.sid, '周宁就在旁边，我想找画册，帮我问一句。');
check('搜索里有那条界线', giftHit.includes('先别在她面前提'), giftHit.split('\n').slice(0, 3).join(' ').slice(0, 120));
const giftRef = (giftHit.match(/#(L\d+(?:-\d+)?)/u) ?? [])[1];
check('给的是原话指针（#L…）', giftRef !== undefined, giftRef ?? '（没有指针）');

/* ── 2. 展开是整句话：为什么 + 别做什么 ─────────────────────────── */
console.log('\n[2] 展开要读到两半：惊喜 + 别提');
const giftWhole = String(await gift.loom.call('memory_expand', { ref: `#${giftRef}` }, gift.sid));
check('含「惊喜」这半句', giftWhole.includes('惊喜'), giftWhole.slice(0, 90));
check('含「先别在她面前提」这半句', giftWhole.includes('先别在她面前提'));

/* ── 3. 公开分享：另一条界线 ────────────────────────────────────── */
console.log('\n[3] 「读者群想听近况，帮我写一句感谢支持的话」要翻到公开那条界线');
const pub = await boot('public', PUBLIC);
const pubHit = await searchOf(pub.loom, pub.sid, '读者群想听近况，帮我写一句感谢支持的话。');
check('搜索里有「别提那位读者的名字」', pubHit.includes('别提那位读者的名字'), pubHit.split('\n').slice(0, 3).join(' ').slice(0, 120));

/* ── 4. 反例：普通问句不翻台账 ─────────────────────────────────── */
console.log('\n[4] 「明天几号」不因为这条通道冒出界线');
const plain = await searchOf(gift.loom, gift.sid, '明天几号？');
check('没有把送礼那条端出来', !plain.includes('惊喜'), plain.split('\n').slice(0, 2).join(' ').slice(0, 90));

/* ── 5. 反例：「发」单字、「写」单字都不能算在场 ────────────────── */
console.log('\n[5] 「头发剪短了」「写得很慢」不是「有听众」');
const haircut = await searchOf(gift.loom, gift.sid, '头发剪短了，看着还行吧？');
check('没翻台账', !haircut.includes('惊喜'), haircut.split('\n').slice(0, 2).join(' ').slice(0, 90));
const slow = await searchOf(gift.loom, gift.sid, '这两天写得很慢，第三章推不动。');
check('没翻台账', !slow.includes('惊喜'), slow.split('\n').slice(0, 2).join(' ').slice(0, 90));

/* ── 6. 跨身份读不给别人的界线 ─────────────────────────────────── */
console.log('\n[6] 跨身份查询不端出对方的界线');
const visitor = await gift.loom.call('memory_search', { query: '周宁就在旁边，帮我问一句。', identity: 'someone-else', limit: 10 }, gift.sid).catch((error) => String(error));
check('被拒或为空', String(visitor).includes('没有找到') || String(visitor).includes('跨用户') || String(visitor).includes('主人'), String(visitor).slice(0, 80));

gift.loom.dispose();
pub.loom.dispose();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
