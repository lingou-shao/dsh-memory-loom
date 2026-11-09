/**
 * 界线按情形端出来（§61）。
 *
 * 界线（「你别主动提退稿邮件」）在库里是有的：偏好区每一轮都渲染。但搜索面上
 * 一次也没有——0.2.48 的 714 里，`敏感的事` 那 12 行未覆盖题的 `toolR10` 全是
 * 0。原因是纯词面的：界线的文本和「今晚写得很卡，陪我坐一会儿」一个实词都不
 * 共享，任何按词召回的通道都够不着。
 *
 * 这一段验四件事：
 *   1. 说「陪我说两句」时，界线以**原话指针**的形式出现，展开能读到整句话；
 *   2. 那一整句包含边界的两半（为什么 + 别做什么），不是只剩禁令；
 *   3. 普通问句（「明天几号」）不翻台账——它不是同义词表，是触发条件；
 *   4. 「我不吃香菜」这种普通偏好不被当成界线端出来。
 *
 *   node probe-boundary-situation.mjs
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

/** 一段有一句明确界线的对话。 */
const SCRIPT = [
	['今晚写得很卡，一个字都推不动。', '那就先别推，坐着缓缓。'],
	['对了，有件事跟你说清楚。我第一本书扑街那段，还有当年那些退稿邮件的事，你别主动提。我想问的时候自己会问，不问就先搁着。', '嗯，记下了，那些我不主动碰。'],
	['我不吃香菜，点了牛肉面别给我撒。', '行，不撒。'],
	['这两天在改第二本的第三章，写得慢。', '慢点写也行。']
];

const dir = mkdtempSync(join(tmpdir(), 'loom-boundary-'));
const loom = createLoom({ dbPath: join(dir, 'loom.db'), config: { consolidation: { triggerTokens: 0 } } });
const SID = 'boundary';
let at = BASE;
for (const [user, reply] of SCRIPT) {
	await loom.turn(SID, user, reply, { at });
	at += DAY;
}
await loom.ready?.();

const searchOf = async (query) => String(await loom.call('memory_search', { query, limit: 10 }, SID));

/* ── 1. 情绪问句把界线端出来，而且是原话指针 ─────────────────────── */
console.log('\n[1] 「今晚写得很卡，陪我说两句就行」要能翻到界线');
const hit = await searchOf('今晚写得很卡，陪我说两句就行。');
check('搜索里有界线那句', hit.includes('退稿邮件'), hit.split('\n').slice(0, 4).join(' ').slice(0, 120));
const ref = (hit.match(/#(L\d+(?:-\d+)?)/u) ?? [])[1];
check('给的是原话指针（#L…）', ref !== undefined, ref ?? '（没有指针）');

/* ── 2. 展开是整句话，两半都在 ──────────────────────────────────── */
console.log('\n[2] 展开要读到边界的两半：为什么 + 别做什么');
if (ref === undefined) {
	check('展开含「你别主动提」', false, '没有指针可展开');
} else {
	const text = String(await loom.call('memory_expand', { ref: `#${ref}` }, SID));
	check('含「别主动提」这半句', text.includes('别主动提'));
	check('含「我想问的时候自己会问」这半句', text.includes('我想问的时候自己会问'));
}

/* ── 3. 普通问句不翻台账 ───────────────────────────────────────── */
console.log('\n[3] 「明天几号」不因为这条通道冒出界线');
const plain = await searchOf('明天几号来着');
check('没有把退稿邮件端出来', !plain.includes('退稿邮件'), plain.split('\n').slice(0, 3).join(' ').slice(0, 90));

/* ── 4. 普通偏好不算界线 ───────────────────────────────────────── */
console.log('\n[4] 「我不吃香菜」不能被当成界线端出来');
const diet = await searchOf('今晚心里有点堵，陪我说两句。');
check('界线那条在', diet.includes('退稿邮件'), diet.split('\n').slice(0, 3).join(' ').slice(0, 90));
const dietRefs = [...diet.matchAll(/#(L\d+(?:-\d+)?)/gu)].map((one) => one[1]);
let dietSeen = '';
for (const one of dietRefs) dietSeen += String(await loom.call('memory_expand', { ref: `#${one}` }, SID));
check('香菜那句没有以「界线指针」的形式排在前面', !diet.split('\n')[1]?.includes('香菜'), diet.split('\n')[1]?.slice(0, 60) ?? '');

loom.dispose();
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
