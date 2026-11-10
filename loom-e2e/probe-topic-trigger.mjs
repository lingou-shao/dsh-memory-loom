/**
 * 话题链的入口判据（§79）：`retrieval.topicTrigger`。
 *
 * §77 把话题链只挂在「问句在问进度/后来」上，理由是触发面越大越容易把闲聊
 * 追进来。§79 量完把默认换成 `always`（每次检索都跑）：714 上搜索 +39/−0、
 * 62 题五个主读数逐位不动、2.1 上锚点 +7/−1。`intent` 仍是这个配置项的另一档，
 * 探针第一段钉的就是两档的差别。
 *
 * 这里钉四件事：
 *
 *   1. 默认臂上，没有意图词的问句**不**追加（行为与 0.2.57 一致）；
 *   2. `always` 臂上，同一句话会追加；
 *   3. `always` 臂上追加仍只落在末尾，前面的顺序一条不动（§63/§71 的同一桩要求）；
 *   4. 没有匹配话题的查询在 `always` 下也**不**多出任何行（放开不等于乱塞）。
 *
 * 另外顺带钉住一个容易被说错的事实：追加进来的是 `rawPreview = 60` 的**摘要行**，
 * 不是整轮原话——它和别的指针一样要 `memory_expand` 才看到正文。
 *
 *   node loom-e2e/probe-topic-trigger.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-topic-trigger';
const DAY = 864e5;

/** 框词行：比例过得了闸门，本来就该被返回；用来检验「只追加」。 */
const FRAME = '我们家门口那块灯箱的事我记得，师傅来量尺寸那天你在旁边站了半天。';
/** 话题开头：与问句共享「灯箱/尺寸」两个内容词。 */
const INTRO = '我想在门口做块灯箱，今天师傅来量了尺寸，还没报价。';
/**
 * 答案那一轮：与问句只共享「灯箱/报价」两个内容词，比例过不了 0.25。
 *
 * 特意写长（> 60 字）：进块的是 `rawPreview` 剪过的摘要行，要能看到截断。
 */
const ANSWER = '昨天下午师傅打电话来说，灯箱的报价一千二，尺寸也按我们那天量的那个来做，边框用原来定的那种颜色，他说这周五上午就能装上去，让我们那天别出门。';
/** 只共享一个内容词的近轮：任何臂都不许追。 */
const WEAK = '街角那个做灯箱的店我路过了，门关着。';
/** 无关的强命中。 */
const STRONG = '降噪耳机左耳接触不良，打算换一副。';
const DISTRACTORS = [
	'阳台那盆绿萝我换了个大点的盆。',
	'楼下超市的鸡蛋涨价了。',
	'周三下午要开组会，材料还没整理。',
	'把旧手机给了弟弟，自己换了新的。',
	'小区门口那家面馆换了老板。'
];

/** 有意图词。 */
const ASK_LATER = '我们家门口那块灯箱，师傅来量尺寸那天我在旁边站了半天，报价这事后来到底怎么说的？';
/** 同一句话去掉意图词——这一句在默认臂上不许追加。 */
const ASK_PLAIN = '我们家门口那块灯箱，师傅来量尺寸那天我在旁边站了半天，报价这事你现在清楚吗？';
/** 与库里任何一轮都共享不到两个实词。 */
const ASK_NOTHING = '下周要不要去看那个展？';

const ANSWER_MARK = '一千二';
const WEAK_MARK = '门关着';

const refsOf = (text) => [...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]);
const lines = (text) => String(text).split('\n').filter((line) => line.trim() !== '');

