/**
 * 2.1 的 79 道漏检，四段漏斗一次量完：写侧有没有 → 闸门杀没杀 → 池子里有没有 → 排第几。
 *
 * 与 `diag-21-gate.mjs` 的区别：那一版只跑 25 题「只我中」，且只问「开闸门出不出来」。
 * 这里跑全量 79 道，并且每题做三次检索，把失败位置定到唯一一段：
 *
 *   q1  原问句 + 开闸门          —— 与产物里的默认结果比，判闸门是否误杀
 *   q2  锚点轮原话当地问句       —— 上界：证据本身当问句还捞不到，就是写侧/池子
 *   db  截止轮的 facts / l0     —— 锚点这句有没有落成可检索的行、状态是否 active
 *
 * 分类：
 *   W  写侧：这句既没落成 fact，也没进任何事件摘要
 *   E  只有事件行带着它（没有对应 fact）
 *   S  有此行但 status != active
 *   G  默认不含、开闸门含        —— 闸门误杀（§65 已知：不能无条件放宽）
 *   P  开闸门也不含，但证据自身当问句能捞到 —— 池子/打分
 *   X  连证据自身当问句都捞不到 —— 索引里没有这一行
 *
 *   node bench-hmb/diag-21-funnel.mjs [--personas M01,M02] [--tag base]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const SURFACE = argOf('surface', `${WORK}/surface-21-0260.jsonl`);
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);
const TAG = argOf('tag', 'base');
const OUT = `${WORK}/diag-funnel-${TAG}.json`;
const WIN = 8;

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) => String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, '');

/** 8 字窗覆盖（同 §68）：<8 字只能判子串。 */
function covers(clause, text) {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < WIN) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + WIN <= c.length; i++) if (t.includes(c.slice(i, i + WIN))) return true;
	return false;
}
/** 返回文本里有几条记忆（`#F/#E/#L` 引用数）。 */
const rowCount = (text) => (String(text).match(/#[FEL]\d/gu) ?? []).length;

/*
* 漏检从取面产物现算，不依赖别的脚本的中间文件。
*
* 判据与 `anchors-21.mjs --source all` 逐字相同：锚点轮用户消息的任一 8 字窗落进
* 块 + 检索摘要 + 展开正文就算命中；锚点轮不足 8 字的题判不了，不进分母。
*/
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));
const exams = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((one) => [one.id, one]));
const surface = new Map(jsonl(SURFACE).map((one) => [one.id, one]));
const turnText = new Map();
const textsOf = (persona) => {
	if (!turnText.has(persona)) {
		const map = new Map(jsonl(path.join(DS, `${persona}.jsonl`)).map((row) => [Number(row['轮次']), row['用户消息'] ?? '']));
		turnText.set(persona, map);
	}
	return turnText.get(persona);
};

const detail = [];
for (const one of surface.values()) {
	const key = keys.get(one.id);
	if (!key || key.kind !== 'main') continue;
	const exam = exams.get(one.id);
	if (!exam) continue;
	const ctx = one.context ?? {};
	const hay = `${ctx.block ?? ''}\n${ctx.search ?? ''}\n${(ctx.expanded ?? []).map((e) => e?.text ?? '').join('\n')}`;
	const anchors = (key.anchors ?? []).map((a) => Number(a.last_turn));
	const judged = anchors.filter((turn) => norm(textsOf(one.persona).get(turn) ?? '').length >= WIN);
	if (!judged.length) continue;
	const hit = judged.some((turn) => covers(textsOf(one.persona).get(turn), hay));
	if (hit) continue;
	detail.push({
		id: one.id,
		persona: one.persona,
		case_id: key.case_id,
		question: exam.question,
		cutoff: exam.cutoff_turn,
		now: exam.now,
		anchorTurns: anchors
	});
}
const rows = [];

