/**
 * 农历「差一天」的定点体检。
 *
 *   node bench-22/probe-lunar-drift.mjs
 *
 * 为什么单独一个探针：ICU 的农历和公布值差一天这件事**没有任何症状**——不抛异常、
 * 日志干净、日期看起来也合理，只是整体偏一天。`probe-festive-days.mjs` 只钉了
 * 春节这一族，正月里的其他日子曾经仍然查 `Intl`，于是 2027 年的「正月初九」一直
 * 差一天，而所有断言都是绿的。
 *
 * 钉四件事：
 *   1. **表本身**：2023–2035 的正月初一必须等于公布值；每个月首间隔只能是 29 或 30 天。
 *      （表是从香港天文台的逐日对照表生成的，这里用独立抄写的公布日期验收它。）
 *   2. **差在哪几年**：逐年在 `Intl` 里找正月初一，和公布值比。跑一遍就知道这张表
 *      不是洁癖——2023–2035 十三年里 `Intl` 错了两个（2027、2030）。
 *   3. **产品端（30 天的正月）**：2027 年正月初九在 02-14 出现、02-15 不出现；
 *      「正月三十」在 03-07 出现。
 *   4. **产品端（29 天的正月）**：2024 年正月只有二十九天，「正月三十」**哪一天都不许
 *      出现**——按「初一 + 29」算会刚好落在 03-10（二月初一），那是 0.2.67 用锚点算
 *      留下的代价，这一版按表查月长就没有了。
 *
 * 公布日期在这里**重新抄一遍**，不从 `lib/index.js` 引：探针的价值就在独立声明，
 * 引用被测对象自己的表等于自己证明自己。唯一读 `lib/index.js` 的地方是第 1 条——
 * 那里读的是**被测的数据**，验收标准仍然是外面抄来的那 13 个日期。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const BRIDGE = path.join(HERE, 'loom-bridge.mjs');
const LIB = path.join(HERE, '..', 'lib', 'index.js');

/** 官方正月初一（公历），2023–2035。独立抄写，不从 `lib/index.js` 引。 */
const PUBLISHED = {
	2023: '0122', 2024: '0210', 2025: '0129', 2026: '0217', 2027: '0206',
	2028: '0126', 2029: '0213', 2030: '0203', 2031: '0123', 2032: '0211',
	2033: '0131', 2034: '0219', 2035: '0208',
};

const ZONE = 'Asia/Shanghai';
const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', {
	timeZone: ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
});

let bad = 0;
const check = (label, ok, detail = '') => {
	if (!ok) bad += 1;
	console.log(`${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : `  ${detail}`}`);
};

// ── 1. 表本身：正月初一与月长 ───────────────────────────────────────────
const source = fs.readFileSync(LIB, 'utf8');
const at = source.indexOf('const LUNAR_MONTH_STARTS = {');
const body = at < 0 ? '' : source.slice(at, source.indexOf('\n};', at));
const table = new Map();
for (const row of body.matchAll(/(\d{4}): "([^"]+)"/gu)) {
	table.set(Number(row[1]), row[2].split(' ').map((one) => {
		const [head, mmdd] = one.split(':');
		return { month: Number(head.replace(/L$/u, '')), leap: head.endsWith('L'), mmdd };
	}));
}
check('源码里有月首表', table.size > 30, `${table.size} 年`);

const ord = (year, mmdd) => Date.UTC(year, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(2, 4)));
const springBad = [];
const gapBad = [];
for (const [year, months] of table) {
	const first = months.find((one) => one.month === 1 && !one.leap);
	if (PUBLISHED[year] !== void 0 && (first === void 0 || first.mmdd !== PUBLISHED[year])) springBad.push(`${year}: 表 ${first?.mmdd} / 公布 ${PUBLISHED[year]}`);
	for (let i = 1; i < months.length; i += 1) {
		const gap = (ord(year, months[i].mmdd) - ord(year, months[i - 1].mmdd)) / 864e5;
		if (gap !== 29 && gap !== 30) gapBad.push(`${year} ${months[i - 1].mmdd}→${months[i].mmdd}=${gap}`);
	}
}
check('表里 2023–2035 的正月初一都等于公布值', springBad.length === 0, springBad.join('；'));
check('表里每个月首间隔都是 29 或 30 天', gapBad.length === 0, gapBad.slice(0, 4).join('；'));

/** 这一年正月有几天（从表里算，不用 `Intl`）。 */
function firstMonthLength(year) {
	const months = table.get(year) ?? [];
	const i = months.findIndex((one) => one.month === 1 && !one.leap);
	if (i < 0 || months[i + 1] === void 0) return Number.NaN;
	return (ord(year, months[i + 1].mmdd) - ord(year, months[i].mmdd)) / 864e5;
}

