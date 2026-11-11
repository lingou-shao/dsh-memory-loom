/**
 * 漏检题的承载行，在宽松表达式里排第几。
 *
 * 漏斗（`diag-21-funnel.mjs`）把 38 道 M01 漏检全判成 G/P：行是存在的，把证据
 * 本身当问句就能捞到。那问题就落到两个数上：**候选池多大**（`pool = limit`，10
 * 条）和**闸门**（`relaxMinOverlap` 0.25，分母是整句问句）。
 *
 * 这个脚本只量前一个数：拿宽松表达式（`compileLooseMatch`，前 12 个二元组 OR）去
 * 查 facts / events / l0，把承载行的名次打出来。名次 > 10 的行，池子是 10 还是 40
 * 决定它到底存不存在于候选集里——这一步与闸门无关，先分开量。
 *
 * 用的是整卷库（`build-21-db.mjs` 的产物或漏斗留下的临时库），所以 facts/events
 * 是**最终状态**，不是截止轮的状态。作为「名次量级」的估计够用，不作为判分依据。
 *
 *   node bench-hmb/diag-21-pool.mjs --db /tmp/funnel-M01-xxx/loom.db --rows diag-funnel-base-m01.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB = argOf('db', null);
const ROWS = argOf('rows', `${WORK}/diag-funnel-base-m01.json`);
const LIMIT = Number(argOf('limit', 40));
const WIN = 8;

if (!DB) {
	console.error('要 --db <loom.db 路径>');
	process.exit(1);
}

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const THIN_CHARS = new Set([...'怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来']);
const isThin = (token) => {
	if (/\d/u.test(token) || /[A-Za-z]/u.test(token)) return false;
	if ('我你他她它们'.includes(token[0]) && !THIN_CHARS.has(token[1])) return false;
	return [...token].some((char) => THIN_CHARS.has(char));
};
const tokensOf = (text) => {
	const out = [];
	for (const match of String(text ?? '').matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
	}
	return out;
};
const looseExpr = (query, keep = 12) =>
	[...new Set(tokensOf(query))]
		.slice(0, keep)
		.map((token) => `"${token}"`)
		.join(' OR ');
const norm = (text) => String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, '');
const covers = (clause, text) => {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < WIN) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + WIN <= c.length; i++) if (t.includes(c.slice(i, i + WIN))) return true;
	return false;
};

const rows = JSON.parse(fs.readFileSync(ROWS, 'utf8')).rows;
const db = new DatabaseSync(DB, { readOnly: true });
const out = [];
for (const row of rows) {
	const expr = looseExpr(row.question);
	const anchors = row.anchorTexts ?? [];
	const scan = (sql) => {
		try {
			return db.prepare(sql).all(expr);
		} catch {
			return [];
		}
	};
	const facts = scan(`SELECT f.id, f.text AS body, bm25(facts_fts) AS s FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid WHERE facts_fts MATCH ? ORDER BY s LIMIT ${LIMIT}`);
	const events = scan(`SELECT e.id, e.title || '：' || e.summary AS body, bm25(events_fts) AS s FROM events_fts JOIN events e ON e.id = events_fts.rowid WHERE events_fts MATCH ? ORDER BY s LIMIT ${LIMIT}`);
	const l0 = scan(`SELECT l.rowid AS id, l.text AS body, bm25(l0_fts) AS s FROM l0_fts JOIN l0 l ON l.rowid = l0_fts.rowid WHERE l0_fts MATCH ? ORDER BY s LIMIT ${LIMIT}`);
	const rank = (list) => {
		const index = list.findIndex((one) => anchors.some((anchor) => covers(anchor, one.body)));
		return index === -1 ? 0 : index + 1;
	};
	out.push({
		id: row.id,
		kind: row.kind,
		question: row.question,
		pool: { facts: facts.length, events: events.length, l0: l0.length },
		rank: { facts: rank(facts), events: rank(events), l0: rank(l0) }
	});
}

const band = (value) => (value === 0 ? '无' : value <= 10 ? '≤10' : value <= 20 ? '11–20' : '21–40');
console.log(`候选池名次（限额 ${LIMIT}，整卷库）  题数 ${out.length}`);
for (const channel of ['facts', 'events', 'l0']) {
	const tally = {};
	for (const row of out) tally[band(row.rank[channel])] = (tally[band(row.rank[channel])] ?? 0) + 1;
	console.log(`  ${channel.padEnd(6)}  ${['≤10', '11–20', '21–40', '无'].map((key) => `${key} ${tally[key] ?? 0}`).join('  ')}`);
}
console.log('\n逐题（名次 0 = 没进前 ' + LIMIT + '）');
for (const row of out) {
	console.log(
		`  ${row.id.padEnd(16)} ${row.kind}  fact ${row.rank.facts}  event ${row.rank.events}  l0 ${row.rank.l0}  「${String(row.question).slice(0, 28)}」`
	);
}
fs.writeFileSync(`${WORK}/diag-pool-${path.basename(ROWS, '.json')}.json`, JSON.stringify(out, null, 1), 'utf8');