for (const persona of PERSONAS) {
	const targets = detail.filter((one) => one.persona === persona).sort((a, b) => a.cutoff - b.cutoff);
	if (!targets.length) continue;
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const byTurn = new Map(turns.map((turn) => [Number(turn['轮次']), turn]));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `funnel-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');

	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	/* 闸门从启动就开：运行时改 `loom.settings` 到不了引擎（§70.7）。 */
	const loom = createLoom({
		dbPath,
		config: {
			consolidation: { triggerTokens: 0 },
			retrieval: { relaxMinOverlap: 0, relaxBelow: 30 }
		}
	});
	const SID = `funnel-${persona}`;
	let cursor = 0;
	try {
		for (const one of targets) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= one.cutoff; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			}
			clock = one.now ? Date.parse(one.now) : clock;
			const anchorTexts = (one.anchorTurns ?? [])
				.map((id) => byTurn.get(Number(id))?.['用户消息'])
				.filter((text) => String(text ?? '').trim().length > 0);
			const searchGate = String(await loom.call('memory_search', { query: one.question, limit: 10 }, SID));
			const probe = String(await loom.call('memory_search', { query: anchorTexts[0] ?? one.question, limit: 10 }, SID));
			rows.push({ ...one, anchorTexts, searchGate, probe });
			console.error(`  ${one.id} cutoff ${one.cutoff}`);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}

	/* 库留在磁盘上等下一步：先读，再删目录。 */
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const facts = db.prepare('SELECT id, text, aliases, status, created_at FROM facts').all();
	const events = db.prepare('SELECT id, title, summary, aliases, status FROM events').all();
	db.close();

	for (const row of rows.filter((one) => one.persona === persona)) {
		const now = Date.parse(row.now);
		const live = facts.filter((fact) => fact.created_at <= now);
		const base = String(surface.get(row.id)?.context?.search ?? '');
		/* 任一条锚点原话的 8 字窗落进文本，就算这句端出来了。 */
		const inText = (text) => row.anchorTexts.some((anchor) => covers(anchor, text));
		const matching = live.filter((fact) => row.anchorTexts.some((anchor) => covers(anchor, fact.text)));
		const active = matching.filter((fact) => fact.status === 'active');
		const episodes = events.filter((event) => row.anchorTexts.some((anchor) => covers(anchor, `${event.title} ${event.summary}`)));
		row.factsMatching = matching.length;
		row.factsActive = active.length;
		row.eventsMatching = episodes.length;
		row.statuses = [...new Set(matching.map((fact) => fact.status))];
		row.rowsBase = rowCount(base);
		row.rowsGate = rowCount(row.searchGate);
		row.inBase = inText(base);
		row.inGate = inText(row.searchGate);
		row.inProbe = inText(row.probe);
		/*
		* 顺序有讲究：**先问「放宽就能捞到吗」，再问「写侧有没有」**。
		*
		* 第一版把 W 放在最前，于是 `M01-G049/d003` 被判成写侧（那一轮确实没落成
		* fact），可它的原话被事件行带着，开闸门就出来了。写成「写侧缺」会把一个
		* 闸门问题永久归到写侧去，而写侧和检索的修法完全不同。
		*/
		if (inText(base)) row.kind = 'T1';
		else if (inText(row.searchGate)) row.kind = 'G';
		else if (inText(row.probe)) row.kind = 'P';
		else if (!matching.length && !episodes.length) row.kind = 'W';
		else if (!matching.length && episodes.length) row.kind = 'E';
		else if (!active.length) row.kind = 'S';
		else row.kind = 'X';
		delete row.searchGate;
		delete row.probe;
	}
}

const counts = {};
for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
const label = {
	W: '写侧：这句既没落成 fact 也没进事件',
	E: '只有事件行带着它（没有对应 fact）',
	S: '有此行但 status != active',
	T1: '产物里其实含（口径问题）',
	G: '默认不含、开闸门含 → 闸门误杀',
	P: '开闸门也不含，但证据当问句能捞到 → 池子/打分',
	X: '连证据当问句都捞不到 → 索引里没有'
};
console.log(`\n漏斗 ${rows.length} 题（surface ${SURFACE}）`);
console.log(`闸门确实开过（与默认结果不同）：${rows.filter((r) => r.rowsGate !== r.rowsBase).length}/${rows.length}`);
for (const kind of ['W', 'E', 'S', 'T1', 'G', 'P', 'X']) console.log(`  ${kind}  ${label[kind]}  ${counts[kind] ?? 0}`);

console.log('\n逐题');
for (const row of rows) {
	console.log(
		`  ${row.id.padEnd(16)} ${row.kind}  fact ${row.factsMatching}/${row.factsActive} [${row.statuses.join(',') || '-'}]  行 ${row.rowsBase}→${row.rowsGate}  「${String(row.anchorTexts[0] ?? '').replace(/\n/gu, ' ').slice(0, 30)}」`
	);
}
fs.writeFileSync(OUT, JSON.stringify({ counts, rows }, null, 1), 'utf8');
console.log(`\n写 ${OUT}`);
