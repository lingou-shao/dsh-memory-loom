/**
 * 情景词表（§60）。
 *
 * 「带条件或期限的偏好和边界」是全卷最差的一格（43.5%，10/23）。它的形状是固定
 * 的：问句说现在的情形（明早地湿还下雨 / 今天又阴起），库里存的是以前定下的规矩
 * （雨天就按这个来 / 只有落雨或者阴天听着才对味），两边说的是同一件事，字面却几乎
 * 不相交。
 *
 * 两个场景分开建库，因为它们是**不同的人**：混在一个库里「落雨」这组别名会让雨
 * 天晨练那一条抢走泥煤题的位——这不是要验的东西，是全卷里不会发生的串场。
 *
 * 验五件事：
 *   1. 规矩句进得了事实层（`looksWorthKeeping` 一个标记都不命中）；
 *   2. 条件在前一句、动作在后一句时，拼成一条完整规矩，而不是只留半句；
 *   3. 同组说法进了那一行的别名列，问句用另一种说法能找到它；
 *   4. 问句与原话二元组重合是 0 也算数——这是这条通道唯一的意义；
 *   5. 天气报告（「今天下雨了，路上堵」）不因此变成磁铁。
 *
 *   node probe-condition-alias.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, DAY } from './harness.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** 二元组集合，用来证明「找到了」不是靠字面重合。 */
const bigrams = (text) => {
	const s = String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
	const out = new Set();
	for (let i = 0; i + 2 <= s.length; i++) out.add(s.slice(i, i + 2));
	return out;
};
const overlap = (a, b) => {
	const left = bigrams(a);
	const right = bigrams(b);
	if (left.size === 0 || right.size === 0) return 0;
	let hit = 0;
	for (const one of left) if (right.has(one)) hit += 1;
	return hit / left.size;
};

const BASE = Date.parse('2026-05-01T21:10:00+08:00');
const make = (name) => {
	const dir = mkdtempSync(join(tmpdir(), `loom-cond-${name}-`));
	const dbPath = join(dir, 'loom.db');
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const facts = () => {
		const db = new DatabaseSync(dbPath);
		const list = db.prepare('SELECT id, text, aliases FROM facts ORDER BY id').all();
		db.close();
		return list;
	};
	return { loom, facts };
};

/* ── 场景一：雨夜喝泥煤 ─────────────────────────────────────────── */
const rain = make('whisky');
let at = BASE;
for (const [user, reply] of [
	['今天店里人多不多？', '还行，晚上落了几滴。'],
	['我只有雨夜喝一小杯泥煤威士忌，最多两指，当周有早班或者盘点就不碰。', '两指这条线挺清楚，盘点那周就当真不碰了。']
]) {
	await rain.loom.turn('w', user, reply, { at });
	at += DAY;
}
const whisky = rain.facts().find((row) => row.text.includes('泥煤威士忌'));
console.log('\n[1] 规矩句成为事实行');
check('「雨夜喝泥煤」有行', whisky !== undefined);

/* ── 场景二：雨天晨练 ───────────────────────────────────────────── */
const wet = make('rain');
at = BASE;
for (const [user, reply] of [
	['今天跑了西湖一圈，回来腿有点抖。', '跑完拉伸一下，别直接坐下。'],
	['算了，不跑西湖了，改在楼道里拉伸；以后雨天就按这个来，不硬出去淋。', '雨天在楼道里拉伸，这个改法稳妥。'],
	['今天下雨了，路上堵得要命。', '雨天路况确实差。']
]) {
	await wet.loom.turn('r', user, reply, { at });
	at += DAY;
}
const rows = wet.facts();
const stretch = rows.find((row) => row.text.includes('楼道里拉伸'));
const weather = rows.find((row) => row.text.includes('路上堵'));

console.log('\n[2] 条件在前一句、动作在后一句时拼成一条');
check('「改在楼道里拉伸」有行', stretch !== undefined);
check('同一行里有条件词「雨天」', /雨天|以后/.test(String(stretch?.text ?? '')), String(stretch?.text ?? ''));

console.log('\n[3] 同组说法进了那一行的别名列');
check('拉伸那行带「下雨」', /下雨|落雨/.test(String(stretch?.aliases ?? '')), String(stretch?.aliases ?? ''));
check('泥煤那行没被挂上天气别名（它只说「雨夜」，没说要按情形来）', !/下雨|落雨|地湿/.test(String(whisky?.aliases ?? '')), String(whisky?.aliases ?? '（无）'));

console.log('\n[4] 问句用另一种说法能找到那行');
for (const [query, needle, label] of [
	['明早地湿还下雨，晨练按什么来？', '楼道', '雨天 → 地湿还下雨'],
	['下雨地滑，我以前定的晨练法是什么？', '楼道', '雨天 → 下雨地滑']
]) {
	const hits = String(await wet.loom.call('memory_search', { query, limit: 10 }, 'r'));
	console.log(`     与金标原话的二元组重合 ${(overlap(query, String(stretch?.text ?? '')) * 100).toFixed(0)}% · ${label}`);
	check(label, hits.includes(needle), hits.split('\n').slice(0, 2).join(' ').slice(0, 96));
}

console.log('\n[5] 「今天下雨了，路上堵」不是规矩');
check(
	'要么没有行，要么没被挂上晨练那一组',
	weather === undefined || /晨练|跑步|拉伸/.test(String(weather.aliases ?? '')) === false,
	String(weather?.aliases ?? '（无此行）')
);

console.log(`\n${pass} 通过 · ${fail} 失败\n`);
rain.loom.dispose();
wet.loom.dispose();
process.exit(fail === 0 ? 0 : 1);
