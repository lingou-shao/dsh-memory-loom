/**
 * 比两次改动的**逐题**定位状态（2.1 开发集）。
 *
 * 总量 +8 可能是「净 +8」也可能是「+20/−12」，而这两种在 200 题上不是一回事：
 * `solidOverlap` 只该「多加东西」，所以方向判据是**变坏的题必须为 0**，不是净值为正。
 * 每次改动都先跑这份差集，再决定要不要看总量。
 *
 * 输入是 `anchors-21.mjs --json` 的两份明细（同一个人物、同一窗长）：
 *
 *   node bench-hmb/anchors-21.mjs --surface A.jsonl --json a.json
 *   node bench-hmb/anchors-21.mjs --surface B.jsonl --json b.json
 *   node bench-hmb/diff-surface-21.mjs a.json b.json
 *
 * 只看命中状态翻转（miss→hit / hit→miss）。`unjudgeable` 不参与，它不是读数。
 */
import fs from 'node:fs';

const [before, after] = process.argv.slice(2);
if (!before || !after) {
	console.error('用法: node bench-hmb/diff-surface-21.mjs <before.json> <after.json>');
	process.exit(2);
}
/** 明细里没有 persona 列，从题号前缀取（`M01-G026/d000`）。 */
const personaOf = (id) => String(id).slice(0, 3);
const load = (file) => {
	const detail = JSON.parse(fs.readFileSync(file, 'utf8'));
	return { detail, rows: new Map(detail.rows.map((one) => [one.id, one])) };
};
const a = load(before);
const b = load(after);

const better = [];
const worse = [];
let same = 0;
for (const [id, one] of b.rows) {
	const old = a.rows.get(id);
	if (!old) continue;
	// 判不了的题在两边都不是读数，翻转也不算。
	if (old.state === 'unjudgeable' || one.state === 'unjudgeable') continue;
	if (old.state === one.state) {
		same++;
		continue;
	}
	// 锚点级的变化：+ 表示这次多进了要点，− 表示少进了。
	const delta = one.anchors.reduce((sum, cur, i) => sum + (Number(cur.hit === true) - Number(old.anchors[i]?.hit === true)), 0);
	(one.state === 'hit' ? better : worse).push({ id, persona: personaOf(id), bucket: one.bucket, delta });
}

const label = (file) => file.split(/[\\/]/).pop();
console.log(`${label(before)} → ${label(after)}   同口径 ${same + better.length + worse.length} 题`);
console.log(`  变好 ${better.length}   变坏 ${worse.length}   不变 ${same}`);
console.log(`  上界 ${a.detail.upper.hit}/${a.detail.upper.judged} → ${b.detail.upper.hit}/${b.detail.upper.judged}`);
console.log(`  下界 ${a.detail.lower.all}/${a.detail.lower.judged} → ${b.detail.lower.all}/${b.detail.lower.judged}`);
console.log(`  平均覆盖 ${a.detail.coverage.toFixed(3)} → ${b.detail.coverage.toFixed(3)}`);
const list = (title, rows) => {
	if (rows.length === 0) return;
	console.log(`\n${title}（${rows.length}）：`);
	for (const one of rows) console.log(`  ${one.id.padEnd(18)} ${one.persona.padEnd(4)} d${String(one.bucket).padEnd(4)} 锚点净 ${one.delta > 0 ? '+' : ''}${one.delta}`);
};
list('变好', better);
list('变坏', worse);
if (worse.length === 0) console.log('\n变坏 0 题：这次改动是纯追加。');
