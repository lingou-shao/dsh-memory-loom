/**
 * 快照上的检索复算：不再重放历史，直接拿 `probe-miss.mjs` 落下的库跑一遍
 * `memory_search` + 前两条展开，量金标原话在不在「模型真正看到的三段」里。
 *
 * 为什么要有这个脚本：改一处检索判据，714 与 62 题两套读数各要重放十几分钟，
 * 而定位「这条判据能不能把这一行捞上来」只需要一道题。快照已经把「到 cutoff
 * 为止的历史」冻住了，时钟用题面的 `now` 拨过去即可。
 *
 * 每次运行都把快照复制一份再打开——产品会写（recall 缓存、access 标记、
 * `markPlanNudged`），在原快照上跑第二遍读数会变。
 *
 *   node bench-hmb/eval-miss-quick.mjs --ids P12-NEW-002/d45 --set solidOverlap=3
 *   node bench-hmb/eval-miss-quick.mjs --ids-file work/probe-ids.txt --json
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const PROBE = process.env.HMB_PROBE_OUT ?? path.join(BENCH, 'work', 'probe-miss');
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const AS_JSON = process.argv.includes('--json');
const LIMIT = Number(argOf('limit', 10));
const EXPANDS = Number(argOf('expands', 2));
const OVERRIDES = (() => {
	const raw = argOf('set', '');
	const out = {};
	for (const part of raw.split(',').map((one) => one.trim()).filter(Boolean)) {
		const [k, v] = part.split('=');
		out[k] = v === 'true' ? true : v === 'false' ? false : Number.isNaN(Number(v)) ? v : Number(v);
	}
	return out;
})();
const IDS = (() => {
	const inline = argOf('ids', '');
	const file = argOf('ids-file', '');
	const text = inline || (file ? fs.readFileSync(file, 'utf8') : '');
	return text.split(/[\s,]+/).map((one) => one.trim()).filter(Boolean);
})();

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((row) => [row.id, row]));
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));

const key = (text) => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
const grams = (text, n) => {
	const s = key(text);
	const out = new Set();
	for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
	return out;
};
const ratio = (set, quote, n) => {
	const s = key(quote);
	if (s.length < n) return set.has(s) ? 1 : 0;
	let hit = 0;
	let total = 0;
	for (let i = 0; i + n <= s.length; i++) {
		total += 1;
		if (set.has(s.slice(i, i + n))) hit += 1;
	}
	return total === 0 ? 0 : hit / total;
};
const refsOf = (text) => [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];

const rows = [];
for (const id of IDS) {
	const exam = exams.get(id);
	const snap = path.join(PROBE, `${id.replace(/\//g, '_')}.db`);
	if (!exam || !fs.existsSync(snap)) {
		console.error(`跳过 ${id}（缺题面或快照）`);
		continue;
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-miss-'));
	const dbPath = path.join(dir, 'loom.db');
	fs.copyFileSync(snap, dbPath);
	const session = (() => {
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			return String(db.prepare('SELECT session_id FROM sessions LIMIT 1').get()['session_id']);
		} finally {
			db.close();
		}
	})();
	const realNow = Date.now;
	const clock = Date.parse(exam.now);
	Date.now = () => clock;
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 }, retrieval: OVERRIDES } });
	let block = '';
	let search = '';
	const expanded = [];
	try {
		await loom.ready?.();
		block = String(loom.memoryBlock(session));
		search = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, session));
		for (const ref of refsOf(search).slice(0, EXPANDS)) {
			let text = '';
			try {
				text = String(await loom.call('memory_expand', { ref: `#${ref}` }, session));
			} catch (error) {
				text = `ERROR ${error?.message ?? error}`;
			}
			expanded.push({ ref, text });
		}
	} finally {
		loom.dispose();
		Date.now = realNow;
	}
	const tool = grams([search, ...expanded.map((one) => one.text)].join('\n'), 10);
	const blockG = grams(block, 10);
	const ev = evidence.get(id) ?? {};
	const facts = (ev.facts ?? []).map((fact) => {
		const quotes = (ev.sources ?? []).filter((one) => one.fact_id === fact.fact_id && typeof one.quote === 'string');
		const best = (set) => Math.max(0, ...quotes.map((one) => ratio(set, one.quote, 10)));
		return { factId: fact.fact_id, block: Number(best(blockG).toFixed(2)), tool: Number(best(tool).toFixed(2)) };
	});
	const covered = facts.every((fact) => Math.max(fact.block, fact.tool) >= 0.8);
	rows.push({ id, refs: refsOf(search), facts, covered });
	if (!AS_JSON) {
		const flag = covered ? '✓' : '✗';
		console.log(`${flag} ${id}  refs=${refsOf(search).join(',')}  ${facts.map((fact) => `${fact.factId} b${fact.block}/t${fact.tool}`).join('  ')}`);
	}
}
if (AS_JSON) console.log(JSON.stringify({ overrides: OVERRIDES, rows }, null, 1));
else console.log(`覆盖 ${rows.filter((row) => row.covered).length}/${rows.length}`);
