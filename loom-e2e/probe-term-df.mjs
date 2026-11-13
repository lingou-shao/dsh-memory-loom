/**
 * 文档频率（`termDf`）的语义边界（2026-11-13，v9）。
 *
 * 这一版把「这个词出现过几行」从一次排序检索改成查 FTS 词表（`fts5vocab`）。
 * 快是快，但词表的口径是**整张 FTS 表**，不认身份；而闸门（`rareTokenHit` /
 * `overlapHit` / `topicAnchor`）问的一直是「**这个身份**里稀不稀有」。
 *
 * 钉四件事：
 *   1. 单身份：词表与逐身份计数同值；
 *   2. 不存在的词是 0（不是「查不到」）——`df === 0` 若被当成最稀有，闸门会在
 *      每个问句上误放宽（§90.2 记过这一笔）；
 *   3. 多身份：词表把别人的话算进来，且「按身份 1 行」与「词表 4 行」跨在
 *      上限 3 的两侧——一个该放行、一个会被判成常见词丢掉；
 *   4. 等价性（最硬的一条）：把 `l0_vocab` 删掉，逼产品走逐身份计数那条路，
 *      `memory_search` 的输出必须**逐字节相同**。两条频率来源要是差一个数，
 *      闸门就会在两版之间换答案。
 *
 * 缓存失效没有单独断言：`appendL0` 每次都把 `dfGen` 往前推一格、频率缓存整批
 * 作废（`MemoryStore.bumpL0`），没有「忘了失效」的分支可测。
 *
 *   node loom-e2e/probe-term-df.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
	if (ok) {
		passed += 1;
		console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`);
	} else {
		failed += 1;
		console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-termdf-'));
const day = 864e5;
const base = Date.parse('2026-04-01T09:00:00Z');
const open = (name) => createLoom({ dbPath: path.join(dir, name), config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
const say = async (loom, lines, from = 0) => {
	for (let i = 0; i < lines.length; i += 1) {
		await loom.turn('main', lines[i], '嗯，记下了。', { at: base + (from + i) * day });
	}
};
const vocabDoc = (db, term) => db.prepare('SELECT doc FROM l0_vocab WHERE term = ?').get(term)?.['doc'];
const identityCount = (db, identityId, term) =>
	db.prepare('SELECT COUNT(*) AS n FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ?').get(`"${term}"`, identityId)['n'];

const CORPUS = [
	'周哥喜欢浓茶，别的都随和。',
	'周哥又提了一次浓茶。',
	'今天下雨，路上堵得很。',
	'周末那台灯箱还没取回来。',
	'我妈托我周一送的合影，后来送到了。',
	'试读会定在周四晚上七点。',
];
const QUESTIONS = ['周哥喝什么茶', '灯箱取回来了吗', '合影送到了没有', '试读会几点'];

console.log('\n— 单身份：词表与逐身份计数同值 —');
let identityId = 'master';
{
	const loom = open('one.db');
	await say(loom, CORPUS);
	const db = new DatabaseSync(path.join(dir, 'one.db'), { readOnly: true });
	identityId = db.prepare('SELECT DISTINCT identity_id AS i FROM l0').get()['i'];
	const spread = db.prepare('SELECT COUNT(DISTINCT identity_id) AS n FROM l0').get()['n'];
	check(`一个身份（${spread}，id=${identityId}）`, spread === 1);
	for (const term of ['周哥', '浓茶', '灯箱', '试读']) {
		const a = vocabDoc(db, term);
		const b = identityCount(db, identityId, term);
		check(`「${term}」词表 ${a} == 计数 ${b}`, a === b && a > 0);
	}
	const absent = vocabDoc(db, '压根没有这个词');
	const absentCount = identityCount(db, identityId, '压根没有这个词');
	check(`不存在的词：词表 ${absent ?? '无行'} / 计数 ${absentCount} → 都等于「0 行」`, (absent ?? 0) === 0 && absentCount === 0);
	const version = db.prepare('PRAGMA user_version').get()['user_version'];
	check(`schema ≥ 9（实为 ${version}）`, Number(version) >= 9);
	check('l0_vocab 已建', db.prepare("SELECT name FROM sqlite_master WHERE name = 'l0_vocab'").get() !== undefined);
	db.close();
	loom.dispose?.();
}

console.log('\n— 等价性：删掉词表，逼产品走逐身份计数 —');
{
	const loom = open('equiv.db');
	await say(loom, CORPUS);
	const withVocab = [];
	for (const question of QUESTIONS) withVocab.push(String(await loom.call('memory_search', { query: question, limit: 10 }, 'main')));
	/* 真的删掉，让它查不到；`termDf` 的 catch 会把路切到逐身份计数。 */
	const writer = new DatabaseSync(path.join(dir, 'equiv.db'));
	writer.exec('DROP TABLE l0_vocab');
	writer.close();
	const without = [];
	for (const question of QUESTIONS) without.push(String(await loom.call('memory_search', { query: question, limit: 10 }, 'main')));
	const same = withVocab.every((text, i) => text === without[i]);
	check(`词表路径与计数路径输出逐字节相同（${QUESTIONS.length} 题）`, same, same ? '' : withVocab.find((text, i) => text !== without[i])?.slice(0, 80) ?? '');
	loom.dispose?.();
}

console.log('\n— 多身份：词表把别人的话算进来 —');
{
	const loom = open('two.db');
	await say(loom, ['周哥今天来了一趟。']);
	const db = new DatabaseSync(path.join(dir, 'two.db'));
	/*
	* 第二个身份的行直接插：这里要证的是频率口径，不是「访客怎么被创建」
	* （那条路另有一套探针）。`l0` 上的触发器会把它们同步进 FTS。
	*/
	db.prepare('DELETE FROM l0 WHERE identity_id = ?').run('visitor-1');
	const insert = db.prepare(`
    INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone, purge_at)
    VALUES ('visitor-s', 'visitor-1', ?, 'user', ?, ?, ?, 'UTC', NULL)
  `);
	[
		[1, '周哥说周一见。', '周 哥 周哥 说 周 一 见'],
		[2, '周哥又改到周二。', '周 哥 周哥 又 改 到 周 二'],
		[3, '周哥最后没来。', '周 哥 周哥 最 后 没 来'],
	].forEach(([turn, text, tokens], index) => insert.run(turn, text, tokens, base + (index + 2) * day));
	const spread = db.prepare('SELECT COUNT(DISTINCT identity_id) AS n FROM l0').get()['n'];
	check(`两个身份（${spread}）`, spread === 2);
	const globalDoc = vocabDoc(db, '周哥');
	const ownerCount = identityCount(db, identityId, '周哥');
	const visitorCount = identityCount(db, 'visitor-1', '周哥');
	check(`词表 ${globalDoc} = 主人 ${ownerCount} + 访客 ${visitorCount}`, globalDoc === ownerCount + visitorCount && globalDoc === 4);
	/*
	* 上界取 `max(3, 行数 × 3 / 780)`（`dfCeiling`）。主人只有一行，所以上界是 3：
	* 正确的频率 1 ≤ 3 → 稀有，该放行；词表的 4 > 3 → 会被判成常见词丢掉。
	*/
	const limit = 3;
	check(`按身份 ${ownerCount} ≤ ${limit}（放行）而词表 ${globalDoc} > ${limit}（误杀）`, ownerCount <= limit && globalDoc > limit);
	db.close();
	loom.dispose?.();
}

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（${passed + failed} 项断言）`);
try {
	fs.rmSync(dir, { recursive: true, force: true });
} catch {
	/* 临时目录清不掉不影响结论 */
}
process.exit(failed === 0 ? 0 : 1);
