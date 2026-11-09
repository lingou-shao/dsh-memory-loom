/**
 * 两版判分逐题比对（2.1）。用来量「某处改动到底动了哪几题」，而不是只看总分。
 *
 *   node bench-hmb/diff-judge-21.mjs <旧 judgments.jsonl> <新 judgments.jsonl> [dataset 目录]
 *
 * 输出：通过判定的翻转清单（过→挂 / 挂→过）、各红线字段的计数变化、
 * required 三态分布变化、按间隔分桶的变化。总分不在这里算（用 score-21.mjs）。
 */
import fs from 'node:fs';
import path from 'node:path';

const DS = process.argv[4] ?? process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const jsonl = (f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

const oldRows = new Map(jsonl(process.argv[2]).map((r) => [r.id, r]));
const newRows = new Map(jsonl(process.argv[3]).map((r) => [r.id, r]));
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((r) => [r.id, r]));

const pass = (j) => {
	if (!j) return null;
	const req = j.required ?? [];
	return !!req.length
		&& req.every((x) => x === 'met')
		&& !(j.forbidden_hit ?? []).length
		&& !(j.tempting_hit ?? []).length
		&& !(j.unknown_asserted ?? []).length
		&& !j.date_wrong
		&& !j.over_hedged;
};

const stats = (j) => ({
	met: (j?.required ?? []).filter((x) => x === 'met').length,
	partial: (j?.required ?? []).filter((x) => x === 'partial').length,
	missed: (j?.required ?? []).filter((x) => x === 'missed').length,
	forbidden: (j?.forbidden_hit ?? []).length,
	tempting: (j?.tempting_hit ?? []).length,
	unknown: (j?.unknown_asserted ?? []).length,
	dateWrong: !!j?.date_wrong,
	hedged: !!j?.over_hedged
});

const ids = [...keys.keys()].filter((id) => oldRows.has(id) && newRows.has(id));
const onlyOld = [...oldRows.keys()].filter((id) => !newRows.has(id));
const onlyNew = [...newRows.keys()].filter((id) => !oldRows.has(id));

const flips = { up: [], down: [] };
const sums = { old: {}, new: {} };
for (const id of ids) {
	const o = stats(oldRows.get(id));
	const n = stats(newRows.get(id));
	for (const k of Object.keys(o)) {
		if (typeof o[k] === 'boolean') {
			sums.old[k] = (sums.old[k] ?? 0) + (o[k] ? 1 : 0);
			sums.new[k] = (sums.new[k] ?? 0) + (n[k] ? 1 : 0);
		} else {
			sums.old[k] = (sums.old[k] ?? 0) + o[k];
			sums.new[k] = (sums.new[k] ?? 0) + n[k];
		}
	}
	const po = pass(oldRows.get(id));
	const pn = pass(newRows.get(id));
	if (po === true && pn === false) flips.down.push(id);
	if (po === false && pn === true) flips.up.push(id);
}

console.log(`配对题 ${ids.length} 题；旧独有 ${onlyOld.length}、新独有 ${onlyNew.length}`);
console.log('');
console.log('字段合计（旧 → 新）');
for (const k of Object.keys(sums.old)) {
	const d = sums.new[k] - sums.old[k];
	console.log(`  ${k.padEnd(11)} ${String(sums.old[k]).padStart(5)} → ${String(sums.new[k]).padStart(5)}  ${d === 0 ? '=' : d > 0 ? `+${d}` : String(d)}`);
}
console.log('');
console.log(`通过 → 不通过：${flips.down.length} 题`);
console.log('  ' + flips.down.join(' '));
console.log(`不通过 → 通过：${flips.up.length} 题`);
console.log('  ' + flips.up.join(' '));
console.log('');

const tagOf = (id) => (keys.get(id)?.content_tags ?? []).join('/');
const gapOf = (id) => keys.get(id)?.interval_days;
const kindOf = (id) => keys.get(id)?.kind;
for (const [label, list] of [['变差', flips.down], ['变好', flips.up]]) {
	if (!list.length) continue;
	console.log(`${label}的题按考点：`);
	const agg = {};
	for (const id of list) {
		const t = tagOf(id) || '（无标签）';
		agg[t] = (agg[t] ?? 0) + 1;
	}
	for (const [t, c] of Object.entries(agg).sort((a, b) => b[1] - a[1])) console.log(`  ${t.padEnd(20)} ${c}`);
	console.log(`  间隔分布：${list.map((id) => 'd' + gapOf(id)).sort().join(' ')}`);
	console.log('');
}

// over_hedged 的变化单独摊开：这是本次改动最该动的字段
const hedgedOld = ids.filter((id) => oldRows.get(id)?.over_hedged);
const hedgedNew = ids.filter((id) => newRows.get(id)?.over_hedged);
const both = hedgedOld.filter((id) => hedgedNew.includes(id));
console.log(`over_hedged：旧 ${hedgedOld.length} 题、新 ${hedgedNew.length} 题、两版都命中 ${both.length} 题`);
console.log(`  只在旧版：${hedgedOld.filter((id) => !both.includes(id)).join(' ') || '（无）'}`);
console.log(`  只在新版：${hedgedNew.filter((id) => !both.includes(id)).join(' ') || '（无）'}`);
