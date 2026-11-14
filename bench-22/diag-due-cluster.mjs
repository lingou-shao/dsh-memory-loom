/**
 * 到期区的名额有没有被「同一件事说了几遍」吃掉。
 *
 * M01-G019 那天（2026-11-05 下午）同一件事说了五遍，提前量都是 3 天，两个名额
 * 发给了一句「要不要喊上谁」和一句「该带点啥」，唯一带「看到底开不开」的那句
 * 出局。这脚本回答两个问题：
 *
 *   ① 这种「同一天、同一件事、多句候选」的日期有多少；
 *   ② 按现在的排序，两个名额里有没有两条来自同一簇（= 名额被重复句吃掉）。
 *
 * 判据是诊断用的，不是产品的：同 session + 同 due 日期 + 共享 ≥2 个实词二元组。
 * 产品里要不要用这套判据，得看这里的量和 714/62 的读数。
 *
 *   node bench-22/diag-due-cluster.mjs --db bench-22/work/db/M01-5668.db
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB = path.resolve(argOf('db', path.join(HERE, 'work', 'db', 'M01-5668.db')));
const MAX = Number(argOf('max', 2));
if (!fs.existsSync(DB)) throw new Error(`库不存在：${DB}`);

/* 实词二元组：先把**时间词**整段抠掉再取相邻两字。
 *
 * 第一版没抠时间词，量出来 51 个日子里有 21 个「同一件事多句」，最大一簇 8 条。
 * 打开看，那 8 条讲的是宠物险、陶艺课、我妈来、瑜伽砖、还欠十八块、赶集——六件
 * 不同的事，被「周六」「下午」这两个词串成了一簇。时间词在这里就是磁铁（§60 的
 * 同一种失败）：同一天到期的候选**必然**共享时间词，拿它算相似度等于把每天都说成
 * 同一件事。 */
const TIME = /(?:(?:这|下|上|本|那|每)?(?:周|星期|礼拜)[一二三四五六日天末]?|今天|今日|明天|明日|后天|大后天|昨天|昨日|前天|大前天|今儿|明儿|后儿|上午|下午|中午|晚上|晚上|早上|早晨|夜里|凌晨|傍晚|白天|今晚|明晚|今早|明早|\d+\s*[点号日时分秒]|\d+\s*月|\d+\s*年)/gu;
const STOP = new Set([...'的了呢吧啊嗯哦嘛呀着过是在我你他她它你们我们他们这那么什么怎样不没和与就都也还又才刚从把被给让对说想会能可要不']);
function bigrams(text) {
	const out = new Set();
	const chars = [...String(text ?? '').replace(TIME, ' ')];
	for (let i = 0; i < chars.length - 1; i++) {
		const a = chars[i];
		const b = chars[i + 1];
		if (!/[\u4e00-\u9fa5]/.test(a) || !/[\u4e00-\u9fa5]/.test(b)) continue;
		if (STOP.has(a) || STOP.has(b)) continue;
		out.add(a + b);
	}
	return out;
}
function shared(a, b) {
	const B = bigrams(b);
	let n = 0;
	for (const one of bigrams(a)) if (B.has(one)) n += 1;
	return n;
}
const intent = /(?:得|要|该|打算|准备|计划|记得|别忘|约|定|安排|截|之前|前)/u;

const db = new DatabaseSync(DB, { readOnly: true });
const rows = db
	.prepare(`SELECT l0_id AS id, turn, session_id, created_at, text, due_from, due_to
	          FROM l0_due WHERE due_from IS NOT NULL
	          ORDER BY due_from, created_at`)
	.all();
console.log(`l0_due 里带普通窗口的行 ${rows.length}`);

/* 按「说的那些句子解出的那一天」分组。窗口宽于一天的行（「月底前」）不参与：
 * 产品里它们本来就被 ② 号判据剔掉了。 */
const DAY = 864e5;
const byDay = new Map();
for (const one of rows) {
	const from = Number(one.due_from);
	const to = Number(one.due_to);
	if (to - from > DAY) continue;
	const key = Math.floor((from + 8 * 3600e3) / DAY);
	if (!byDay.has(key)) byDay.set(key, []);
	byDay.get(key).push(one);
}
console.log(`其中「单个日子」的分组 ${byDay.size} 个`);

