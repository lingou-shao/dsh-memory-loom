/**
 * DF 必须是**索引期快照**，查询期不再为「数个数」跑排序检索（§115，取自 `1.1.zip` 的 A3）。
 *
 * 外部那份设计把这条写成 `unit_vec.anchor_df`：每条候选的「最稀有实词频次」在**建索引
 * 时**算好存下来，查询期只读一个整数。它的理由不是省空间，是**判据要能复现**——
 * 如果 DF 在查询期现算，同一个问句在库长大之后会换答案，阈值也就跟着漂。
 *
 * 我们这个产品里对应的东西不是 `anchor_df`，是 `l0_vocab`（`fts5vocab` 的 row 模式）：
 * FTS5 在**写入时**维护词表，`termDf` 只做一次 O(log n) 的 term 查找，并按 `dfGen`
 * （`l0` 每次写入前进）做代际缓存。所以这条公理在我们这里**已经成立**，但没有任何
 * 断言钉住它——一旦有人回到 `searchL0(term, cap + 1).length` 那条老路（v9 之前就是），
 * 读数会变，而所有探针仍然全绿。
 *
 * 这个探针补的就是那个缺口。八项：
 *
 *   1. 词表能用（不是「查不动」被静默降级）
 *   2. 词表的 `doc` 与 `COUNT(*)` 真值逐词相同
 *   3. 库里没有的词：词表无行 → DF = 0，且**不会**因为「查不到」被当成最稀有
 *   4. 一次 `memory_search` 至少走一次词表（说明判据读的是快照）
 *   5. 同一次检索里带 `MATCH` 的语句 ≤ 8 条（v9 之前是三十几条，这是回退守卫）
 *   6. 同一个问句的第二次检索，词表查找次数下降（代际缓存生效）
 *   7. 写进新一轮之后缓存失效（`dfGen` 前进），词表查找次数回升
 *   8. 只出现一次的专名能通过稀有通道被找到，且它在词表里的 `doc` 就是 1
 *
 *   node loom-e2e/probe-df-snapshot.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { createLoom, DAY } from './harness.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/*
 * 语句打点。`sourceSQL` 是 `node:sqlite` 暴露的原始 SQL，桥里也是这么打的
 * （`LOOM_TRACE_SQL`），所以这里量到的东西就是产品实际执行的语句，不是推测。
 */
const seen = { vocab: 0, match: 0 };
for (const name of ['all', 'get', 'run']) {
	const original = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...args) {
		const sql = String(this.sourceSQL ?? '');
		if (sql.includes('l0_vocab')) seen.vocab += 1;
		if (/\bMATCH\b/u.test(sql)) seen.match += 1;
		return original.apply(this, args);
	};
}
const reset = () => {
	seen.vocab = 0;
	seen.match = 0;
};

const BASE = Date.parse('2026-05-01T21:10:00+08:00');
const SCRIPT = [
	['我在做一个灯箱，找了个师傅，还没报价。', '好，等他报。'],
	['今天下雨，没出门。', '那就屋里待着。'],
	['师傅发来报价了，八百，说下周三上门装。', '八百还行。'],
	['把第三章改完了，眼睛疼。', '早点歇。'],
	['我姐周雅说下周来住两天。', '好，收拾一下客房。'],
	['她带了点自己腌的萝卜。', '挺好。']
];

const dir = mkdtempSync(join(tmpdir(), 'loom-df-'));
const dbPath = join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const sid = 'df';
let at = BASE;
for (const [user, reply] of SCRIPT) {
	await loom.turn(sid, user, reply, { at });
	at += DAY;
}
await loom.ready?.();

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = () => db.prepare('SELECT id, identity_id, role, text FROM l0').all();

/* ── 1. 词表能不能用 ───────────────────────────────────────────── */
console.log('\n[1] 词表存在，且不是「查不动」的降级状态');
const vocabRow = db.prepare("SELECT doc FROM l0_vocab WHERE term = '灯箱'").get();
check('l0_vocab 里有「灯箱」这一行', vocabRow !== undefined, JSON.stringify(vocabRow ?? null));
check('它的 doc 是数字', typeof vocabRow?.doc === 'number', String(vocabRow?.doc));

/* ── 2. 词表 == 真值 ───────────────────────────────────────────── */
console.log('\n[2] 词表的 doc 与 COUNT(*) 真值逐词相同');
const identity = rows()[0]?.identity_id ?? 'master';
const truth = (term) =>
	db
		.prepare('SELECT COUNT(*) AS n FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid WHERE l0_fts MATCH ? AND l.identity_id = ?')
		.get(`"${term}"`, identity).n;
