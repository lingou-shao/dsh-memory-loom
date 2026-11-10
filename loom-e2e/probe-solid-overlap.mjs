/**
 * 闸门的第三条旁路：共享 3 个内容词就该放行，而且只能加在末尾。
 *
 * `relaxMinOverlap`（0.25）的分母是**整句问句**的二元组。真人怎么问问题这件事
 * 不受控：同一件事，问句一长，共享同样多的实词就越过不了线。这个探针钉住两件事：
 *
 *   1. 一道「长问句 + 3 个实词共享 + 比例 0.18」的题，关掉旁路时搜不到、打开时搜得到。
 *   2. 放行进来的行**只追加在末尾**，前面那几行一个字都不许动。
 *
 * 第二件事比第一件重要。旁路刚做出来时参与排序，分数量纲不同，把 `memory_expand`
 * 要展开的前两条指针换掉了——那不是"召回变好"，是把已经在眼前的东西挪走了。
 *
 * 另配两条反向断言：
 *   - 只共享 2 个内容词的行仍然进不来（门槛就是门槛）；
 *   - 与题目无关的强命中查询，两次运行的有序列表逐字相同。
 *
 *   node loom-e2e/probe-solid-overlap.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-solid-overlap';

/** 目标：共享 3+ 个内容词，但占问句二元组不到 0.25。 */
const TARGET = '我在街道办是做合同工的，跟编制内不一样，工资差一半';
const TARGET_MARK = '合同工';
/**
 * 长问句：把「街道办 / 合同工 / 编制内 / 工资」都问到，但用足够多的框词把比例稀释掉。
 * 这就是线上真实形态——§70.4 量过的那七道题也是这个形状。
 *
 * 坑：`compileMatch` 只取问句**前 24 个**二元组，关键词写在后面就等于没问
 * （README §3 的「十二个二元组」那条取舍）。第一版这句把「街道」放在第 40 个字上，
 * 于是目标事实连候选都没进——探针测到的不是旁路，是表达式截断。所以关键词必须靠前，
 * 稀释靠句尾的框词。
 */
const LONG_QUERY = '你还记得吧，我在街道办的合同工身份跟编制内到底差哪些，那天我们聊到很晚的，工资差多少来着，你还提了别的很多事，这些我都有点记不清了，你帮我想一想';
/** 只共享「街道 / 道办」两个内容词：旁路不该放它进来。 */
const WEAK_ROW = '街道办上周在群里发了通知，让各科室报名';
const WEAK_QUERY = '街道办那事儿后来怎么说的，你还记得不，那天我们其实聊了很多别的东西来着';
/**
 * 框词行：与问句共享一大串**框词**（那天 / 聊到很晚 / 你还提了 / 帮我想想），
 * 比例轻松过 0.25，所以它本来就该被返回。它的作用是把「旁路行只追加」变成真检验：
 * 关掉旁路时结果里就它一条，打开后它必须还在第一位，目标行追加在它后面。
 *
 * 这条也正是 §70.4 说的那件事的现场演示——比例判据奖励的是「问句怎么说」，
 * 不是「问的是哪件事」。
 */
const FRAME_ROW = '你还记得吧，那天我们聊到很晚，你还提了别的很多事，这些我都有点记不清了，你帮我想一想';
/** 强命中用：与目标完全无关，只验证「前面的行没被挪动」。 */
const STRONG_ROW = '用户的降噪耳机左耳接触不良，打算换一副';
const STRONG_QUERY = '降噪耳机左耳接触不良';

/** 24 条干扰项，把冷启动的近因通道挤掉。 */
const DISTRACTORS = [
	'用户参加过一次数学建模比赛，拿了省二等奖',
	'用户在为考研做准备，专业课选了数据结构',
	'用户家里有一台半自动咖啡机，喜欢浅烘豆子',
	'用户学过两年吉他，只会弹几首民谣',
	'用户喜欢拍胶片，手上有台奥林巴斯',
	'用户每周跑三次五公里，配速六分左右',
	'用户去年瘦了八公斤，靠控制晚饭',
	'用户租的房子在地铁终点站，通勤四十分钟',
	'用户的房东不肯换热水器，冬天很难受',
	'用户考过六级，听力分数一般',
	'用户的论文查重率降到了百分之八',
	'用户想换一台二十七寸的显示器',
	'用户收藏了一块机械表，舍不得日常戴',
	'用户的移动硬盘里有十几年的照片备份',
	'用户家的路由器放在客厅角落，卧室信号差',
	'用户的洗衣机甩干时有异响，打算报修',
	'用户习惯把包裹放在楼下驿站，懒得送上楼',
	'用户办过一张储蓄卡，专门用来存旅行基金',
	'用户的医保卡绑在了手机小程序上',
	'用户的身份证快到期了，得回户籍地换',
	'用户不喜欢吃甜的，奶茶永远点无糖',
	'用户睡觉前一定要把手机调成飞行模式',
	'用户的书桌对着窗户，下午光线正好',
	'用户把旧手机给了弟弟，自己换了新的'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 二元组集合，只用于把「比例」和「共享个数」两列打出来。 */
function bigrams(text) {
	const set = new Set();
	for (const run of text.matchAll(/[\p{Script=Han}]+/gu)) {
		const chars = [...run[0]];
		for (let index = 0; index < chars.length - 1; index++) set.add(`${chars[index]}${chars[index + 1]}`);
	}
	return set;
}
/** 这条问句与这条记忆的共享二元组个数，以及占问句的比例（就是闸门算的那个数）。 */
function share(query, row) {
	const need = bigrams(query);
	const have = bigrams(row);
	let shared = 0;
	for (const token of need) if (have.has(token)) shared++;
	return { shared, ratio: need.size === 0 ? 0 : shared / need.size };
}

/** 从搜索结果里取出 `#F12` 这样的指针，用来比顺序。 */
const refsOf = (text) => [...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]);

