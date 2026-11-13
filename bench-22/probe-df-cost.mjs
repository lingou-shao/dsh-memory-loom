/**
 * 只为「一个词出现在多少行里」付三次不同的账（2026-11-13）。
 *
 * `rareTokenHit` / `overlapHit` / `topicAnchor` 要的都是**文档频率**，现在走的却是
 * `searchL0(term, cap+1).length`——一次完整的排序检索，取回 6 行正文，就为了知道
 * 「有没有超过 5 行」。一次 `memory_search` 里这件事做 34.6 次。
 *
 * 三种更便宜的办法，都在同一个库上比：
 *   A 现状：searchL0（MATCH + JOIN 主表 + 全量排序 + LIMIT）
 *   B 只数不排：`COUNT(*) FROM l0_fts JOIN l0`（去掉排序与取正文）
 *   C 查词表：`fts5vocab` 的 row 模式，索引里直接读 term 的 doc 数
 *
 * C 的语义差别必须看清楚：`fts5vocab` 给的是**整张 FTS 表**的频率，不能按
 * identity 过滤。A/B 都能。所以这里同时报「C 与 B 在单身份库上是否同值」，以及
 * 多身份时差多少——差得大就不能直接用，得留一层按身份的修正。
 *
 *   node bench-22/probe-df-cost.mjs --db bench-22/work/cmp-m02.db
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const dbIn = arg('db', path.join(HERE, 'work', 'cmp-m02.db'));
const PERSONA = arg('persona', 'M02');
const REPS = Number(arg('reps', 30));
/*
* 问句按 `persona` 挑，SQL 里的 `identity_id` 却是库里的身份 id——两者不是同一个
* 字符串。第一版把 `M02` 当成 `identity_id` 传给 SQL，命中了 0 行，于是「取一个词
* 的 DF」量出 0.03 ms 的假读数（真值差 40 倍）。**尺子错会往好里偏**（§100.3）。
*/
let IDENTITY = arg('identity', '');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-df-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, copy);
const db = new DatabaseSync(copy);
db.exec('PRAGMA cache_size = -32000');

const rows = db.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
const identities = db.prepare('SELECT identity_id, COUNT(*) AS n FROM l0 GROUP BY identity_id').all();
if (IDENTITY === '') IDENTITY = identities[0]?.identity_id ?? 'master';
console.log(`库 ${rows} 行 · 身份 ${identities.map((one) => `${one.identity_id}:${one.n}`).join(' ')} · SQL 用 ${IDENTITY}`);

/* fts5vocab 是只读视图，不占空间；名字要与 FTS 表对上。 */
db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.l0_vocab USING fts5vocab(main, l0_fts, row)');
const vocabOk = (() => {
	try {
		return db.prepare("SELECT doc FROM temp.l0_vocab WHERE term = '今天'").get() !== undefined;
	} catch (error) {
		console.log(`fts5vocab 建不起来：${error.message}`);
		return false;
	}
})();

const A = db.prepare('SELECT l.id, l.text, bm25(l0_fts, 1.0, 1.0) AS s FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ? ORDER BY s LIMIT 6');
const B = db.prepare('SELECT COUNT(*) AS n FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ?');
const C = vocabOk ? db.prepare('SELECT doc FROM temp.l0_vocab WHERE term = ?') : null;

const time = (fn, reps) => {
	fn();
	const began = performance.now();
	for (let i = 0; i < reps; i++) fn();
	return (performance.now() - began) / reps;
};