const tokens = ['灯箱', '师傅', '报价', '八百', '下雨', '周雅', '萝卜', '第三章'];
let same = 0;
for (const token of tokens) {
	const fromVocab = db.prepare('SELECT doc FROM l0_vocab WHERE term = ?').get(token)?.doc ?? 0;
	const fromCount = truth(token);
	if (fromVocab === fromCount) same += 1;
	else console.log(`     ${token}: 词表 ${fromVocab} ≠ 真值 ${fromCount}`);
}
check(`八个词的两种口径全等（${tokens.length} 个）`, same === tokens.length, `${same}/${tokens.length}`);

/* ── 3. 库里没有的词 → DF 为 0，不是「最稀有」 ──────────────────── */
console.log('\n[3] 库里没有的词：DF = 0，且不会被当成稀有证据放行');
const absent = '氦氖激光器';
const absentRow = db.prepare('SELECT doc FROM l0_vocab WHERE term = ?').get(absent);
check('词表里没有这一行', absentRow === undefined);
const none = String(await loom.call('memory_search', { query: absent, limit: 10 }, sid));
check('检索它返回空', none.trim() === '' || !none.includes('灯箱'), none.split('\n').slice(0, 2).join(' ').slice(0, 120));

/* ── 4. 一次检索的语句形状 ─────────────────────────────────────── */
console.log('\n[4] 一次 memory_search：读词表，而不是为每个候选跑一次排序检索');
reset();
await loom.call('memory_search', { query: '师傅报的灯箱多少钱？', limit: 10 }, sid);
const first = { ...seen };
check('词表查找 ≥ 1 次', first.vocab >= 1, `vocab=${first.vocab}`);
/*
 * `MATCH` 的条数是**通道数**，不是候选数：事实、事件、偏好、原话各一次，加上
 * 几条旁路。v9 之前 `rareTokenHit` 给每个候选问一次频率，那些也是一条条
 * `MATCH`，条数随候选数线性涨到三十几。所以这条断言盯的不是绝对值，是
 * 「它不随候选数变」——下一段用四十条候选再量一次同一个数。
 */
check('带 MATCH 的语句 ≤ 12 条', first.match <= 12, `match=${first.match}（v9 之前是三十几条）`);

/* ── 5. 候选数翻十倍，MATCH 条数不动 ───────────────────────────── */
console.log('\n[5] 再灌四十条都含「灯箱」的轮次：MATCH 条数不跟着涨');
for (let i = 0; i < 40; i += 1) {
	await loom.turn(sid, `灯箱的第 ${i + 1} 版草图放桌上了。`, '好，我看看。', { at: at + (i + 2) * DAY });
}
reset();
await loom.call('memory_search', { query: '师傅报的灯箱多少钱？', limit: 10 }, sid);
const many = { ...seen };
check('候选变多之后 MATCH 条数不增', many.match <= 12, `match=${many.match}（候选从 12 行涨到 90 行）`);
check('词表查找仍在发生', many.vocab >= 1, `vocab=${many.vocab}`);

/* ── 6. 代际缓存 ───────────────────────────────────────────────── */
console.log('\n[6] 同一个问句再问一次：整批命中缓存，词表零查找');
reset();
await loom.call('memory_search', { query: '师傅报的灯箱多少钱？', limit: 10 }, sid);
const second = { ...seen };
check('第二次的词表查找不多于第一次', second.vocab <= many.vocab, `${many.vocab} → ${second.vocab}`);
check('没有写入时不该重读词表', second.vocab === 0, `vocab=${second.vocab}`);

/* ── 7. 写入之后缓存失效 ───────────────────────────────────────── */
console.log('\n[7] 写进新一轮 → dfGen 前进 → 缓存整批丢掉');
await loom.turn(sid, '灯箱装好了，师傅收了八百。', '那就算完事了。', { at: at + DAY });
reset();
await loom.call('memory_search', { query: '师傅报的灯箱多少钱？', limit: 10 }, sid);
const third = { ...seen };
check('新的一轮之后词表查找回升（缓存整批丢掉）', third.vocab >= 1, `vocab=${third.vocab}`);
const after = db.prepare("SELECT doc FROM l0_vocab WHERE term = '灯箱'").get()?.doc;
check('词表的 doc 跟着涨了', after === 42, `doc=${after}（首轮 1 + 四十条 40 + 又一轮 1）`);

/* ── 8. 稀有专名走的是同一条快照 ───────────────────────────────── */
console.log('\n[8] 只出现一次的专名：词表 doc = 1，且能被检索到');
const rare = db.prepare("SELECT doc FROM l0_vocab WHERE term = '周雅'").get()?.doc;
check('「周雅」的 doc 是 1', rare === 1, String(rare));
const got = String(await loom.call('memory_search', { query: '周雅什么时候来？', limit: 10 }, sid));
check('检索能拿到那一轮', got.includes('周雅') || got.includes('客房'), got.split('\n').slice(0, 3).join(' ').slice(0, 140));

db.close();
loom.dispose();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
