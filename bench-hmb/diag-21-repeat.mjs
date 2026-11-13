/**
 * 同一个故事说了两遍，判分器看见了吗？
 *
 * 背景：2.1 的 `M01-G031` 一族里有同一副旧象棋被托付三次的记录，前两条各带一个
 * 到期窗口（11-02 / 11-16），最终都留在 `active`，作答侧只能挑一条。查下来
 * `judgeAgainst` 没有槽位可依（抽取提示词明确要求「计划」不给槽位），于是退回
 * `findNeighbours` + 模型判分那条路。这个脚本量的就是那条路上有没有「看见」。
 *
 * 三件事，逐条量：
 *   ① 对每条在跑批期间写入的 active 事实，按 `findNeighbours` 的原样（compileMatch
 *      的全二元组 AND + limit 24 + jaccard ≥ 0.12）求邻居，记邻居数；
 *   ② 独立地找「讲同一件事」的两条 active 事实（共享内容二元组 ≥ 4 或 jaccard ≥ .35），
 *      看这一对里对方有没有出现在①的邻居集合里；
 *   ③ 其中有多少对是 plan、两个到期窗口还不一样——也就是「改期」那一类。
 *
 * 只读，不改库。
 *
 *   node bench-hmb/diag-21-repeat.mjs
 */
import { DatabaseSync } from 'node:sqlite';

const DBS = (process.env.CMB21_DBS ?? [
	'C:/Users/shaoz/AppData/Local/Temp/s21-M01-MZ8sf9/loom.db',
	'C:/Users/shaoz/AppData/Local/Temp/s21-M02-l3Gw0V/loom.db'
].join(',')).split(',').filter(Boolean);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_RUN = /[A-Za-z][A-Za-z0-9_'-]*/g;
const DIGIT_RUN = /\d+(?:[.:-]\d+)*/g;

/** 与 lib 的 `tokensOf` 逐行一致。 */
function tokensOf(text) {
	const tokens = [];
	for (const match of String(text).matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
		if (chars.length === 1) tokens.push(chars[0]);
	}
	for (const match of String(text).matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
	for (const match of String(text).matchAll(DIGIT_RUN)) tokens.push(match[0]);
	return tokens;
}
/** 与 lib 的 `compileMatch` 逐行一致（缺省 limit 24）。 */
function compileMatch(query, limit = 24) {
	const unique = [...new Set(tokensOf(query))].slice(0, limit);
	if (unique.length === 0) return undefined;
	return unique.map((token) => `"${token.replaceAll('"', '""')}"`).join(' ');
}
function tokenSet(text) {
	return new Set(tokensOf(text));
}
function jaccard(a, b) {
	const left = tokenSet(a);
	const right = tokenSet(b);
	if (left.size === 0 || right.size === 0) return 0;
	let shared = 0;
	for (const token of left) if (right.has(token)) shared++;
	return shared / (left.size + right.size - shared);
}
/**
 * 「内容二元组」：去掉虚字之后仍算数的二元组。
 *
 * 这里故意不复用 lib 的 `isThinToken`——那是给**单字**交集用的判据，整词判会
 * 把「象棋」这种硬词留下、把「说的」这种套话去掉，正是本脚本要的东西；但它是
 * lib 内部函数，不在导出面上，抄一份常量比从打包产物里抠更稳。
 */
const THIN = new Set([...'怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来']);
const contentTokens = (text) => [...new Set(tokensOf(text))].filter((token) => ![...token].some((ch) => THIN.has(ch)));

function neighbourhood(db, identityId, text) {
	const match = compileMatch(text);
	if (match === undefined) return [];
	try {
		const rows = db.prepare(`
      SELECT f.id, f.text FROM facts_fts CROSS JOIN facts f
      WHERE facts_fts MATCH ? AND f.id = facts_fts.rowid AND f.identity_id = ?
        AND f.status IN ('active','disputed') AND f.isolated = 0
      ORDER BY bm25(facts_fts, 5.0, 1.0, 2.0, 2.0) LIMIT 5
    `).all(match, identityId);
		return rows.filter((row) => jaccard(row.text, text) >= 0.12);
	} catch {
		return [];
	}
}

const day = (ms) => (ms === null || ms === undefined ? '-' : new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10));
const out = [];
for (const path of DBS) {
	const db = new DatabaseSync(path, { readOnly: true });
	const people = db.prepare('SELECT id, name FROM identities').all();
	for (const who of people) {
		const facts = db.prepare(`
      SELECT id, text, kind, status, subject, attr, value, due_from, expires_at, source_ids, created_at
      FROM facts WHERE identity_id = ? AND status IN ('active','disputed') AND isolated = 0
    `).all(who.id);
		const tokenSets = new Map(facts.map((fact) => [fact.id, contentTokens(fact.text)]));
		/* ① 每条事实自己的邻居面。 */
		const seen = new Map();
		for (const fact of facts) seen.set(fact.id, new Set(neighbourhood(db, who.id, fact.text).map((row) => row.id)));
		/* ② 独立找同一件事。共享内容二元组 ≥ 4 且 jaccard ≥ .2，两条都算。 */
		const pairs = [];
		for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
			const a = facts[i];
			const b = facts[j];
			const shared = tokenSets.get(a.id).filter((token) => tokenSets.get(b.id).includes(token));
			if (shared.length < 4) continue;
			const jac = jaccard(a.text, b.text);
			if (jac < 0.2 && shared.length < 6) continue;
			pairs.push({ a, b, shared, jac });
		}
		const blind = pairs.filter(({ a, b }) => !seen.get(a.id).has(b.id) || !seen.get(b.id).has(a.id));
		const rescheduled = blind.filter(({ a, b }) => a.kind === 'plan' && b.kind === 'plan' && (a.due_from ?? -1) !== (b.due_from ?? -1));
		out.push({ path, person: who.name, facts: facts.length, pairs: pairs.length, blind: blind.length, rescheduled, all: blind });
		console.log(`\n=== ${who.name}（${facts.length} 条 active）===`);
		console.log(`  同事件对 ${pairs.length}，其中至少一侧邻居里看不见 ${blind.length}，plan 改期 ${rescheduled.length}`);
	}
	db.close();
}

console.log('\n--- 计划改期但两条都活着（前 12 例） ---');
for (const block of out) for (const one of block.rescheduled.slice(0, 12)) {
	console.log(`#${one.a.id}(${day(one.a.due_from)}) ${one.a.text.slice(0, 44)}`);
	console.log(`#${one.b.id}(${day(one.b.due_from)}) ${one.b.text.slice(0, 44)}`);
	console.log(`   共享 ${one.shared.length} 个内容二元组，jaccard ${one.jac.toFixed(2)}`);
}
console.log('\n--- 邻居看不见的同事件对（前 12 例，不限 plan） ---');
let shown = 0;
for (const block of out) for (const one of block.all) {
	if (shown++ >= 12) break;
	console.log(`#${one.a.id} ${one.a.text.slice(0, 40)}`);
	console.log(`#${one.b.id} ${one.b.text.slice(0, 40)}`);
	console.log(`   共享 ${one.shared.length}，jaccard ${one.jac.toFixed(2)}`);
}
