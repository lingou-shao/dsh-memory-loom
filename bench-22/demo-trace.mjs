/**
 * 一次 `memory_search` 的**链路实测**：把每一关真实命中数打出来，给演示图供数。
 *
 *   node bench-22/demo-trace.mjs --db work/db/M01-5668.db --ask "..." [--json out.json]
 *
 * 这里的表达式与闸门判据是**照抄** `lib/index.js` 里公开的那几个纯函数
 * （`tokensOf` / `compileMatch` / `compileLooseMatch` / `containment` / `solidHit`），
 * 不是重新设计的近似——数字要能和产品对得上，否则这张图就是编的。
 *
 * 只读：不写库、不改 `lib/`。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB = path.resolve(argOf('db', path.join(HERE, 'work', 'db', 'M01-5668.db')));
const ASK = String(argOf('ask', '')).replaceAll('\\n', '\n');
const NOW = argOf('now', '2027-02-01T14:10:00+08:00');
const SID = argOf('sid', 'M01');
const JSON_OUT = argOf('json', null);
if (!fs.existsSync(DB)) throw new Error(`库不存在：${DB}`);
if (ASK.length === 0) throw new Error('要给 --ask');

/* ── 与 lib 一致的三段切词（CJK 二元组 / 拉丁词 / 数字串） ───────────── */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z0-9_'-]*/gu;
const DIGIT_RUN = /\d+/gu;
function tokensOf(text) {
	const tokens = [];
	for (const match of text.matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of text.matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
	for (const match of text.matchAll(DIGIT_RUN)) tokens.push(match[0]);
	return tokens;
}
const tokenSet = (text) => new Set(tokensOf(text));
function containment(needle, haystack) {
	const small = tokenSet(needle);
	const large = tokenSet(haystack);
	if (small.size === 0) return 0;
	let shared = 0;
	for (const token of small) if (large.has(token)) shared++;
	return shared / small.size;
}
const THIN_CHARS = new Set([..."怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来"]);
const solidToken = (token) => [...token].some((char) => !THIN_CHARS.has(char));
function solidHit(query, text, min) {
	if (!(min > 0)) return false;
	const asked = new Set(tokensOf(query).filter(solidToken));
	if (asked.size < min) return false;
	const own = new Set(tokensOf(text).filter(solidToken));
	let shared = 0;
	for (const token of asked) {
		if (!own.has(token)) continue;
		shared++;
		if (shared >= min) return true;
	}
	return false;
}
const quote = (token) => `"${token.replaceAll('"', '""')}"`;
const compileMatch = (query, limit = 24) => {
	const unique = [...new Set(tokensOf(query))].slice(0, limit);
	return unique.length === 0 ? undefined : unique.map(quote).join(' ');
};
const compileLooseMatch = (query, limit = 12) => {
	const unique = [...new Set(tokensOf(query))].slice(0, limit);
	return unique.length === 0 ? undefined : unique.map(quote).join(' OR ');
};

/* ── 真实跑一遍产品 ───────────────────────────────────────────── */
const realNow = Date.now;
Date.now = () => Date.parse(NOW);
const loom = createLoom({ dbPath: DB, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
const block = loom.memoryBlock(SID);
const index = loom.indexBlock(SID);
const final = String(await loom.call('memory_search', { query: ASK, limit: 10 }, SID));
loom.dispose();
Date.now = realNow;

/* ── 台账：每一关的命中数 ──────────────────────────────────────── */
const db = new DatabaseSync(DB, { readOnly: true });
const count = (sql, ...params) => {
	try {
		return db.prepare(sql).get(...params).n;
	} catch (error) {
		return `ERR ${error.message}`;
	}
};
const strict = compileMatch(ASK);
const loose = compileLooseMatch(ASK);
const loose200 = compileLooseMatch(ASK, 200) ?? strict;

const ledger = {
	query: ASK,
	now: NOW,
	tokens: [...new Set(tokensOf(ASK))],
	strictExpr: strict ?? null,
	looseExpr: loose ?? null,
	strict: {
		facts: count('SELECT COUNT(*) n FROM facts_fts WHERE facts_fts MATCH ?', strict),
		events: count('SELECT COUNT(*) n FROM events_fts WHERE events_fts MATCH ?', strict),
		prefs: count('SELECT COUNT(*) n FROM preferences_fts WHERE preferences_fts MATCH ?', strict),
	},
	loose: {
		facts: count('SELECT COUNT(*) n FROM facts_fts WHERE facts_fts MATCH ?', loose),
		events: count('SELECT COUNT(*) n FROM events_fts WHERE events_fts MATCH ?', loose),
		prefs: count('SELECT COUNT(*) n FROM preferences_fts WHERE preferences_fts MATCH ?', loose),
	},
	raw: {
		pool: count('SELECT COUNT(*) n FROM l0_fts WHERE l0_fts MATCH ?', loose200),
	},
};

/* 闸门：严格轮取前 10（池子 = limit），看每条过不过 */
const poolRows = db
	.prepare('SELECT rowid AS id, text, bm25(facts_fts) AS bm FROM facts_fts WHERE facts_fts MATCH ? ORDER BY bm LIMIT 10')
	.all(strict);
ledger.gate = poolRows.map((row) => {
	const cover = containment(ASK, row.text);
	return {
		id: row.id,
		text: row.text,
		cover: Number(cover.toFixed(3)),
		solid: solidHit(ASK, row.text, 3),
		pass: cover >= 0.25 || solidHit(ASK, row.text, 3),
	};
});
ledger.gatePass = ledger.gate.filter((one) => one.pass).length;

/* 放宽轮同样过闸门：池子 = limit，判据 0.25 或共享 3 个内容词 */
const loosePool = db
	.prepare('SELECT rowid AS id, text, bm25(facts_fts) AS bm FROM facts_fts WHERE facts_fts MATCH ? ORDER BY bm LIMIT 10')
	.all(loose);
ledger.looseGate = loosePool.map((row) => {
	const cover = containment(ASK, row.text);
	return {
		id: row.id,
		text: row.text,
		cover: Number(cover.toFixed(3)),
		solid: solidHit(ASK, row.text, 3),
		pass: cover >= 0.25 || solidHit(ASK, row.text, 3),
	};
});
ledger.looseGatePass = ledger.looseGate.filter((one) => one.pass).length;

/* 原话通道：宽松式取 40 行 */
ledger.raw.top = db
	.prepare('SELECT rowid AS id, substr(text,1,80) AS text, bm25(l0_fts) AS bm FROM l0_fts WHERE l0_fts MATCH ? ORDER BY bm LIMIT 5')
	.all(loose200);
db.close();

ledger.blockChars = block.length;
ledger.indexChars = index.length;
ledger.indexLines = index.split('\n').filter((line) => line.startsWith('- ')).length;
ledger.final = final;

if (JSON_OUT !== null) fs.writeFileSync(path.resolve(JSON_OUT), JSON.stringify(ledger, null, 2));
console.log(JSON.stringify({ ...ledger, final: undefined, block: undefined }, null, 2));
console.log(`\n=== 常驻索引 ${ledger.indexChars} 字 / ${ledger.indexLines} 条`);
console.log(`=== 常驻块 ${ledger.blockChars} 字`);
console.log(`\n=== memory_search 结果\n${final}`);
