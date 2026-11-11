/**
 * 2.1 的 79 道漏检，按「问句与证据原话的字面交集」分类。
 *
 * 起因（docs/design.md §85.3 第 2 条）：判「检索真缺」之前先问一句——这一条是被
 * 检索挡掉的，还是被压缩口径挡掉的？2.1 上的漏检有 79 道，如果直接去改排序，会
 * 分不清「换说法挡的」和「根本没提」。这个脚本只做一件事：把问句和证据原话拆成
 * 同一套内容二元组（与 lib 的 `tokensOf` / `isThinToken` 同一套定义），数交集。
 *
 * 三类（判据是先验可算的，不需要回放）：
 *   Z  零共享      —— 与任一锚点轮的用户原话没有共享内容二元组
 *   T  仅泛词      —— 有共享，但每个共享二元组在全卷的 DF > --df（默认 8，约 0.5%）
 *   R  稀有词共享  —— 至少一个共享二元组 DF <= --df
 *
 * Z 是「换说法挡的」下界（字面通道按构造够不着），R 是「字面已经给出线索却仍没
 * 召回」的集合 —— 只有 R 里的题才可能靠排序/闸门/条数救回来。T 介于两者之间。
 *
 *   node bench-hmb/diag-21-share.mjs [--surface FILE] [--df 8] [--show 20]
 */
import fs from 'node:fs';
import path from 'node:path';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const SURFACE = argOf('surface', `${WORK}/surface-21-v0254.jsonl`);
const DF_MAX = Number(argOf('df', 8));
const SHOW = Number(argOf('show', 20));

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const THIN_CHARS = new Set([
	...'怎么什哪几谁啥呀吗呢吧啊嘛的了是在和与就也都还又再只才而且或不没我你他她它们这那个些后前当时今明昨天年月日号点早晚最初先次来'
]);

/** 与 lib `isThinToken` 同一判据（数字/拉丁算实词；「我爸」放行）。 */
function isThin(token) {
	if (/\d/u.test(token) || /[A-Za-z]/u.test(token)) return false;
	if ('我你他她它们'.includes(token[0]) && !THIN_CHARS.has(token[1])) return false;
	return [...token].some((char) => THIN_CHARS.has(char));
}
/** 与 lib `tokensOf` 同一判据，只留内容二元组。 */
function contentPairs(text) {
	const out = new Set();
	for (const match of String(text ?? '').matchAll(CJK_RUN)) {
		const chars = [...match[0]];
		for (let i = 0; i + 1 < chars.length; i++) {
			const token = `${chars[i]}${chars[i + 1]}`;
			if (!isThin(token)) out.add(token);
		}
	}
	return out;
}

const detail = jsonl(`${WORK}/prf-21-detail.jsonl`).filter((one) => one.state === 'miss');
const surface = new Map(jsonl(SURFACE).map((one) => [one.id, one]));

const personas = [...new Set(detail.map((one) => one.persona))];
const rows = [];
for (const persona of personas) {
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const byTurn = new Map(turns.map((turn) => [Number(turn['轮次']), turn]));
	/* DF 在全卷上算：题目的 cutoff 不同，但「这个词有多常见」是语料的属性。 */
	const df = new Map();
	for (const turn of turns) {
		for (const token of contentPairs(turn['用户消息'])) df.set(token, (df.get(token) ?? 0) + 1);
	}
	for (const one of detail.filter((row) => row.persona === persona)) {
		const q = contentPairs(one.question);
		const ids = (one.anchorTurns ?? []).map(Number);
		const missing = ids.filter((id) => !byTurn.has(id));
		const perAnchor = ids
			.filter((id) => byTurn.has(id))
			.map((id) => {
				const text = byTurn.get(id)['用户消息'];
				const pairs = contentPairs(text);
				const shared = [...q].filter((token) => pairs.has(token));
				return {
					turn: id,
					text,
					shared,
					rare: shared.filter((token) => (df.get(token) ?? 0) <= DF_MAX)
				};
			});
		const best = perAnchor.slice().sort((a, b) => b.rare.length - a.rare.length || b.shared.length - a.shared.length)[0];
		const rare = perAnchor.flatMap((one2) => one2.rare);
		const sharedAll = perAnchor.flatMap((one2) => one2.shared);
		const kind = missing.length === ids.length ? 'X' : rare.length > 0 ? 'R' : sharedAll.length > 0 ? 'T' : 'Z';
		const search = String(surface.get(one.id)?.context?.search ?? '');
		rows.push({
			id: one.id,
			persona,
			question: one.question,
			anchorTurns: ids,
			missing,
			kind,
			sharedAll: [...new Set(sharedAll)],
			rare: [...new Set(rare)],
			rareDF: [...new Set(rare)].map((token) => `${token}:${df.get(token) ?? 0}`),
			bestTurn: best?.turn ?? null,
			bestText: best?.text ?? null,
			searchLen: search.length,
			searchRows: (search.match(/#[FEL]\d/gu) ?? []).length
		});
	}
}

const counts = {};
for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
const label = {
	Z: '零共享：字面通道按构造够不着',
	T: `仅泛词共享（DF > ${DF_MAX}）`,
	R: `稀有词共享（DF <= ${DF_MAX}）：字面有线索却没召回`,
	X: '锚点轮不在语料里'
};
console.log(`漏检 ${rows.length} 题   DF 门槛 ${DF_MAX}`);
for (const kind of ['Z', 'T', 'R', 'X']) console.log(`  ${kind}  ${label[kind]}  ${counts[kind] ?? 0}`);

for (const kind of ['R', 'T', 'Z']) {
	const list = rows.filter((row) => row.kind === kind);
	if (!list.length) continue;
	console.log(`\n=== ${kind} 前 ${Math.min(SHOW, list.length)} 题 ===`);
	for (const row of list.slice(0, SHOW)) {
		console.log(`${row.id}  Q: ${row.question}`);
		console.log(
			`   anchor ${row.anchorTurns.join(',')} | 共享 ${row.sharedAll.length} 个${
				row.rare.length ? `，稀有 ${row.rareDF.join(' ')}` : ''
			} | 搜索 ${row.searchRows} 行`
		);
		console.log(`   最相关锚点 t${row.bestTurn}: ${String(row.bestText ?? '').slice(0, 60)}`);
	}
}
fs.writeFileSync(`${WORK}/diag-21-share.json`, JSON.stringify({ counts, dfMax: DF_MAX, rows }, null, 1), 'utf8');
console.log(`\n写 ${WORK}/diag-21-share.json`);
