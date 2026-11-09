/**
 * 2.1 上那 57 道「材料一点影子都没有」的失败，是查不到还是问法不对？
 *
 * surface-21.mjs 每题只给一次 `memory_search`（原始问句）+ 前两条展开，这是
 * 一个很薄的工具预算。所以「三面里没有锚点原话」这件事有两种解释：
 *
 *   (a) 库里根本没有可检索的坐标 —— 事件没落成带 source 区间的行，换什么问句
 *       都捞不回来。这是结构缺口，得动写侧或索引。
 *   (b) 有，但只有问对了才浮上来 —— 原始问句没有共享词、或者被别的候选顶掉。
 *       这是问法/排序问题，动检索启发式。
 *
 * 判据用同一份答案键的 `anchors[].last_turn`：把 `memory_search` 返回行里的
 * `#L<起>-<止>` 映射回轮次（L0 行号 ≠ 轮次，一轮两行），看有没有哪条结果
 * 的来源区间盖住锚点轮。三种问句各跑一遍：
 *
 *   q1 原句            —— 复现 surface-21 的那一次
 *   q2 去虚词的关键词   —— 模拟「模型换个说法再搜一次」
 *   q3 锚点轮的原话     —— 上界：问句就是证据本身时能不能捞到
 *
 *   node bench-hmb/probe-21-miss.mjs                 # 默认取 8 题（按 cutoff 升序）
 *   node bench-hmb/probe-21-miss.mjs --n 16 --personas M02
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = process.env.CMB21_WORK ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const N = Number(argOf('n', 8));
const LIMIT = Number(argOf('limit', 10));
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

/** 虚词/问句壳：只留内容词，模拟模型「换个说法再搜一次」。 */
const SHELL = /(?:你|我|咱|他|她|它|的|了|吗|吧|呢|啊|呀|着|过|是|在|有|和|跟|把|被|就|都|还|也|又|这|那|个|次|会|要|能|得|地|一|下|说|问|记|得|帮|给|对|吧|来着|是不是|有没有|怎么样|什么)/gu;
const keyOf = (question) => question.replace(/[？?！!。，,、；;：「」“”"'（）()\s]/gu, ' ').replace(SHELL, ' ').replace(/\s+/gu, ' ').trim();

function spans(text) {
	const out = [];
	for (const m of String(text).matchAll(/#L(\d+)(?:-(\d+))?/gu)) out.push([Number(m[1]), Number(m[2] ?? m[1])]);
	return out;
}

const exams = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((one) => [one.id, one]));
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));
const judged = new Map(jsonl(path.join(WORK, 'judgments.jsonl')).map((one) => [one.id, one]));
const surfaces = new Map(jsonl(path.join(WORK, 'surface-21.jsonl')).map((one) => [one.id, one]));

const pass = (j) => {
	const req = j?.required ?? [];
	return Boolean(req.length) && req.every((x) => x === 'met') && !(j.forbidden_hit ?? []).length
		&& !(j.tempting_hit ?? []).length && !(j.unknown_asserted ?? []).length && !j.date_wrong && !j.over_hedged;
};

/* 重算「三面里没有锚点影子」的那批，口径与诊断脚本一致（8 字窗口足够排除巧合）。 */
const norm = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
const grams = (s, n = 8) => {
	const t = norm(s);
	const out = new Set();
	for (let i = 0; i + n <= t.length; i += 1) out.add(t.slice(i, i + n));
	return out;
};
const turnText = {};
const candidates = [];
for (const [id, exam] of exams) {
	if (pass(judged.get(id))) continue;
	const key = keys.get(id);
	const surface = norm((surfaces.get(id)?.context.block ?? '') + (surfaces.get(id)?.context.search ?? '')
		+ (surfaces.get(id)?.context.expanded ?? []).map((one) => one.text).join(''));
	turnText[exam.persona] ??= jsonl(path.join(DS, `${exam.persona}.jsonl`));
	let hit = false;
	for (const anchor of key.anchors ?? []) {
		const turn = turnText[exam.persona][anchor.last_turn - 1];
		if (turn === undefined) continue;
		for (const gram of grams(turn['用户消息'] + turn['助手回复'])) if (surface.includes(gram)) { hit = true; break; }
		if (hit) break;
	}
	if (!hit) candidates.push({ id, exam, key });
}

const out = [];
const realNow = Date.now;
for (const persona of PERSONAS) {
	const mine = candidates.filter((one) => one.exam.persona === persona).sort((a, b) => a.exam.cutoff_turn - b.exam.cutoff_turn).slice(0, N);
	if (mine.length === 0) continue;
	const turns = turnText[persona] ?? jsonl(path.join(DS, `${persona}.jsonl`));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `p21m-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const SID = `p21m-${persona}`;
	let cursor = 0;
	try {
		for (const one of mine) {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= one.exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			}
			clock = Math.max(clock, Date.parse(one.exam.now));
			const anchorTurns = (one.key.anchors ?? []).map((a) => a.last_turn);
			const anchorText = String(turnText[persona][(anchorTurns[0] ?? 1) - 1]?.['用户消息'] ?? '').slice(0, 60);
			const queries = [
				['q1原句', one.exam.question],
				['q2关键词', keyOf(one.exam.question)],
				['q3锚点原话', anchorText]
			];
			const result = { id: one.id, anchorTurns, picks: {} };
			for (const [label, query] of queries) {
				if (!query) { result.picks[label] = null; continue; }
				const text = String(await loom.call('memory_search', { query, limit: LIMIT }, SID));
				result.picks[label] = { query, covered: spans(text) };
			}
			out.push(result);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const turnOf = new Map(db.prepare('SELECT id, turn FROM l0').all().map((row) => [row.id, row.turn]));
	db.close();
	for (const row of out.filter((one) => one.id.startsWith(persona))) {
		for (const pick of Object.values(row.picks)) {
			if (pick === null) continue;
			pick.hit = pick.covered.some(([from, to]) => {
				for (let id = from; id <= to; id++) if (row.anchorTurns.includes(turnOf.get(id))) return true;
				return false;
			});
			pick.leak = pick.covered.some(([from, to]) => {
				for (let id = from; id <= to; id++) if ((turnOf.get(id) ?? 0) > (exams.get(row.id)?.cutoff_turn ?? 0)) return true;
				return false;
			});
			delete pick.covered;
		}
	}
}

console.log(JSON.stringify(out, null, 1));
const labels = ['q1原句', 'q2关键词', 'q3锚点原话'];
const tally = Object.fromEntries(labels.map((k) => [k, 0]));
for (const row of out) for (const k of labels) if (row.picks[k]?.hit) tally[k] += 1;
console.log(`\n样本 ${out.length} 题（原句那一次三面全无影的那批）`);
for (const k of labels) console.log(`  ${k.padEnd(8)} 命中锚点轮 ${tally[k]}/${out.length}`);
console.log('  越界', out.filter((one) => Object.values(one.picks).some((p) => p?.leak)).length);