let multi = 0;
let eaten = 0;
let eatenWeekdays = 0;
const clustersAll = [];
for (const [, list] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
	/* 同一个 session 里，两两共享 ≥2 个实词就算一簇（并查集，链条也算）。 */
	const parent = list.map((_, i) => i);
	const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	for (let i = 0; i < list.length; i++) {
		for (let j = i + 1; j < list.length; j++) {
			if (String(list[i].session_id) !== String(list[j].session_id)) continue;
			if (shared(list[i].text, list[j].text) < 2) continue;
			parent[find(i)] = find(j);
		}
	}
	const groups = new Map();
	list.forEach((one, i) => {
		const root = find(i);
		if (!groups.has(root)) groups.set(root, []);
		groups.get(root).push(one);
	});
	const sizes = [...groups.values()].map((g) => g.length).filter((n) => n > 1);
	if (sizes.length > 0) {
		multi += 1;
		clustersAll.push({ day: new Date(Number(list[0].due_from)).toISOString().slice(0, 10), sizes, list });
	}
	/* 按产品现在的排序取前 MAX 条，数其中有没有两条来自同一簇。 */
	const lead = (one) => {
		const from = Number(one.due_from);
		const said = Math.floor((Number(one.created_at) + 8 * 3600e3) / DAY);
		return from - said * DAY;
	};
	const sorted = [...list].sort((a, b) => {
		if (lead(a) !== lead(b)) return lead(b) - lead(a);
		const ma = intent.test(a.text) ? 0 : 1;
		const mb = intent.test(b.text) ? 0 : 1;
		if (ma !== mb) return ma - mb;
		return Number(b.created_at) - Number(a.created_at);
	});
	const top = sorted.slice(0, MAX);
	const seen = new Set();
	for (const one of top) {
		const i = list.indexOf(one);
		const root = find(i);
		if (seen.has(root)) {
			eaten += 1;
			eatenWeekdays += 1;
			break;
		}
		seen.add(root);
	}
}
console.log(`\n有「同一件事多句候选」的日子 ${multi} 个 / ${byDay.size} = ${(100 * multi / byDay.size).toFixed(1)}%`);
console.log(`其中前 ${MAX} 条里出现两条同簇（名额被重复句吃掉）${eaten} 个 = ${(100 * eaten / byDay.size).toFixed(1)}%`);
const sizes = clustersAll.map((one) => Math.max(...one.sizes)).sort((a, b) => b - a);
console.log(`最大簇大小分布：${sizes.slice(0, 12).join(' ')}${sizes.length > 12 ? ' …' : ''}`);

/* 换一条排序会怎样：把「问对方」的句子沉到非疑问句之后，其余不动。
 * 这是修法 ① 的候选，改产品前先看它动几天、动的那些天是不是改对了。 */
const ASK = /(?:[？?]|要不要|是不是|该不该|想不想|有没有|会不会|能不能|行不行|好不好|算不算|用不用)/u;
const leadOf = (one) => Number(one.due_from) - Math.floor((Number(one.created_at) + 8 * 3600e3) / DAY) * DAY;
const rank = (list, useAsk) =>
	[...list].sort((a, b) => {
		if (leadOf(a) !== leadOf(b)) return leadOf(b) - leadOf(a);
		if (useAsk) {
			const qa = ASK.test(a.text) ? 1 : 0;
			const qb = ASK.test(b.text) ? 1 : 0;
			if (qa !== qb) return qa - qb;
		}
		const ma = intent.test(a.text) ? 0 : 1;
		const mb = intent.test(b.text) ? 0 : 1;
		if (ma !== mb) return ma - mb;
		return Number(b.created_at) - Number(a.created_at);
	});
let changed = 0;
console.log('\n换了排序之后名额变了的那些天：');
for (const [, list] of [...byDay.entries()].sort((a, b) => a[0] - b[0])) {
	const before = rank(list, false).slice(0, MAX).map((one) => one.id).join(',');
	const after = rank(list, true).slice(0, MAX).map((one) => one.id).join(',');
	if (before === after) continue;
	changed += 1;
	const arr = rank(list, true);
	console.log(` ${new Date(Number(list[0].due_from)).toISOString().slice(0, 10)}  ${before} → ${after}`);
	for (const one of arr.slice(0, 3)) {
		const mark = rank(list, false).slice(0, MAX).some((x) => x.id === one.id) ? '=' : '+';
		console.log(`   ${mark} #${one.id} t${one.turn} ${String(one.text).replace(/\n/g, ' ').slice(0, 48)}`);
	}
}
console.log(`\n${changed} / ${byDay.size} 个日子的名额变了`);
console.log('\n簇最大的 6 天：');
for (const one of clustersAll.sort((a, b) => Math.max(...b.sizes) - Math.max(...a.sizes)).slice(0, 6)) {
	console.log(` ${one.day} 簇 ${one.sizes.join('/')}`);
	for (const row of one.list) console.log(`   #${row.id} t${row.turn} ${String(row.text).replace(/\n/g, ' ').slice(0, 52)}`);
}
db.close();
