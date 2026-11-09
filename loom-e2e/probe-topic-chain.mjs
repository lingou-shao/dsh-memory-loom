/**
 * 进度问句要能走「话题链」拿到第二端（§63）。
 *
 * 这一格来自 `P12-NEW-005`：
 *
 *   上次聊灯箱时，事情进行到哪一步了？
 *     → 「师傅发来报价了，八百，下周三上门装。」
 *
 * 问句和答案共享**零个字**：问句说「灯箱」，答句说「师傅/报价」。词面通道拿不到，
 * 闸门也不可能放行（问句二元组在那一轮里的覆盖率是 0，§63.1 量过 1/71）。能连起来
 * 的只有「同一个话题」。
 *
 * 这条通道的形态是**只追加、不插队**：搜索本来只回了一条指针时，它在末尾补一条；
 * 原本就有两条时，它排第三，原两条一个都不动（插到第二位试过四种准入写法，62 题
 * 全都要掉一格，见 §63.3）。
 *
 *   node probe-topic-chain.mjs
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

/**
 * 话题在第三轮出现，答案在第四轮，而第四轮**不再说「灯箱」**。
 *
 * 「师傅/报价」是唯一的桥：它既是第一轮留下的词，又是答案那一轮的内容。真实
 * 语料里就是这个形态——话题名只出现一次，后面的轮次省掉它。
 */
const SCRIPT = [
	['我在做一个灯箱，找了个师傅，还没报价。', '好，等他报。'],
	['今天下雨，没出门。', '那就屋里待着。'],
	['师傅发来报价了，八百，说下周三上门装。', '八百还行。'],
	// 干扰轮：比答案晚一天，只共享「师傅」一个词，讲的是另一件事（商量预算）。
	// 真实语料 `P12-NEW-005` 里就是这一句把 d03/d15/d45 顶掉的（§64.2）。
	['我打算周末和家里商量预算，明天先不用催师傅。', '好，等商量完再看。'],
	['把第三章改完了，眼睛疼。', '早点歇。']
];

const dir = mkdtempSync(join(tmpdir(), 'loom-topic-'));
const loom = createLoom({ dbPath: join(dir, 'loom.db'), config: { consolidation: { triggerTokens: 0 } } });
const sid = 'topic';
let at = BASE;
for (const [user, reply] of SCRIPT) {
	await loom.turn(sid, user, reply, { at });
	at += DAY;
}
await loom.ready?.();

const searchOf = async (query) => String(await loom.call('memory_search', { query, limit: 10 }, sid));

/* ── 1. 进度问句：第二端要出现 ──────────────────────────────────── */
console.log('\n[1] 「上次聊灯箱时，事情进行到哪一步了？」要翻到报价那一轮');
const hit = await searchOf('上次聊灯箱时，事情进行到哪一步了？');
check('搜索里有「师傅发来报价了」', hit.includes('师傅发来报价了'), hit.split('\n').slice(0, 4).join(' ').slice(0, 140));
check('没有把「今天下雨」当成答案', !hit.split('\n').slice(0, 2).join(' ').includes('今天下雨'));
check('没有把「商量预算」那句当成答案', !hit.includes('商量预算'), '只共享「师傅」一个词的晚轮不能顶掉答案');

/* ── 2. 指针能展开成整句 ────────────────────────────────────────── */
console.log('\n[2] 展开要读到整句，而不只是话题名');
const refs = hit.match(/#L\d+(?:-\d+)?/gu) ?? [];
let expanded = '';
for (const one of refs) {
	const text = String(await loom.call('memory_expand', { ref: one }, sid));
	if (text.includes('八百')) {
		expanded = text;
		break;
	}
}
check('有一个指针能展开出报价那句', expanded.includes('八百'), expanded.slice(0, 100));

/* ── 3. 「接着」也走这条通道 ────────────────────────────────────── */
console.log('\n[3] 「我想接着编灯箱那段」同样是进度问句');
const again = await searchOf('我想接着编灯箱那段，后来呢？');
check('搜索里有「师傅发来报价了」', again.includes('师傅发来报价了'), again.split('\n').slice(0, 3).join(' ').slice(0, 120));

/* ── 4. 反例：普通问句不接链 ────────────────────────────────────── */
console.log('\n[4] 「明天几号」不接链');
const plain = await searchOf('明天几号？');
check('没有端出报价那一轮', !plain.includes('八百'), plain.split('\n').slice(0, 2).join(' ').slice(0, 100));

/* ── 5. 反例：「后来」「捋一下」不算进度问句 ─────────────────────── */
console.log('\n[5] 「后来」「捋一下」不收——它们的话题本来就在问句里');
const later = await searchOf('第二次试读会后来怎么处理了？');
check('没接链', !later.includes('八百'), later.split('\n').slice(0, 2).join(' ').slice(0, 100));
const sortOut = await searchOf('帮我捋一下我喝咖啡的规矩。');
check('没接链', !sortOut.includes('八百'), sortOut.split('\n').slice(0, 2).join(' ').slice(0, 100));

/* ── 6. 反例：库里没有那个话题时不硬接 ──────────────────────────── */
console.log('\n[6] 问的话题库里没有，就不接（DF 为 0）');
const absent = await searchOf('上次聊搬家时，事情进行到哪一步了？');
check('没接出一条无关的原话指针', !absent.includes('八百'), absent.split('\n').slice(0, 2).join(' ').slice(0, 100));

loom.dispose();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
