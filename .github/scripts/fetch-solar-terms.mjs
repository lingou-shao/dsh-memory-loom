/**
 * 从香港天文台的逐日对照表生成「二十四节气」表。
 *
 *   node .github/scripts/fetch-solar-terms.mjs 2020 2060 > /tmp/terms.txt
 *
 * 为什么需要这张表：节气在公历上是**浮动**的（清明 4/4–4/6、冬至 12/21–12/23、
 * 立春 2/3–2/5），我们之前把它当固定日期——`FESTIVAL_SOLAR.清明 = [4, 5]`，
 * 而 2024、2025 的清明都在 4 月 4 日。差一天不会报错，只会让「清明前一天」算错。
 *
 * 数据来源与农历月首表同一个：`https://www.hko.gov.hk/en/gts/time/calendar/text/files/T{YYYY}e.txt`
 * 每年一份纯文本，逐日列出公历、农历、星期、节气。**逐行解析，不让模型读。**
 *
 * 校验四件（任何一条不过就退出码 1，不产出）：
 *   1. 每年必须正好 24 条，而且顺序与 `TERMS` 一致（小寒总在 1 月、冬至总在 12 月）；
 *   2. 每个节气必须落在它的常识窗口里（清明 4/4–4/6、冬至 12/21–12/23 等）；
 *   3. 打印清明不在 4/5 的年份——这就是固定日期错的那几年；
 *   4. 打印与 `lib/index.js` 里 `FESTIVAL_SOLAR` 固定值不一致的年份。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const LIB = path.join(HERE, '..', '..', 'lib', 'index.js');

const from = Number(process.argv[2] ?? 2020);
const to = Number(process.argv[3] ?? 2060);

/**
 * 节气在一年内的固定顺序，以及 HKO 用的英文名。
 *
 * 顺序是小寒起、冬至止——公历年内从头到尾，不是「立春起」。按公历排的好处是
 * 可以直接用「解析到的条数 = 下标」来核对顺序，不需要按名字查表。
 */
/** `[中文名, HKO 英文名, 月, 日下限, 日上限]`——上下限是**结构校验**，不是天文精度。 */
const TERMS = [
	['小寒', 'Moderate Cold', 1, 4, 8],
	['大寒', 'Severe Cold', 1, 18, 23],
	['立春', 'Spring Commences', 2, 2, 6],
	['雨水', 'Spring Showers', 2, 17, 21],
	['惊蛰', 'Insects Waken', 3, 4, 8],
	['春分', 'Vernal Equinox', 3, 19, 23],
	['清明', 'Bright & Clear', 4, 3, 7],
	['谷雨', 'Corn Rain', 4, 18, 22],
	['立夏', 'Summer Commences', 5, 4, 8],
	['小满', 'Corn Forms', 5, 19, 23],
	['芒种', 'Corn on Ear', 6, 4, 8],
	['夏至', 'Summer Solstice', 6, 19, 23],
	['小暑', 'Moderate Heat', 7, 5, 9],
	['大暑', 'Great Heat', 7, 21, 25],
	['立秋', 'Autumn Commences', 8, 6, 10],
	['处暑', 'End of Heat', 8, 21, 25],
	['白露', 'White Dew', 9, 6, 10],
	['秋分', 'Autumnal Equinox', 9, 21, 25],
	['寒露', 'Cold Dew', 10, 7, 11],
	['霜降', 'Frost', 10, 21, 25],
	['立冬', 'Winter Commences', 11, 6, 10],
	['小雪', 'Light Snow', 11, 20, 24],
	['大雪', 'Heavy Snow', 12, 5, 9],
	['冬至', 'Winter Solstice', 12, 20, 24],
];
const BY_EN = new Map(TERMS.map((one) => [one[1], one[0]]));

function parseYear(text, year) {
	const out = [];
	for (const line of text.split('\n')) {
		const head = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(.*)$/u.exec(line.trim());
		if (head === null || Number(head[1]) !== year) continue;
		const cells = head[4].trim().split(/\s{2,}/).map((one) => one.trim()).filter(Boolean);
		/* 有节气的行是「农历日 星期 节气」三段；没节气的行只有两段。 */
		if (cells.length < 3) continue;
		const name = BY_EN.get(cells.at(-1));
		if (name === void 0) continue;
		out.push({
			name,
			mmdd: `${head[2].padStart(2, '0')}${head[3].padStart(2, '0')}`
		});
	}
	return out;
}

