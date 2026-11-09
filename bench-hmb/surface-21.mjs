/**
 * Benchmark 2.1 的取面脚本（开发集 212 题）。
 *
 * 1.0 那套（surface-coverage.mjs）是「证据原话在不在这几个面上」，需要
 * grading/evidence.jsonl 里的 fact 引文。2.1 的答案键只给 anchors（轮次 + 时间），
 * 没有引文，所以这里不量覆盖面，只**照评测程序的接口把记忆文本取出来**：
 * 注入块 + 搜索行 + 前两条指针的展开正文——就是答题模型真正会看到的那三段。
 *
 * 与官方 runner 的对齐点（逐条对过 benchmark-2.1/harness/bench21/runner.py）：
 *   - 只灌到 cutoff_turn 为止，一轮不多（`while pos < cutoff`）；
 *   - 灌完把钟拨到题目的 `now`（`clock = exam.now`），再检索；
 *   - 提取是只读的：只调 memory_search / memory_expand，不写；
 *   - 输出里带 `leak_turns`：从取回的文本里抠 `#L<轮次>`，凡大于 cutoff 的记下来。
 *     我们按构造不可能越界（库里根本没有未来的轮），这一列是「按构造」的证据。
 *
 *   node bench-hmb/surface-21.mjs                 # 两个人物全卷
 *   node bench-hmb/surface-21.mjs --personas M01
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const OUT = process.env.CMB21_OUT ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/surface-21.jsonl';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const LIMIT = Number(argOf('limit', 10));
const EXPANDS = Number(argOf('expands', 2));
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);
/** 冒烟用：每个人物只取前 N 题（按 cutoff 升序），量接口不量成绩。 */
const N = Number(argOf('n', 0));

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/**
 * 从一段文本里抠出所有 `#L<起始>(-<结束>)?`。
 * 注意：这是 L0 的**行号**，不是轮次——一轮对话两行（用户一条、助手一条），
 * 所以 `#L31-34` 是第 16–17 轮。拿它直接跟 `cutoff_turn` 比会误报一倍（第一版就这么错了）。
 * 真正的越界判定在 `check-21-leak.mjs` 里，回库查 `turn` 列。
 */
function l0Refs(text) {
	const out = [];
	for (const m of String(text).matchAll(/#L(\d+)(?:-(\d+))?/gu)) out.push([Number(m[1]), Number(m[2] ?? m[1])]);
	return out;
}

const rows = [];
for (const persona of PERSONAS) {
	const mine = exams.filter((one) => one.persona === persona).sort((a, b) => a.cutoff_turn - b.cutoff_turn);
	if (N > 0) mine.splice(N);
	if (mine.length === 0) continue;
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `s21-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');

	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;

	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const SID = `s21-${persona}`;
	let cursor = 0;
	let previous = null;
	try {
		for (const exam of mine) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
				previous = at;
			}
			clock = Math.max(clock, Date.parse(exam.now));
			const block = String(loom.memoryBlock(SID));
			const search = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, SID));
			const refs = [...String(search).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]);
			const expanded = [];
			for (const ref of refs.slice(0, EXPANDS)) {
				try {
					expanded.push({ ref, text: String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)) });
				} catch (error) {
					expanded.push({ ref, text: '', error: String(error?.message ?? error) });
				}
			}
			const all = [block, search, ...expanded.map((one) => one.text)].join('\n');
			rows.push({
				id: exam.id,
				persona,
				cutoff_turn: exam.cutoff_turn,
				now: exam.now,
				question: exam.question,
				context: { block, search, expanded },
				refs: l0Refs(all).map(([from, to]) => `${from}-${to}`)
			});
			if (rows.length % 10 === 0) console.error(persona, rows.length, '题', 'cursor', cursor, '/', turns.length);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}

	/*
	 * 越界判定要回库查 `turn` 列：`#L` 是行号不是轮次，直接比会误报一倍。
	 * 这里在同一个库上开只读连接，把每题抓到的行号映射成轮次，再跟 cutoff 比。
	 */
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const turnOf = new Map(db.prepare('SELECT id, turn FROM l0').all().map((row) => [row.id, row.turn]));
	db.close();
	for (const row of rows.filter((one) => one.persona === persona)) {
		let worst = 0;
		for (const span of row.refs) {
			const [from, to] = span.split('-').map(Number);
			for (let id = from; id <= to; id++) worst = Math.max(worst, turnOf.get(id) ?? 0);
		}
		row.max_turn_seen = worst;
		row.leak_turns = worst > row.cutoff_turn;
		delete row.refs;
	}
	console.error(persona, '完成', mine.length, '题；库', (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1), 'MB');
}

fs.writeFileSync(OUT, rows.map((one) => JSON.stringify(one)).join('\n') + '\n', 'utf8');
const leaks = rows.filter((one) => one.leak_turns).map((one) => one.id);
const sizes = rows.map((one) => one.context.block.length + one.context.search.length);
console.log(`写 ${OUT}：${rows.length} 题，越界 ${leaks.length} 条`, leaks.slice(0, 5));
console.log('记忆文本长度中位', sizes.sort((a, b) => a - b)[sizes.length >> 1], '字');
