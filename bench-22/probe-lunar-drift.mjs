/**
 * 农历「差一天」的定点体检。
 *
 *   node bench-22/probe-lunar-drift.mjs
 *
 * 为什么单独一个探针：ICU 的农历和公布值差一天这件事**没有任何症状**——不抛异常、
 * 日志干净、日期看起来也合理，只是整体偏一天。`probe-festive-days.mjs` 只钉了
 * 春节这一族（走公布表），正月里的其他日子仍然查 `Intl`，所以 2027 年的「正月初九」
 * 一直是差一天的，而所有断言都是绿的。
 *
 * 钉三件事：
 *   1. **差在哪几年**：逐年在 `Intl` 里找正月初一，和公布日期表比。跑一遍就知道
 *      这张表不是洁癖——2020–2035 十六年里 `Intl` 错两个（2027、2030）。
 *   2. **月长只能是 29 或 30**：`Intl` 反查出来的农历月如果出现 28 或 31 天，
 *      就是「朔」被判到了隔壁那天，属于必须修的一类。这一条能在**没有公布表**的
 *      年份上也报警。
 *   3. **产品端**：2027 年的「正月初九」在 02-14 出现、02-15 不出现；
 *      「正月三十」在 03-07 出现（`Intl` 认为 2027 年正月只有二十九天，这一天在
 *      它的表里根本不存在）。两条都指向同一件事：正月这一段必须走公布表。
 *
 * 公布日期不写在代码里引用，而是在这里**重新抄一遍**：探针的价值就在独立声明，
 * 引用被测对象自己的表等于自己证明自己。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const BRIDGE = path.join(HERE, 'loom-bridge.mjs');

/** 官方正月初一（公历），2023–2035。独立抄写，不从 `lib/index.js` 引。 */
const PUBLISHED = {
	2023: '01-22', 2024: '02-10', 2025: '01-29', 2026: '02-17', 2027: '02-06',
	2028: '01-26', 2029: '02-13', 2030: '02-03', 2031: '01-23', 2032: '02-11',
	2033: '01-31', 2034: '02-19', 2035: '02-08',
};

const ZONE = 'Asia/Shanghai';
const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
	timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
});
const pad = (n) => String(n).padStart(2, '0');

/** 某一天在 `Intl` 眼里是农历几月几日（闰月原样返回月名）。 */
function lunarOf(y, m, d) {
	const at = Date.UTC(y, m - 1, d, 4);
	let month = '';
	let day = 0;
	let year = 0;
	for (const part of fmt.formatToParts(at)) {
		if (part.type === 'month') month = part.value;
		else if (part.type === 'day') day = Number(part.value);
		else if (part.type === 'year') year = Number(part.value.replace(/[^\d]/gu, ''));
	}
	return { month, day, year };
}

let bad = 0;
const check = (label, ok, detail = '') => {
	if (!ok) bad += 1;
	console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`);
};

// ── 1. 逐年的正月初一：`Intl` 和公布值差几天 ────────────────────────────
const drifted = [];
for (const [year, stamp] of Object.entries(PUBLISHED)) {
	const y = Number(year);
	let intl = null;
	/* 扫到三月中旬：春节最晚落在 02-20（1985 年是 02-20），45 天不够。 */
	for (let d = 1; d <= 75; d += 1) {
		const date = new Date(Date.UTC(y, 0, d));
		const probe = lunarOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
		if (probe.month === '正月' && probe.day === 1) {
			intl = `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
			break;
		}
	}
	if (intl !== stamp) drifted.push(`${year}: Intl ${intl} / 公布 ${stamp}`);
}
console.log(`· Intl 与公布值不一致的年份：${drifted.length === 0 ? '无' : drifted.join('；')}`);
check('2027 是差一年的年份之一（这张公布表不是洁癖）', drifted.some((one) => one.startsWith('2027:')), drifted.find((one) => one.startsWith('2027:')) ?? '');
check('2030 也是', drifted.some((one) => one.startsWith('2030:')));