/* 拿真实问句里的词当样本：它们的 DF 分布就是产品会遇到的那种。 */
const DATA = [
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => fs.existsSync(path.join(one, 'exam-inputs.jsonl')));
const questions = DATA
	? fs.readFileSync(path.join(DATA, 'exam-inputs.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((r) => r.persona === PERSONA)
	: [];
const terms = [];
for (const item of questions.slice(0, 40)) {
	for (const chunk of String(item.question).split(/[，。？！、；：\s"“”（）()]+/)) {
		if (chunk.length >= 2) terms.push(chunk.slice(0, 2), chunk.slice(-2));
	}
}
const sample = [...new Set(terms)].filter((t) => t.length === 2).slice(0, 40);
console.log(`样本 ${sample.length} 个二元组（取自 ${questions.length} 道真实 dev 问句）\n`);

console.log('=== 每次「取一个词的 DF」的耗时 ===');
const perA = [];
const perB = [];
const perC = [];
let sameAB = 0;
let sameBC = 0;
let compared = 0;
for (const term of sample) {
	const expr = `"${term}"`;
	const a = A.all(expr, IDENTITY).length;
	const b = B.get(expr, IDENTITY).n;
	const c = C ? (C.get(term)?.doc ?? 0) : undefined;
	const msA = time(() => A.all(expr, IDENTITY), REPS);
	const msB = time(() => B.get(expr, IDENTITY), REPS);
	const msC = C ? time(() => C.get(term), REPS) : NaN;
	perA.push(msA);
	perB.push(msB);
	perC.push(msC);
	compared += 1;
	if (a === b) sameAB += 1;
	if (c !== undefined && b === c) sameBC += 1;
}
const med = (list) => {
	const s = [...list].sort((x, y) => x - y);
	return s[Math.floor(s.length / 2)];
};
const sum = (list) => list.reduce((x, y) => x + y, 0);
console.log(`  A searchL0       均 ${(sum(perA) / perA.length).toFixed(3).padStart(7)}ms  中位 ${med(perA).toFixed(3)}ms  合计 ${sum(perA).toFixed(1)}ms`);
console.log(`  B COUNT(*)       均 ${(sum(perB) / perB.length).toFixed(3).padStart(7)}ms  中位 ${med(perB).toFixed(3)}ms  合计 ${sum(perB).toFixed(1)}ms`);
console.log(`  C fts5vocab      均 ${(sum(perC) / perC.length).toFixed(3).padStart(7)}ms  中位 ${med(perC).toFixed(3)}ms  合计 ${sum(perC).toFixed(1)}ms`);
console.log(`  A 与 B 同值 ${sameAB}/${compared} · B 与 C 同值 ${sameBC}/${compared}`);

/* 一次检索 34.6 次：把这 34.6 乘上去，看整卷省多少。 */
const CALLS = 34.6;
console.log(
	`\n  按每次检索 34.6 次折算：A ${(med(perA) * CALLS).toFixed(1)}ms  B ${(med(perB) * CALLS).toFixed(1)}ms  C ${(med(perC) * CALLS).toFixed(1)}ms`,
);

if (C) {
	console.log('\n=== C 的语义边界：fts5vocab 不认 identity ===');
	const worst = db
		.prepare(`SELECT term, doc FROM temp.l0_vocab ORDER BY doc DESC LIMIT 5`)
		.all();
	for (const one of worst) {
		const perIdentity = identities.map((id) => {
			const n = db.prepare('SELECT COUNT(*) AS n FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ?').get(`"${one.term}"`, id.identity_id).n;
			return `${id.identity_id}:${n}`;
		});
		console.log(`  ${one.term.padEnd(6)} 全表 ${String(one.doc).padStart(5)}  按身份 ${perIdentity.join(' ')}`);
	}
}

/* 计划：B 有没有把排序去掉。 */
console.log('\n=== 计划 ===');
console.log('  B COUNT(*)：');
for (const row of db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ?').all('"今天"', IDENTITY)) {
	console.log(`     ${row.detail}`);
}
console.log('  C fts5vocab：');
for (const row of db.prepare("EXPLAIN QUERY PLAN SELECT doc FROM temp.l0_vocab WHERE term = '今天'").all()) console.log(`     ${row.detail}`);

db.close();
fs.rmSync(work, { recursive: true, force: true });