// ── 2. 逐年的正月初一：`Intl` 和公布值差几天 ────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const drifted = [];
for (const [year, stamp] of Object.entries(PUBLISHED)) {
	const y = Number(year);
	let intl = null;
	/* 扫到三月中旬：春节最晚落在 02-20（1985 年是 02-20），45 天不够。 */
	for (let d = 1; d <= 75; d += 1) {
		const date = new Date(Date.UTC(y, 0, d));
		let month = '';
		let day = 0;
		for (const part of fmt.formatToParts(date.getTime())) {
			if (part.type === 'month') month = part.value;
			else if (part.type === 'day') day = Number(part.value);
		}
		if (month === '正月' && day === 1) {
			intl = `${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
			break;
		}
	}
	if (intl !== stamp) drifted.push(`${year}: Intl ${intl} / 公布 ${stamp}`);
}
console.log(`· Intl 与公布值不一致的年份：${drifted.length === 0 ? '无' : drifted.join('；')}`);
check('2027 是差一年的年份之一（这张表不是洁癖）', drifted.some((one) => one.startsWith('2027:')), drifted.find((one) => one.startsWith('2027:')) ?? '');
check('2030 也是', drifted.some((one) => one.startsWith('2030:')));

// ── 3 / 4. 产品端 ──────────────────────────────────────────────────────
const dueSection = (block) => {
	const cut = block.indexOf('【今天该做的事】');
	if (cut < 0) return '';
	const rest = block.slice(cut + '【今天该做的事】'.length);
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
		for (let cut = buf.indexOf('\n'); cut >= 0; cut = buf.indexOf('\n')) {
			const line = buf.slice(0, cut).trim();
			buf = buf.slice(cut + 1);
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
async function blockAt(turns, iso) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-lunar-'));
	const cli = bridge();
	try {
		await cli.rpc('open', {
			db: path.join(dir, 'loom.db'),
			workDir: dir,
			config: { timezone: ZONE, consolidation: { triggerTokens: 0 }, retrieval: { dueToday: true, dueTodayFestive: true } },
		});
		for (const t of turns) await cli.rpc('turn', { sid: 'M01', user: t.user, assistant: t.assistant, at: Date.parse(t.at) });
		return dueSection(String((await cli.rpc('block', { sid: 'M01', now: Date.parse(iso) })).text ?? ''));
	} finally {
		cli.close();
	}
}

const NINTH = /正月初九/u;
const THIRTY = /正月三十/u;

/* 2027：正月三十天。公布值正月初一 = 02-06，所以初九 = 02-14、三十 = 03-07。
 * `Intl` 认为初一 = 02-07，于是初九 = 02-15，且正月只有二十九天（三十不存在）。 */
const turns2027 = [
	{ at: '2026-11-12T09:10:00+08:00', user: '对了我爸的生日是农历正月初九，老家都过农历的，我得提前准备', assistant: '记下了，正月初九。' },
	{ at: '2026-11-12T09:20:00+08:00', user: '农历正月三十那天去把户口本取回来，派出所下午四点就不办了', assistant: '那我记那天。' },
	{ at: '2026-11-12T09:30:00+08:00', user: '今天先把图纸收一收，晚上回去再说', assistant: '好。' },
];
check('2027 年正月是三十天', firstMonthLength(2027) === 30, `${firstMonthLength(2027)} 天`);

const at14 = await blockAt(turns2027, '2027-02-14T12:00:00+08:00');
const at15 = await blockAt(turns2027, '2027-02-15T12:00:00+08:00');
const at13 = await blockAt(turns2027, '2027-02-13T12:00:00+08:00');
const at30 = await blockAt(turns2027, '2027-03-07T12:00:00+08:00');

check('正月初九：02-14 出现（公布值）', NINTH.test(at14));
check('正月初九：02-13 不出现', !NINTH.test(at13));
check('正月初九：02-15 不出现（`Intl` 会在这里出现）', !NINTH.test(at15));
check('正月三十：03-07 出现', THIRTY.test(at30));

/* 2024：正月只有二十九天（02-10 → 03-09，二月初一 03-10）。「正月三十」不存在，
 * 所以哪一天都不许出现——按「初一 + 29」算会正好落在 03-10 的二月初一。 */
const turns2024 = [
	{ at: '2023-11-12T09:10:00+08:00', user: '农历正月三十那天去把户口本取回来，派出所下午四点就不办了', assistant: '那我记那天。' },
	{ at: '2023-11-12T09:20:00+08:00', user: '今天先把图纸收一收，晚上回去再说', assistant: '好。' },
];
check('2024 年正月是二十九天', firstMonthLength(2024) === 29, `${firstMonthLength(2024)} 天`);

const phantom = await blockAt(turns2024, '2024-03-10T12:00:00+08:00');
const eve = await blockAt(turns2024, '2024-03-09T12:00:00+08:00');
check('正月三十（2024 年不存在）：03-10 不出现（按「初一 + 29」会在这里冒出来）', !THIRTY.test(phantom));
check('正月三十（2024 年不存在）：03-09（廿九）也不出现', !THIRTY.test(eve));

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条不符`);
process.exit(bad === 0 ? 0 : 1);