// ── 2. 月长只能是 29 或 30 ──────────────────────────────────────────────
const starts = [];
for (let ts = Date.UTC(2023, 0, 1); ts <= Date.UTC(2035, 11, 31); ts += 864e5) {
	const date = new Date(ts);
	const probe = lunarOf(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
	if (probe.day === 1) starts.push({ ts, month: probe.month });
}
const gaps = [];
for (let i = 1; i < starts.length; i += 1) gaps.push((starts[i].ts - starts[i - 1].ts) / 864e5);
/* 闰月在我们的表里查不到月名，那一段会直接跳过，所以跨度可以到 58–60 天。 */
const weird = gaps.filter((one) => one !== 29 && one !== 30 && one !== 58 && one !== 59 && one !== 60);
check('2023–2035 每个月都是 29 或 30 天（闰月跳过的那段除外）', weird.length === 0, weird.length === 0 ? '' : `异常跨度 ${weird.slice(0, 6).join('/')}`);

// ── 3. 产品端：正月的其他日子 ───────────────────────────────────────────
const TURNS = [
	{ at: '2026-11-12T09:10:00+08:00', user: '对了我爸的生日是农历正月初九，老家都过农历的，我得提前准备', assistant: '记下了，正月初九。' },
	{ at: '2026-11-12T09:20:00+08:00', user: '农历正月三十那天去把户口本取回来，派出所下午四点就不办了', assistant: '那我记那天。' },
	{ at: '2026-11-12T09:30:00+08:00', user: '今天先把图纸收一收，晚上回去再说', assistant: '好。' },
];

const dueSection = (block) => {
	const at = block.indexOf('【今天该做的事】');
	if (at < 0) return '';
	const rest = block.slice(at + '【今天该做的事】'.length);
	const next = rest.indexOf('【');
	return next < 0 ? rest : rest.slice(0, next);
};

function bridge() {
	const proc = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] });
	let seq = 0;
	let buf = '';
	const waiting = new Map();
	proc.stdout.setEncoding('utf8');
	proc.stdout.on('data', (chunk) => {
		buf += chunk;
		for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
			const line = buf.slice(0, at).trim();
			buf = buf.slice(at + 1);
			if (!line) continue;
			const msg = JSON.parse(line);
			const slot = waiting.get(msg.id);
			if (slot === undefined) continue;
			waiting.delete(msg.id);
			if (msg.ok === false) slot.reject(new Error(msg.error));
			else slot.resolve(msg);
		}
	});
	return {
		rpc(op, payload = {}) {
			const id = (seq += 1);
			proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
			return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
		},
		close() {
			proc.stdin.end();
		},
	};
}

/** 一次运行只问一个时刻：块按会话缓存，同一实例连问两个时刻会拿到第一份。 */
async function blockAt(iso) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lunar-'));
	const cli = bridge();
	try {
		await cli.rpc('open', {
			db: path.join(dir, 'loom.db'),
			workDir: dir,
			config: { timezone: ZONE, consolidation: { triggerTokens: 0 }, retrieval: { dueToday: true, dueTodayFestive: true } },
		});
		for (const t of TURNS) await cli.rpc('turn', { sid: 'M01', user: t.user, assistant: t.assistant, at: Date.parse(t.at) });
		return dueSection(String((await cli.rpc('block', { sid: 'M01', now: Date.parse(iso) })).text ?? ''));
	} finally {
		cli.close();
	}
}

const NINTH = /正月初九/u;
const THIRTY = /正月三十/u;

/* 公布值：2027 年正月初一 = 02-06，所以初九 = 02-14，三十 = 03-07。
 * `Intl` 认为初一 = 02-07，于是初九 = 02-15，且正月只有二十九天（三十不存在）。 */
const at14 = await blockAt('2027-02-14T12:00:00+08:00');
const at15 = await blockAt('2027-02-15T12:00:00+08:00');
const at13 = await blockAt('2027-02-13T12:00:00+08:00');
const at30 = await blockAt('2027-03-07T12:00:00+08:00');

check('正月初九：02-14 出现（公布值）', NINTH.test(at14));
check('正月初九：02-13 不出现', !NINTH.test(at13));
check('正月初九：02-15 不出现（`Intl` 会在这里出现，这条红就是正月没走公布表）', !NINTH.test(at15));
check('正月三十：03-07 出现（`Intl` 的表里没有这一天）', THIRTY.test(at30));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条不符`);
process.exit(bad === 0 ? 0 : 1);
