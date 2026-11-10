#!/usr/bin/env node
/*
 * A/B 的两半：收答案切判分包（collect）、配对算分（score）。
 *
 * `collect` 把两臂的答卷还原成判分卡片：rubric / facts / sources 全部照抄
 * `run-0258/packets.jsonl`，只换 `id` 与 `answer`——判分员看到的是同一道题、
 * 同一把 rubric、两个不同的答，不知道哪个是哪个臂。
 *
 * `score` 按官方 `grade.py` 的口径判通过（factual ∧ relevance），再按题配对。
 *
 * 用法：
 *   node bench-hmb/ab-collect.mjs collect <answersDir> <abDir> <packets.jsonl> <outDir> [--per-batch 8]
 *   node bench-hmb/ab-collect.mjs score <judgementsDir> <abDir> <packets.jsonl> <scored.jsonl>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [, , MODE, SRC, AB_DIR, PACKETS_FILE, OUT] = process.argv;
if (!MODE || !SRC || !AB_DIR || !PACKETS_FILE || !OUT) {
	console.error('用法见文件头');
	process.exit(1);
}

const jsonl = (file) =>
	fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const readDir = (dir) =>
	fs.existsSync(dir)
		? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).flatMap((name) => jsonl(path.join(dir, name)))
		: [];
const seedOf = (text) => crypto.createHash('sha1').update(text).digest().readUInt32BE(0);

const key = JSON.parse(fs.readFileSync(path.join(AB_DIR, 'key.json'), 'utf8'));
const base = new Map(jsonl(PACKETS_FILE).map((one) => [one.id, one]));

if (MODE === 'collect') {
	const answers = new Map(readDir(SRC).map((one) => [one.id, one.answer]));
	const rows = [];
	const lost = [];
	for (const [blind, meta] of Object.entries(key)) {
		const answer = answers.get(blind);
		const packet = base.get(meta.id);
		if (answer === undefined || answer === null || String(answer).trim() === '') {
			lost.push(blind);
			continue;
		}
		if (!packet) {
			lost.push(blind);
			continue;
		}
		rows.push({ ...packet, id: blind, answer: String(answer) });
	}
	rows.sort((x, y) => seedOf(`j:${x.id}`) - seedOf(`j:${y.id}`));
	fs.mkdirSync(OUT, { recursive: true });
	const perBatch = Number((process.argv.indexOf('--per-batch') === -1 ? 8 : process.argv[process.argv.indexOf('--per-batch') + 1]));
	const maxChars = 40000;
	const batches = [];
	let current = [];
	let chars = 0;
	for (const row of rows) {
		const size = JSON.stringify(row).length;
		if (current.length > 0 && (current.length >= perBatch || chars + size > maxChars)) {
			batches.push(current);
			current = [];
			chars = 0;
		}
		current.push(row);
		chars += size;
	}
	if (current.length > 0) batches.push(current);
	batches.forEach((batch, index) => {
		fs.writeFileSync(
			path.join(OUT, `batch-${String(index).padStart(3, '0')}.jsonl`),
			batch.map((one) => JSON.stringify(one)).join('\n') + '\n',
			'utf8'
		);
	});
	console.log('收到答案', answers.size, '需要', Object.keys(key).length, '缺', lost.length, lost.slice(0, 6));
	console.log('判分包', batches.length, '批', batches.map((batch) => batch.length).join(','));
}

if (MODE === 'score') {
	const judged = new Map(readDir(SRC).map((one) => [one.id, one]));
	const rows = [];
	for (const [blind, meta] of Object.entries(key)) {
		const review = judged.get(blind);
		const packet = base.get(meta.id);
		if (!review || !packet) continue;
		const required = review.required ?? [];
		const want = (packet.rubric?.required ?? []).length;
		if (required.length !== want) {
			console.log('长度不符，丢掉', blind, required.length, '应为', want);
			continue;
		}
		const factual =
			required.every(Boolean) &&
			(review.违反禁止 ?? []).length === 0 &&
			(review.unknown_asserted ?? review.未知当事实 ?? []).length === 0 &&
			!review.错认 &&
			!review.错否 &&
			!review.越界 &&
			!review.date_wrong &&
			!review.编造日期;
		const relevant =
			(review.无关旧事 ?? []).length < 3 &&
			!review.不当私事披露 &&
			!review.over_hedged;
		rows.push({
			blind,
			id: meta.id,
			arm: meta.arm,
			pass: factual && relevant,
			requiredMet: required.filter(Boolean).length,
			requiredTotal: want,
			reason: review.reason ?? ''
		});
	}
	const paired = new Map();
	for (const row of rows) {
		const slot = paired.get(row.id) ?? {};
		slot[row.arm] = row;
		paired.set(row.id, slot);
	}
	let both = 0;
	let onlyA = 0;
	let onlyB = 0;
	let neither = 0;
	const lost = [];
	const gained = [];
	for (const [id, slot] of paired) {
		if (!slot.A || !slot.B) continue;
		if (slot.A.pass && slot.B.pass) both++;
		else if (slot.A.pass) {
			onlyA++;
			lost.push(id);
		} else if (slot.B.pass) {
			onlyB++;
			gained.push(id);
		} else neither++;
	}
	const passOf = (arm) => [...paired.values()].filter((slot) => slot[arm]?.pass).length;
	console.log('判了', rows.length, '条 /', paired.size, '题');
	console.log('通过  A(0.2.58)', passOf('A'), ' B(0.2.59)', passOf('B'), '/', paired.size);
	console.log('配对  都对', both, '只 A 过', onlyA, '只 B 过', onlyB, '都不过', neither);
	console.log('B 丢:', lost.join(' ') || '—');
	console.log('B 拿:', gained.join(' ') || '—');
	fs.writeFileSync(OUT, rows.map((one) => JSON.stringify(one)).join('\n') + '\n', 'utf8');
}
