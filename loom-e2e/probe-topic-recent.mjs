/**
 * 话题链：问「后来怎么样」时，把**最近几轮真的在谈这件事**的原话追到末尾（§77）。
 *
 * 这里钉四件事，缺一件这个机制就不成立：
 *
 *   1. 基础通道拿不到（问句与那一轮只共享 2 个内容词、比例不到 0.25 的闸门），
 *      打开话题链才看得到；
 *   2. 意图词是开关——同一句话去掉「后来到底」就不再追加；
 *   3. 追加的行只落在末尾，前面的顺序一条不动（§63/§71 的同一桩要求）；
 *   4. 只共享**一个**内容词的近轮进不来（门槛就是 `SAME_EVENT_OVERLAP`）。
 *
 * 第 1 条的构造方式与 §63 的场景一致：真正答了那句话与问句只共享两个实词，
 * 而问句本身很长，比例判据永远过不了 0.25。
 *
 *   node loom-e2e/probe-topic-recent.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-topic-recent';
const DAY = 864e5;

/**
 * 框词行：与问句重合得足够多（门口/灯箱/师傅/尺寸/旁边/半天），比例过得了 0.25，
 * 所以它本来就该被返回。它的作用是把「只追加」变成真检验——关掉话题链时结果里
 * 只有它一条，打开后它必须还在第一位。
 */
const FRAME = '我们家门口那块灯箱的事我记得，师傅来量尺寸那天你在旁边站了半天。';
/** 话题的开头：只有「灯箱/尺寸」两个内容词与问句重合。 */
const INTRO = '我想在门口做块灯箱，今天师傅来量了尺寸，还没报价。';
/**
 * 答案那一轮：晚几天说，与问句只共享「灯箱/报价」两个内容词。
 *
 * 两个，不是三个：三个就会撞上 §71 那条 `solidOverlap = 3` 的旁路，基础通道
 * 自己就能拿到，这个探针也就测不到话题链了（第一版就是这么错的）。
 */
const ANSWER = '昨天打电话来说，灯箱的报价一千二。';
/** 只共享一个内容词（「灯箱」）的近轮：不许被追加。 */
const WEAK = '街角那个做灯箱的店我路过了，门关着。';
/** 无关的强命中：用来证明「前面的行没被挪动」。 */
const STRONG = '降噪耳机左耳接触不良，打算换一副。';
const DISTRACTORS = [
	'阳台那盆绿萝我换了个大点的盆。',
	'楼下超市的鸡蛋涨价了。',
	'周三下午要开组会，材料还没整理。',
	'把旧手机给了弟弟，自己换了新的。',
	'小区门口那家面馆换了老板。'
];

/** 有意图词（「后来」「到底」）。 */
const ASK_LATER = '我们家门口那块灯箱，师傅来量尺寸那天我在旁边站了半天，报价这事后来到底怎么说的？';
/** 同一句话去掉意图词：不许触发。 */
const ASK_PLAIN = '我们家门口那块灯箱，师傅来量尺寸那天我在旁边站了半天，报价这事你现在清楚吗？';

const ANSWER_MARK = '一千二';
const WEAK_MARK = '门关着';

const refsOf = (text) => [...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]);
const lines = (text) => String(text).split('\n').filter((line) => line.trim() !== '');

async function runArm(topicTail) {
	const dir = mkdtempSync(join(tmpdir(), `loom-topic-${topicTail}-`));
	const loom = createLoom({
		dbPath: join(dir, 'loom.db'),
		// 整合关掉：它会把探针自己的句子折成事实，掩盖 l0 通道。
		config: { consolidation: { enabled: false }, retrieval: { topicTail } }
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
		return { later: await search(ASK_LATER), plain: await search(ASK_PLAIN), strong: await search(STRONG) };
	} finally {
		loom.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

const off = await runArm(0);
const on = await runArm(3);

const has = (text, mark) => String(text).includes(mark);
const offRefs = refsOf(off.later);
const onRefs = refsOf(on.later);
const prefixKept = offRefs.every((ref, index) => onRefs[index] === ref);
const appended = onRefs.slice(offRefs.length);

console.log('[1] 基础通道拿不到，打开话题链才看得到\n');
console.log(`  topicTail=0   ${has(off.later, ANSWER_MARK) ? '× 仍然命中' : '· 搜不到（比例闸门挡着）'}`);
console.log(`  topicTail=3   ${has(on.later, ANSWER_MARK) ? '· 搜到' : '× 还是搜不到'}`);
console.log(`  指针 0 版 ${offRefs.length} 条 → 3 版 ${onRefs.length} 条，追加：${appended.join(' ') || '无'}`);

console.log('\n[2] 追加的行只在末尾\n');
console.log(`  前面 ${offRefs.length} 条逐位相同：${prefixKept ? '· 是' : '× 被挪动了'}`);
const answerLine = lines(on.later).findIndex((line) => line.includes(ANSWER_MARK));
const beforeAnswer = refsOf(lines(on.later).slice(0, Math.max(0, answerLine)).join('\n')).length;
const atTail = answerLine >= 0 && beforeAnswer >= offRefs.length;
console.log(`  「一千二」在第 ${answerLine + 1} 行、它之前已有 ${beforeAnswer} 条指针（原列表 ${offRefs.length} 条）：${atTail ? '· 是末尾' : '× 不在末尾'}`);

console.log('\n[3] 意图词是开关\n');
console.log(`  同一句话去掉「后来到底」：${has(on.plain, ANSWER_MARK) ? '× 仍然追了' : '· 没追'}`);

console.log('\n[4] 只共享一个内容词的近轮进不来\n');
console.log(`  「${WEAK_MARK}」${has(on.later, WEAK_MARK) ? '× 被追进来了' : '· 没进来'}`);

console.log('\n[5] 无关查询：两臂有序列表逐字相同\n');
const strongSame = refsOf(off.strong).join(',') === refsOf(on.strong).join(',');
console.log(`  ${strongSame ? '· 相同' : '× 不同'}  ${refsOf(on.strong).join(' ') || '（空）'}`);

const checks = [
	['关掉时基础通道拿不到那一轮', !has(off.later, ANSWER_MARK)],
	['打开后追到那一轮', has(on.later, ANSWER_MARK)],
	['原有的行一条没被挪动', prefixKept],
	['追加落在末尾', atTail],
	['没有意图词就不追', !has(on.plain, ANSWER_MARK)],
	['只共享一个内容词的近轮进不来', !has(on.later, WEAK_MARK)],
	['无关查询的有序列表不受影响', strongSame]
];
console.log('\n[6] 结论\n');
let failed = 0;
for (const [name, ok] of checks) {
	if (!ok) failed++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}`);
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