async function runArm(solid) {
	const dir = mkdtempSync(join(tmpdir(), `loom-solid-${solid}-`));
	const loom = createLoom({
		dbPath: join(dir, 'loom.db'),
		// 整合必须关：它会把探针自己的问句折成新事实。
		config: { consolidation: { enabled: false }, retrieval: { solidOverlap: solid } }
	});
	try {
		for (const text of [TARGET, WEAK_ROW, FRAME_ROW, STRONG_ROW, ...DISTRACTORS]) {
			await loom.call('memory_write', { text }, SESSION);
			await sleep(3);
		}
		const search = async (query) => String(await loom.call('memory_search', { query, limit: 10 }, SESSION));
		return { long: await search(LONG_QUERY), weak: await search(WEAK_QUERY), strong: await search(STRONG_QUERY) };
	} finally {
		loom.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
}

const off = await runArm(0);
const on = await runArm(3);

const has = (text, mark) => String(text).includes(mark);
const offRefs = refsOf(off.long);
const onRefs = refsOf(on.long);
/* 纯追加的判据：off 的整条有序列表，是 on 那条列表的前缀。 */
const prefixKept = offRefs.every((ref, index) => onRefs[index] === ref);
const appended = onRefs.slice(offRefs.length);

console.log('[1] 长问句 + 3 个实词共享（比例 0.18，过不了 0.25）\n');
const longShare = share(LONG_QUERY, TARGET);
console.log(`  这道题：共享 ${longShare.shared} 个二元组 / 问句 ${bigrams(LONG_QUERY).size} 个 = ${longShare.ratio.toFixed(3)}`);
console.log(`  solidOverlap=0   ${has(off.long, TARGET_MARK) ? '× 仍然命中' : '· 搜不到（闸门挡着）'}`);
console.log(`  solidOverlap=3   ${has(on.long, TARGET_MARK) ? '· 搜到' : '× 还是搜不到'}`);
console.log(`  指针 0 版 ${offRefs.length} 条 → 3 版 ${onRefs.length} 条，追加 ${appended.length} 条：${appended.join(' ') || '无'}`);

console.log('\n[2] 放行进来的行只在末尾\n');
console.log(`  前面 ${offRefs.length} 条逐位相同：${prefixKept ? '· 是' : '× 被挪动了'}`);
/* 目标那一行必须落在原列表之后——它不能插到中间去。 */
const targetLine = on.long.split('\n').findIndex((line) => line.includes(TARGET_MARK));
const targetAtTail = targetLine >= 0 && (offRefs.length === 0 || refsOf(on.long.split('\n').slice(0, targetLine + 1).join('\n')).length > offRefs.length);
console.log(`  目标行落在第 ${targetLine + 1} 行（原列表 ${offRefs.length} 条之后）：${targetAtTail ? '· 是' : '× 不是'}`);

console.log('\n[3] 反向：只共享 2 个内容词的行仍然进不来\n');
const weakOn = on.weak.split('\n').findIndex((line) => line.includes('街道办上周'));
console.log(`  solidOverlap=3   弱行位置 ${weakOn === -1 ? '不在结果里 · 正确' : `第 ${weakOn} 行 × 漏了`}`);

console.log('\n[4] 无关的强命中查询：两次运行有序列表逐字相同\n');
const strongOff = refsOf(off.strong);
const strongOn = refsOf(on.strong);
const strongSame = strongOff.join(',') === strongOn.join(',');
console.log(`  ${strongSame ? '· 相同' : '× 不同'}  ${strongOff.join(' ') || '（空）'}`);

const checks = [
	['关掉旁路时这道题搜不到', !has(off.long, TARGET_MARK), ''],
	['默认门槛（3）能把它放进来', has(on.long, TARGET_MARK), ''],
	['原有的行一条没被挪动', prefixKept, ''],
	['只共享 2 个内容词仍然进不来', weakOn === -1, ''],
	['无关查询的有序列表不受影响', strongSame, '']
];
console.log('\n[5] 结论\n');
let failed = 0;
for (const [name, ok, extra] of checks) {
	if (!ok) failed++;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${extra === '' ? '' : ` — ${extra}`}`);
}
console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
