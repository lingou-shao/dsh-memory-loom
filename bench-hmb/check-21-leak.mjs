/**
 * 2.1 泄漏哨兵的**正确**口径。
 *
 * 第一版拿 `#L<n>` 里的 n 直接跟 `cutoff_turn` 比，报出 147 条「越界」——那是错的：
 * `#L` 是 L0 表的行号，一轮对话占两行（用户一条、助手一条），所以 `#L31-34` 实际
 * 是第 16–17 轮，不是第 31–34 轮。一个 3000 轮的历史，L0 有 5986 行，两边差一个
 * 约 2 倍的因子，误报就是这么来的。
 *
 * 正确做法：把抓到的 `#L` 行号回库里查 `turn` 列，再看有没有大于 cutoff 的。
 *
 *   node bench-hmb/check-21-leak.mjs <surface.jsonl> <personaDb> [...]
 *   例：node check-21-leak.mjs work/surface-21.jsonl "C:/…/s21-M01-xxx/loom.db: M01" ...
 */
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [src, ...pairs] = process.argv.slice(2);
if (!src || pairs.length === 0) {
	console.error('用法: node check-21-leak.mjs <surface.jsonl> <M01:dbPath> [M02:dbPath]');
	process.exit(1);
}

const dbs = new Map();
for (const pair of pairs) {
	const i = pair.indexOf('=');
	const persona = pair.slice(0, i);
	const dbPath = pair.slice(i + 1);
	const db = new DatabaseSync(dbPath, { readOnly: true });
	dbs.set(persona, {
		db,
		turnOf: new Map(db.prepare('SELECT id, turn FROM l0').all().map((row) => [row.id, row.turn]))
	});
}

const rows = fs.readFileSync(src, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const bad = [];
const stat = { rows: 0, refs: 0, maxTurnSeen: {} };
for (const row of rows) {
	const pack = dbs.get(row.persona);
	if (pack === undefined) continue;
	stat.rows++;
	const text = [row.context?.block ?? '', row.context?.search ?? '', ...(row.context?.expanded ?? []).map((one) => one.text ?? '')].join('\n');
	const refs = [...text.matchAll(/#L(\d+)(?:-(\d+))?/gu)].map((m) => [Number(m[1]), Number(m[2] ?? m[1])]);
	let worst = 0;
	let worstTurn = 0;
	for (const [from, to] of refs) {
		for (let id = from; id <= to; id++) {
			const turn = pack.turnOf.get(id);
			if (turn === undefined) continue;
			stat.refs++;
			if (turn > worstTurn) {
				worstTurn = turn;
				worst = id;
			}
		}
	}
	stat.maxTurnSeen[row.persona] = Math.max(stat.maxTurnSeen[row.persona] ?? 0, worstTurn);
	if (worstTurn > row.cutoff_turn) bad.push({ id: row.id, cutoff: row.cutoff_turn, refL0: worst, turn: worstTurn });
}

console.log(JSON.stringify({ ...stat, leaks: bad.length, sample: bad.slice(0, 5) }, null, 1));
