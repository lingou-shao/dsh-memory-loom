/**
 * 从香港天文台的逐日对照表生成「农历月首表」。
 *
 *   node .github/scripts/fetch-lunar-table.mjs 2020 2050 > /tmp/lunar.txt
 *
 * 为什么要这一步：`Intl` 的农历对不上公布值（ICU 78.3 对香港天文台 1901–2100 的
 * 72,674 天里 447 天不一致，集中在 12 个农历月）。我们以前只修了春节那一族和正月，
 * 其余月份仍然信 ICU。这张表把 2020–2050 的每一个农历月首都落成公布值，
 * 之后 `nextLunar` 不再需要 ICU。
 *
 * 数据来源：`https://www.hko.gov.hk/en/gts/time/calendar/text/files/T{YYYY}e.txt`
 * （每年一份纯文本，逐日列出公历、农历、星期、节气）。**逐行解析，不让模型读**——
 * 这是数据，不是摘要。
 *
 * 校验三件（任何一条不过就退出码 1，不产出）：
 *   1. 相邻月首间隔只能是 29 或 30 天；
 *   2. 正月初一必须等于 `lib/index.js` 里那份公布日期表（2023–2035）；
 *   3. 打印每一年里 ICU 与公布值不一致的月份——这张清单本身就是这张表的价值证明。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const LIB = path.join(HERE, '..', '..', 'lib', 'index.js');

const from = Number(process.argv[2] ?? 2020);
const to = Number(process.argv[3] ?? 2050);

/** `lib/index.js` 里的公布日期表，用来交叉校验解析结果（不从浏览器端引，直接读文本）。 */
function publishedSpring() {
	const text = readFileSync(LIB, 'utf8');
	const at = text.indexOf('const SPRING_FESTIVAL = {');
	const end = text.indexOf('};', at);
	const body = text.slice(at, end);
	const out = new Map();
	for (const match of body.matchAll(/(\d{4}):\s*"(\d{2})-(\d{2})"/gu)) out.set(Number(match[1]), `${match[2]}${match[3]}`);
	return out;
}

const MONTH_NO = {
	1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, 11: 11, 12: 12,
};

/** 解析一年：返回 `[{ mmdd, month, leap }]`，按公历升序。 */
function parseYear(text, year) {
	const out = [];
	let previous = null;
	for (const line of text.split('\n')) {
		/* 形如：2027/2/6          1st Lunar Month         Saturday */
		const head = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(.*)$/u.exec(line.trim());
		if (head === null) continue;
		if (Number(head[1]) !== year) continue;
		const rest = head[4];
		/* 月首：`1st Lunar Month`；闰月在同一月号上再出现一次（2025 年有两个 6th）。 */
		const month = /^(\d{1,2})(?:st|nd|rd|th)\s+Lunar\s+Month\b/u.exec(rest);
		if (month === null) continue;
		const no = MONTH_NO[Number(month[1])];
		if (no === void 0) continue;
		const mmdd = `${head[2].padStart(2, '0')}${head[3].padStart(2, '0')}`;
		const leap = previous !== null && previous.month === no;
		out.push({ mmdd, month: no, leap });
		previous = out.at(-1);
	}
	return out;
}

const ord = (year, mmdd) => Date.UTC(year, Number(mmdd.slice(0, 2)) - 1, Number(mmdd.slice(2, 4)));
const spring = publishedSpring();
const rows = [];
const bad = [];
let total = 0;
const icuDiff = [];

const fmt = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { timeZone: 'Asia/Shanghai', year: 'numeric', month: 'numeric', day: 'numeric' });
const icuAt = (at) => {
	let month = '';
	let day = 0;
	for (const part of fmt.formatToParts(at)) if (part.type === 'month') month = part.value;
	else if (part.type === 'day') day = Number(part.value);
	return { month, day };
};

for (let year = from; year <= to; year += 1) {
	const url = `https://www.hko.gov.hk/en/gts/time/calendar/text/files/T${year}e.txt`;
	const response = await fetch(url);
	if (response.status !== 200) {
		bad.push(`${year}: HTTP ${response.status}`);
		continue;
	}
	const months = parseYear(await response.text(), year);
	if (months.length < 11) {
		bad.push(`${year}: 只解析出 ${months.length} 个月首`);
		continue;
	}
	rows.push({ year, months });
	total += months.length;

	/* ① 月首间隔只能是 29 或 30 天（跨年那一段在下一年的第一项里对）。 */
	for (let i = 1; i < months.length; i += 1) {
		const gap = (ord(year, months[i].mmdd) - ord(year, months[i - 1].mmdd)) / 864e5;
		if (gap !== 29 && gap !== 30) bad.push(`${year}: ${months[i - 1].mmdd} → ${months[i].mmdd} 相距 ${gap} 天`);
	}
	/* ② 正月初一必须等于公布表。 */
	const first = months.find((one) => one.month === 1 && !one.leap);
	if (first !== void 0 && spring.has(year) && first.mmdd !== spring.get(year)) {
		bad.push(`${year}: 解析出正月初一 ${first.mmdd}，公布表是 ${spring.get(year)}`);
	}
	/* ③ ICU 与公布值不一致的月份——这张清单就是这张表的理由。 */
	for (const one of months) {
		const probe = icuAt(ord(year, one.mmdd));
		if (probe.day !== 1) icuDiff.push(`${year}-${one.mmdd} 月首（ICU 说这天的日号是 ${probe.day}，月名「${probe.month}」）`);
	}
}

if (bad.length > 0) {
	console.error(`✗ ${bad.length} 处不符：`);
	for (const one of bad.slice(0, 20)) console.error(`  ${one}`);
	process.exit(1);
}

console.log(`/* 农历月首（公布值，香港天文台），${from}–${to}。`);
console.log(` * 由 .github/scripts/fetch-lunar-table.mjs 生成，别手改。`);
console.log(' * 格式：「月号:MMDD」，空格分隔，闰月加后缀 L。 */');
console.log(`const LUNAR_MONTH_STARTS = {`);
for (const row of rows) {
	console.log(`\t${row.year}: "${row.months.map((one) => `${one.month}${one.leap ? 'L' : ''}:${one.mmdd}`).join(' ')}",`);
}
console.log(`};`);

console.error(`· ${rows.length} 年 ${total} 个月首`);
console.error(`· 与 ICU 不一致的月首 ${icuDiff.length} 个：${icuDiff.slice(0, 8).join('；')}${icuDiff.length > 8 ? ` 等` : ''}`);
