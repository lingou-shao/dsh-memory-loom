/**
 * 2.1 计分：按官方规则算 A、流量加权 A、对照题、成对通过。
 *
 * 规则照抄 benchmark-2.1/harness/bench21/scoring.py，只把「判分模型输出的 JSON」
 * 换成我们自己逐题判出来的同一结构：
 *   {id, required:["met"|"partial"|"missed"...], forbidden_hit:[序号], tempting_hit:[序号],
 *    unknown_asserted:[序号], date_wrong:bool, over_hedged:bool}
 *
 * 通过判据（judge_pass）：required 非空且**全部 met**，且没有命中 forbidden / tempting /
 * unknown_asserted / date_wrong / over_hedged。注意 partial 也算不通过。
 *
 *   node bench-hmb/score-21.mjs <judgments.jsonl> [数据集目录]
 */
import fs from 'node:fs';
import path from 'node:path';

const JUDGE = process.argv[2];
const DS = process.argv[3] ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
if (!JUDGE) {
	console.error('用法: node score-21.mjs <judgments.jsonl> [datasetDir]');
	process.exit(1);
}

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const inputs = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((row) => [row.id, row]));
const key = jsonl(path.join(DS, 'answer-key.jsonl'));
const judge = new Map(jsonl(JUDGE).map((row) => [row.id, row]));

/** 官方 TRAFFIC_BINS：1h 54%、当天 25%、1–3d 9%、4–7d 5%、8–30d 6%、>30d 1%。 */
const BINS = [[3600, 0.54], [86400, 0.25], [4 * 86400, 0.09], [8 * 86400, 0.05], [31 * 86400, 0.06], [Infinity, 0.01]];
const SEVERE = 2;

const binOf = (age) => {
	if (age === null || age === undefined) return 0;
	for (let i = 0; i < BINS.length; i++) if (age < BINS[i][0]) return i;
	return BINS.length - 1;
};

function passOf(j) {
	const req = j.required ?? [];
	const ok = req.length > 0 && req.every((x) => x === 'met');
	return Boolean(ok && !(j.forbidden_hit?.length) && !(j.tempting_hit?.length) &&
		!(j.unknown_asserted?.length) && !j.date_wrong && !j.over_hedged);
}

function pointsOf(j) {
	const req = j.required ?? [];
	if (req.length === 0) return 0;
	return req.reduce((sum, x) => sum + ({ met: 1, partial: 0.5 }[x] ?? 0), 0) / req.length;
}

const items = key.map((row) => {
	const exam = inputs.get(row.id) ?? {};
	const ages = (row.anchors ?? []).map((one) => one.age_seconds).filter((one) => one !== null && one !== undefined);
	return {
		...exam,
		...row,
		group_age_seconds: row.group_age_seconds ?? (ages.length > 0 ? Math.min(...ages) : null),
		question: exam.question,
		now: exam.now
	};
});

const report = {};
for (const persona of [...new Set(items.map((one) => one.persona))].sort()) {
	const mine = items.filter((one) => one.persona === persona);
	const judged = mine.filter((one) => judge.has(one.id));
	const missing = mine.filter((one) => !judge.has(one.id)).map((one) => one.id);
	const scored = judged.map((one) => ({ one, j: judge.get(one.id), pass: passOf(judge.get(one.id)) }));
	const main = scored.filter((x) => x.one.kind === 'main');
	const ctl = scored.filter((x) => x.one.kind === 'control');

	const counts = {};
	for (const x of main) counts[binOf(x.one.group_age_seconds)] = (counts[binOf(x.one.group_age_seconds)] ?? 0) + 1;
	const share = Object.keys(counts).reduce((sum, b) => sum + BINS[b][1], 0);
	const weight = new Map();
	for (const x of main) {
		const b = binOf(x.one.group_age_seconds);
		const base = BINS[b][1] / share / counts[b];
		weight.set(x.one.id, base * ((x.one.rubric?.severity === 'severe') ? SEVERE : 1));
	}
	const wTotal = [...weight.values()].reduce((a, b) => a + b, 0);
	const weighted = 100 * main.filter((x) => x.pass).reduce((sum, x) => sum + weight.get(x.one.id), 0) / (wTotal || 1);

	const groups = {};
	for (const x of scored) if (x.one.twin_id) (groups[x.one.twin_id] ??= []).push(x);
	const pairs = Object.values(groups).filter((g) => g.length >= 2);
	const paired = pairs.length === 0 ? null : 100 * pairs.filter((g) => g.every((x) => x.pass)).length / pairs.length;

	report[persona] = {
		n: mine.length,
		judged: judged.length,
		missing,
		A: Number((100 * main.filter((x) => x.pass).length / (main.length || 1)).toFixed(1)),
		A_weighted: Number(weighted.toFixed(1)),
		main: main.length,
		control: ctl.length === 0 ? null : Number((100 * ctl.filter((x) => x.pass).length / ctl.length).toFixed(1)),
		paired: paired === null ? null : Number(paired.toFixed(1)),
		mean_points: Number((main.reduce((sum, x) => sum + pointsOf(x.j), 0) / (main.length || 1)).toFixed(3)),
		fails: main.filter((x) => !x.pass).map((x) => ({
			id: x.one.id,
			tags: x.one.content_tags,
			required: x.j.required,
			forbidden_hit: x.j.forbidden_hit ?? [],
			tempting_hit: x.j.tempting_hit ?? [],
			unknown_asserted: x.j.unknown_asserted ?? [],
			date_wrong: Boolean(x.j.date_wrong),
			over_hedged: Boolean(x.j.over_hedged)
		}))
	};
}

const both = Object.values(report).filter((one) => one.judged > 0);
console.log(JSON.stringify({
	per_persona: Object.fromEntries(Object.entries(report).map(([p, r]) => [p, { ...r, fails: r.fails.length }])),
	all_A: Number((both.reduce((sum, r) => sum + r.A * r.main, 0) / both.reduce((sum, r) => sum + r.main, 0)).toFixed(1)),
	all_A_weighted: Number((both.reduce((sum, r) => sum + r.A_weighted * r.main, 0) / both.reduce((sum, r) => sum + r.main, 0)).toFixed(1))
}, null, 1));
fs.writeFileSync(JUDGE.replace(/\.jsonl$/u, '-report.json'), JSON.stringify(report, null, 1), 'utf8');
console.log('明细写到', JUDGE.replace(/\.jsonl$/u, '-report.json'));
