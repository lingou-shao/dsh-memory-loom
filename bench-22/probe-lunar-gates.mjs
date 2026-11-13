/**
 * 农历 / 节日 / 节气的**闸门矩阵**。
 *
 *   node bench-22/probe-lunar-gates.mjs
 *
 * 和另外两个日期探针的分工：
 *   - `probe-festive-days.mjs` 管**日期对不对**（春节族、除夕、元宵）；
 *   - `probe-lunar-drift.mjs` 管**表对不对**（公布值、月长、ICU 差一天）；
 *   - 这一个管**认不认**：同一个词在四种语境下该不该产出一个日期。
 *
 * 为什么要单独一张矩阵：`docs/design.md` §101.7 记过一个病——`probe-festive-days`
 * 十一条断言全绿，而产品的正月整段错了一天。原因是那张探针钉的全是日期，没有一条
 * 钉「什么语境下**不该**出日期」。这正是 Duckling 把 **negative corpus** 和正向语料
 * 并列的原因：只断言「该认的认了」，挡不住「不该认的也认了」。
 *
 * 期望值只写**形状**（`day` / `window` / `none`），不写具体日期——日期归上面两张
 * 探针。这样这一张不依赖产品的日期表，重构它也不会跟着动。
 */
import { parseDue } from '../lib/index.js';

const ZONE = 'Asia/Shanghai';
const BASE = Date.parse('2026-11-13T10:00:00+08:00');
const BASE_TEXT = '2026-11-13';

let bad = 0;
let good = 0;
const check = (name, actual, expect) => {
	if (actual === expect) {
		good += 1;
		console.log(`✓ ${name}`);
	} else {
		bad += 1;
		console.log(`✗ ${name}  得到 ${actual}，应为 ${expect}`);
	}
};
const ymd = (ts) => new Intl.DateTimeFormat('sv-SE', {
	timeZone: ZONE,
	dateStyle: 'short'
}).format(new Date(ts));
/** 结果的**形状**：`none` / `day` / `window`。 */
const shape = (hit) => {
	if (hit === void 0 || hit === null) return 'none';
	return hit.precision === 'window' ? 'window' : 'day';
};
const ask = (text) => parseDue(text, BASE, ZONE, { festive: true });

/**
 * 歧义大的节气。这里**独立抄一遍**，不从 `lib/index.js` 引 `SOLAR_TERM_WEAK`——
 * 引用被测对象自己的词表，等于用它的答案验收它自己。
 */
const AMBIGUOUS = ['雨水', '小满', '白露', '小雪', '大雪'];

/** 矩阵本体。第一列是组名，后面是 `[句子, 期望形状]`。 */
const MATRIX = [
	['节气 · 有日期语境', [
		['冬至那天包饺子', 'day'],
		['霜降前后收白菜', 'day'],
		['夏至这天', 'day'],
		['立春当天', 'day'],
	]],
	['节气 · 有未来指向', [
		['冬至快到了', 'day'],
		['立春要早点睡', 'day'],
		['清明要回去', 'day'],
	]],
	['节气 · 只说这句话（评价）', [
		['冬至的饺子真难吃', 'none'],
		['立春了还是冷', 'none'],
		['霜降了', 'none'],
	]],
	['过去指向（整句级闸门）', [
		['去年冬至在老家', 'none'],
		['上次清明没回', 'none'],
		['刚过完冬至', 'none'],
		['去年春节在老家', 'none'],
		['那次中秋没回去', 'none'],
	]],
	['节日 · 有未来指向', [
		['中秋得加班', 'day'],
		['七夕快到了', 'day'],
		['劳动节要回老家', 'day'],
	]],
	['节日 · 有日期语境', [
		['中秋那天回不来', 'day'],
		['春节当天值班', 'day'],
		['七夕那天吃饭', 'day'],
	]],
	['节日 · 有日期语境但说的是过去', [
		['中秋那天霜霜特意请了晚班的假', 'none'],
	]],
	['节日 · 闲话与评价', [
		['国庆的机票真贵', 'none'],
		['端午包粽子', 'none'],
		/* 「前后」在这个词上是范围，不认——这是 `TERM_DAY_MARK_STRICT` 存在的理由。 */
		['中秋前后堵车', 'none'],
	]],
	['节前 · 窗口', [
		['春节前三天给答复', 'window'],
		['清明前三天回去', 'window'],
		['国庆前一周出发', 'window'],
	]],
	['节前 · 跨度越界', [
		['春节前两个月', 'none'],
	]],
	['农历字面量', [
		['腊月二十八我要回娘家', 'day'],
		['八月十五回家', 'day'],
		['农历十二月廿三', 'day'],
		['腊月三十贴春联', 'day'],
	]],
];

console.log(`基准日 ${BASE_TEXT} · 时区 ${ZONE}\n`);
for (const [group, items] of MATRIX) {
	console.log(`── ${group} ──`);
	for (const [text, expect] of items) check(`「${text}」→ ${expect}`, shape(ask(text)), expect);
	console.log('');
}

/*
* 歧义节气：每一个词都必须在「非语境」下闭嘴、「带语境」下开口。
*
* 这一组是**生成**的，不是手写的四条，理由：手写会漏词（`probe-festive-days`
* 只钉了春节族，正月就整段是黑洞）。词表独立抄在文件头，循环自己保证覆盖。
*/
console.log('── 歧义节气 · 逐个词的两种语境 ──');
for (const word of AMBIGUOUS) {
	check(`「${word}」无语境 → 不认`, shape(ask(`${word}这个人挺有意思`)), 'none');
	check(`「${word}」带「那天」→ 认`, shape(ask(`${word}那天回老家`)), 'day');
}
console.log('');

/*
* 公历月日不许被读成农历。
*
* 「三月十五号」曾经被读成农历三月初十（差五天）：正则先匹配「十五」、被后面的
* 「号」挡回，引擎退一格匹配「十」，这时后面是「五」而不是「号」，断言通过。
*
* 这一组用「十二月」是故意的：**同一个「十二月二十八」，带不带「号」是两个答案**。
* 带「号」是公历 12-28，不带「号」是农历腊月二十八（2027-02-04）。农历那一侧
* 由下面「农历字面量」组钉，这里钉公历这一侧。
*
* 日期都在**到期窗口内**。窗口外 `parseDue` 会返回空——实测基准日 2026-11-13 时
* 「1月15号」解得出、「2月15号」解不出，边界在九十天上下。这不是解析能力，
* 所以别拿远期日期测解析（第一版探针就写成了 2027-03-15，红了两条假失败）。
*/
console.log('── 公历月日不被读成农历（带「号」= 公历）──');
for (const [text, expect] of [
	['十二月二十号交表', '2026-12-20'],
	['十二月二十八号', '2026-12-28'],
]) {
	const hit = ask(text);
	check(`「${text}」→ ${expect}`, hit === void 0 ? 'none' : ymd(hit.from), expect);
}
console.log('');

console.log(`\n通过 ${good} · 不符 ${bad}`);
process.exit(bad === 0 ? 0 : 1);