async function runArm(retrieval) {
	const dir = mkdtempSync(join(tmpdir(), 'loom-trigger-'));
	const loom = createLoom({
		dbPath: join(dir, 'loom.db'),
		// 整合关掉：它会把探针自己的句子折成事实，掩盖 l0 通道。
		config: { consolidation: { enabled: false }, retrieval }
	});
	try {
		const at = Date.now() - 30 * DAY;
		for (const [user, assistant, gap] of [
			[FRAME, '那就等报价吧。', 0],
			[DISTRACTORS[0], '换盆别伤根。', 2],
			[INTRO, '先把尺寸量准，报价好算。', 3],
			[DISTRACTORS[1], '鸡蛋最近是涨得厉害。', 4],
			[WEAK, '那家店本来就开得晚。', 5],
			[DISTRACTORS[2], '组会材料早点发。', 6],
			[ANSWER, '一千二不算贵。', 7],
			[DISTRACTORS[3], '换新手机记得导数据。', 9],
			[DISTRACTORS[4], '面馆换老板味道会不会变。', 10]
		]) {
			await loom.turn(SESSION, user, assistant, { at: at + gap * DAY + 3600e3 });
		}
		const search = async (query) => String(await loom.call('memory_search', { query, limit: 10 }, SESSION));
		return { later: await search(ASK_LATER), plain: await search(ASK_PLAIN), nothing: await search(ASK_NOTHING), strong: await search(STRONG) };
	} finally {
		loom.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

const withIntent = await runArm({ topicTail: 3, topicTrigger: 'intent' });
const always = await runArm({ topicTail: 3, topicTrigger: 'always' });

const has = (text, mark) => String(text).includes(mark);

console.log('[1] 默认臂（intent）：没有意图词就不追加\n');
console.log(`  「你现在清楚吗」 ${has(withIntent.plain, ANSWER_MARK) ? '× 仍然追了' : '· 没追'}`);
console.log(`  同一句带「后来到底」 ${has(withIntent.later, ANSWER_MARK) ? '· 追到了' : '× 没追'}`);

console.log('\n[2] always 臂：同一句话现在会追加\n');
console.log(`  「你现在清楚吗」 ${has(always.plain, ANSWER_MARK) ? '· 追到了' : '× 没追'}`);
const plainRefsOff = refsOf(withIntent.plain);
const plainRefsOn = refsOf(always.plain);
const prefixKept = plainRefsOff.every((ref, index) => plainRefsOn[index] === ref);
const appended = plainRefsOn.slice(plainRefsOff.length);
console.log(`  指针 ${plainRefsOff.length} 条 → ${plainRefsOn.length} 条，追加：${appended.join(' ') || '无'}`);

console.log('\n[3] 追加仍只落末尾\n');
console.log(`  前面 ${plainRefsOff.length} 条逐位相同：${prefixKept ? '· 是' : '× 被挪动了'}`);
const answerLine = lines(always.plain).findIndex((line) => line.includes(ANSWER_MARK));
const beforeAnswer = refsOf(lines(always.plain).slice(0, Math.max(0, answerLine)).join('\n')).length;
const atTail = answerLine >= 0 && beforeAnswer >= plainRefsOff.length;
console.log(`  「一千二」在第 ${answerLine + 1} 行、之前已有 ${beforeAnswer} 条指针（原列表 ${plainRefsOff.length} 条）：${atTail ? '· 是末尾' : '× 不在末尾'}`);

console.log('\n[4] 放开不等于乱塞\n');
const nothingSame = refsOf(withIntent.nothing).join(',') === refsOf(always.nothing).join(',');
console.log(`  与库里零共享的问句：两臂指针 ${refsOf(always.nothing).length} 条，逐位相同 ${nothingSame ? '· 是' : '× 不同'}`);
console.log(`  「${WEAK_MARK}」${has(always.plain, WEAK_MARK) ? '× 被追进来了' : '· 没进来'}`);

console.log('\n[5] 追加的是摘要行，不是整轮原话\n');
const answerLineText = lines(always.plain)[answerLine] ?? '';
console.log(`  行内容：${answerLineText.trim().slice(0, 96)}`);
const quoted = /「([^」]*)」/u.exec(answerLineText)?.[1] ?? '';
console.log(`  原句 ${ANSWER.length} 字 → 块里引号内 ${quoted.length} 字（rawPreview 上限 60）：${ANSWER.length > 60 && quoted.length <= 60 ? '· 摘要行，正文要 memory_expand' : '· 整句原样'}`);

const checks = [
	['默认臂上无意图词不追加', !has(withIntent.plain, ANSWER_MARK)],
	['默认臂上带意图词追得到', has(withIntent.later, ANSWER_MARK)],
	['always 臂上无意图词也追加', has(always.plain, ANSWER_MARK)],
	['追加不挪动前面任何一条', prefixKept],
	['追加落在末尾', atTail],
	['零共享的问句不多出行', nothingSame && refsOf(always.nothing).length === refsOf(withIntent.nothing).length],
	['只共享一个内容词的近轮进不来', !has(always.plain, WEAK_MARK)]
];
console.log('\n[6] 结论\n');
let failed = 0;
for (const [name, ok] of checks) {
	if (!ok) failed++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
