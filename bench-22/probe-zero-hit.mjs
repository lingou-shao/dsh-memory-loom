/**
 * 「二元什么都搜不到」到底发生过几次 —— 四趟检索的空结果率。
 *
 * 主检索是四趟叠起来的（§116 那一版起没变过）：
 *
 *   1. 严格   `compileMatch` 把问句的内容二元组**全部 AND** 起来。长句几乎必空。
 *   2. 放宽   严格命中 < `relaxBelow`(3) 时，`compileLooseMatch` 取前 12 个二元组做 OR，
 *             再过 `relaxMinOverlap`(0.25) 那道「问句覆盖率」闸门。
 *   3. 槽链   `slotFacts`，问「改过几次」时用。
 *   4. 原话   `compileLooseMatch(query, 200)` 全句 OR，bm25 排序，只读前几行。
 *
 * 空结果只能发生在「四趟都没有一行活下来」的时候。这个脚本把那四趟一层层拆开量：
 * 严格单独跑是空的多少次、加上放宽之后、加上原话之后。配置只能在 `createLoom` 时给
 * （`probe-gate-effect.mjs` 记过原因：运行时改 `loom.settings` 没有人读）。
 *
 * 口径限制，写在这里免得读错：
 *   - 库是**终态**（整个 history 灌完）不是每题截止轮，记忆比答题时更全，
 *     所以这里量出的空结果率是**偏低**的（对「要不要加兜底」这个判断是有利方向）。
 *   - `now` 用真实时钟，不按题干时点；due 区的内容会不同，但空结果只看词面命中。
 *
 *   node bench-22/probe-zero-hit.mjs --db bench-22/work/db/M02-5413.db --persona M02
 */
import fs from 'node:fs';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(process.env.HOME ?? '', 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset')
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));
if (!DATA) throw new Error('找不到题库：设 BENCH22_DATA');

const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB = argOf('db', path.join(HERE, 'work', 'db', 'M02-5413.db'));
const PERSONA = argOf('persona', 'M02');
const LIMIT = Number(argOf('limit', 10));

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const ALL = jsonl(path.join(DATA, 'exam-inputs.jsonl'));
const items = ALL.filter((row) => row.persona === PERSONA);
const refsOf = (text) => [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
const rowsOf = (text) => String(text).split('\n').filter((line) => /^\s*\d+\./.test(line)).length;

const ARMS = [
	['四趟默认', {}],
	['严格 + 放宽（关原话）', { rawSearch: false }],
	['只有严格 AND（关放宽、关原话）', { relaxMatch: false, rawSearch: false }]
];

console.log(`题 ${items.length}（${PERSONA}）· 库 ${DB} · 终态，非截止轮`);

for (const [armIndex, [label, override]] of ARMS.entries()) {
	const dir = path.join(HERE, 'work', `zero-arm${armIndex}`);
	fs.mkdirSync(dir, { recursive: true });
	const dbPath = path.join(dir, 'loom.db');
	fs.copyFileSync(DB, dbPath);
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 }, retrieval: override } });
	let empty = 0;
	let emptyNoRefs = 0;
	const samples = [];
	for (const item of items) {
		const out = String(await loom.call('memory_search', { query: item.question, limit: LIMIT }, 'probe'));
		const emptyText = out.includes('没有找到相关记忆') || rowsOf(out) === 0;
		if (emptyText) empty += 1;
		if (refsOf(out).length === 0) emptyNoRefs += 1;
		if (emptyText && samples.length < 5) samples.push(item.id + ' 「' + item.question.slice(0, 24) + '」');
	}
	console.log(
		`${label.padEnd(26)} 空结果 ${String(empty).padStart(3)}/${items.length} = ${((empty / items.length) * 100).toFixed(1)}%` +
			`  · 无 ref ${emptyNoRefs}`
	);
	if (samples.length) for (const one of samples) console.log(`    ${one}`);
	await loom.close?.();
}
