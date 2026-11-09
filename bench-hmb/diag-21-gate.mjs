/**
 * 闸门到底杀没杀 —— 唯一能问出这个问题的做法：**从启动就用开闸门的配置**建引擎。
 *
 * `apply()` 里 `const engineConfig = toEngineConfig(config)` 是新建对象，所以运行时改
 * `loom.settings.retrieval.*` 不会到达引擎（实测 `minScore=0.99` 也清空不了结果）。
 * 只能在 createLoom 时就把 relaxMinOverlap 设 0、relaxBelow 设 30（schema 上限，够用）。
 *
 * 默认口径不重跑：直接用 0.2.54 取面产物里的 `context.search`（同一版、同一钟）。
 * 于是每题只有一次检索：开闸门的那次；跟产物里那次比。
 *
 *   node bench-hmb/diag-21-gate.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const SURFACE = `${WORK}/surface-21-v0254.jsonl`;
const DETAIL = `${WORK}/prf-21-detail.jsonl`;
const OUT = `${WORK}/diag-gate-${process.env.TAG ?? 'x'}.json`;
const WIN = 8;
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const OVERLAP = Number(argOf('overlap', 0));
const BELOW = Number(argOf('below', 30));

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) =>
	String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, '');
function covers(clause, text) {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < 8) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + WIN <= c.length; i++) if (t.includes(c.slice(i, i + WIN))) return true;
	return false;
}

const surface = new Map(jsonl(SURFACE).map((one) => [one.id, one]));
const targets = jsonl(DETAIL).filter((one) => one.state === 'miss' && one.baseHit);
const byPersona = new Map();
for (const one of targets) {
	if (!byPersona.has(one.persona)) byPersona.set(one.persona, []);
	byPersona.get(one.persona).push(one);
}

const rows = [];
for (const [persona, list] of byPersona) {
	list.sort((a, b) => a.cutoff - b.cutoff);
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gate-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');

	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	/* 开闸门从启动就生效 */
	const loom = createLoom({
		dbPath,
		config: {
			consolidation: { triggerTokens: 0 },
			retrieval: { relaxMinOverlap: OVERLAP, relaxBelow: BELOW }
		}
	});
	const SID = `gate-${persona}`;
	let cursor = 0;
	try {
		for (const one of list) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= one.cutoff; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			}
			clock = one.now ? Date.parse(one.now) : clock;
			const searchGate = String(await loom.call('memory_search', { query: one.question, limit: 10 }, SID));
			rows.push({ ...one, searchGate });
			console.error(`  ${one.id} cutoff ${one.cutoff} 完成`);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}

	const db = new DatabaseSync(dbPath, { readOnly: true });
	const facts = db.prepare('SELECT id, text, status, created_at FROM facts').all();
	db.close();
	fs.rmSync(dir, { recursive: true, force: true });

	for (const row of rows.filter((one) => one.persona === persona)) {
		const clause = row.coveringText ?? '';
		const live = facts.filter((f) => f.created_at <= Date.parse(row.now));
		const matching = live.filter((f) => covers(clause, f.text));
		const base = String(surface.get(row.id)?.context?.search ?? '');
		row.hasFact = matching.length > 0;
		row.inBase = covers(clause, base);
		row.inGate = covers(clause, row.searchGate);
		row.gateDiffers = base !== row.searchGate;
		row.kind = !matching.length ? 'W' : row.inGate ? 'G' : 'O';
	}
}

const counts = {};
for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
console.log(`\n放宽准入回放 ${rows.length} 题  relaxMinOverlap=${OVERLAP} relaxBelow=${BELOW}`);
console.log(`配置确实生效（开闸门结果与产物里的默认结果不同）：${rows.filter((r) => r.gateDiffers).length}/${rows.length}`);
console.log(`事实存在：${rows.filter((r) => r.hasFact).length}`);
console.log('  分类（只对存在事实的题有意义）：');
for (const [kind, label] of [['G', '开闸门就出现了 → 闸门误杀'], ['O', '开闸门也不出现 → 候选条数/打分'], ['W', '事实不存在（写侧）']]) {
	console.log(`    ${kind}  ${label}  ${counts[kind] ?? 0}`);
}
console.log('\n逐题');
for (const row of rows) {
	console.log(
		`  ${row.id.padEnd(16)} ${row.kind}  事实${row.hasFact ? '有' : '无'}  默认${row.inBase ? '含' : '不含'}  开闸门${row.inGate ? '含' : '不含'}  「${String(row.coveringText).slice(0, 26)}」`
	);
}
fs.writeFileSync(OUT, JSON.stringify({ counts, rows: rows.map(({ searchGate, ...rest }) => rest) }, null, 1), 'utf8');
console.log(`\n写 ${OUT}`);