/** `lib/index.js` 里现有的固定公历节日，用来量化「固定值错在哪几年」。 */
function fixedSolar() {
	const text = readFileSync(LIB, 'utf8');
	const at = text.indexOf('const FESTIVAL_SOLAR = {');
	const end = text.indexOf('};', at);
	const out = new Map();
	for (const match of text.slice(at, end).matchAll(/([\u4e00-\u9fa5]+):\s*\[(\d+),\s*(\d+)\]/gu)) {
		out.set(match[1], `${String(match[2]).padStart(2, '0')}${String(match[3]).padStart(2, '0')}`);
	}
	return out;
}

const fixed = fixedSolar();
const rows = [];
const bad = [];
const notOnFifth = [];
const differsFromFixed = [];
let total = 0;

for (let year = from; year <= to; year += 1) {
	const url = `https://www.hko.gov.hk/en/gts/time/calendar/text/files/T${year}e.txt`;
	const response = await fetch(url);
	if (response.status !== 200) {
		bad.push(`${year}: HTTP ${response.status}`);
		continue;
	}
	const list = parseYear(await response.text(), year);
	if (list.length !== 24) {
		bad.push(`${year}: 解析出 ${list.length} 个节气（应为 24）`);
		continue;
	}
	/* ① 顺序必须与 `TERMS` 一致。 */
	for (let i = 0; i < 24; i += 1) {
		if (list[i].name !== TERMS[i][0]) {
			bad.push(`${year}: 第 ${i + 1} 个是「${list[i].name}」，按顺序应是「${TERMS[i][0]}」`);
			break;
		}
		/* ② 落在常识窗口里。 */
		const [, , month, low, high] = TERMS[i];
		const gotMonth = Number(list[i].mmdd.slice(0, 2));
		const gotDay = Number(list[i].mmdd.slice(2, 4));
		if (gotMonth !== month || gotDay < low || gotDay > high) {
			bad.push(`${year} ${TERMS[i][0]}: ${list[i].mmdd} 不在 ${month} 月 ${low}–${high} 日`);
		}
	}
	rows.push({ year, list });
	total += list.length;

	const qingming = list.find((one) => one.name === '清明');
	if (qingming !== void 0 && qingming.mmdd !== '0405') notOnFifth.push(`${year}:04-${qingming.mmdd.slice(2)}`);
	/* ④ 与现有固定值比：只比名字对得上的（清明现在写的是 [4, 5]）。 */
	for (const [name, mmdd] of fixed) {
		const got = list.find((one) => one.name === name);
		if (got !== void 0 && got.mmdd !== mmdd) differsFromFixed.push(`${year} ${name}: 表里 ${got.mmdd}，固定值 ${mmdd}`);
	}
}

if (bad.length > 0) {
	console.error(`✗ ${bad.length} 处不符：`);
	for (const one of bad.slice(0, 20)) console.error(`  ${one}`);
	process.exit(1);
}

console.log(`/* 二十四节气（公布值，香港天文台），${from}–${to}。`);
console.log(' * 由 .github/scripts/fetch-solar-terms.mjs 生成，别手改。');
console.log(' * 每天一个 MMDD，空格分隔，顺序固定为 SOLAR_TERM_NAMES。 */');
console.log('const SOLAR_TERM_NAMES = [' + TERMS.map((one) => `"${one[0]}"`).join(', ') + '];');
console.log('const SOLAR_TERMS = {');
for (const row of rows) console.log(`\t${row.year}: "${row.list.map((one) => one.mmdd).join(' ')}",`);
console.log('};');

console.error(`· ${rows.length} 年 ${total} 个节气`);
console.error(`· 清明不在 4 月 5 日的年份 ${notOnFifth.length} 个：${notOnFifth.join('、')}`);
console.error(`· 与固定值不一致 ${differsFromFixed.length} 处：${differsFromFixed.slice(0, 6).join('；')}`);
