/**
 * 侧别判定：一道漏检，是**没写进去**、**写进去了但没进候选**、还是**进了候选没占到位**。
 *
 * 为什么必须有这一步：§86.3 的教训是「判写侧缺之前，先问闸门」。反过来也成立——
 * 判查找侧缺之前，得先确认那一行真的在库里。两边都不问，就会把「派生层有损」
 * 当成「排序不佳」去调参数，白跑一轮。
 *
 * 做法：按截止轮**升序**单次向前重放（不回退，所以不需要 mark/rewind，也就不会
 * 踩 §96 那个重号），每到一题的截止轮就当场查四件事：
 *
 *   l0   承载轮的 user 行在不在（按 session + turn 查，再用 8 字窗认一遍文本）
 *   fact 证据句有没有被写成派生事实（`facts.text` / `events.title+summary` 里比 8 字窗）
 *   ref  这一行在不在检索结果的指针里（`#L` 区间 / `#F` 反查 `source_ids`）
 *   prm  证据的 8 字窗有没有落进提示词（= 那道题的 cover_any）
 *
 * 只输出判定，不改产品、不改判据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));
if (!DATA) throw new Error('找不到题库：设 BENCH22_DATA');

const PRODUCT = process.env.LOOM_PRODUCT || path.join(HERE, '..');
/* 动态 import 在 Windows 上要 `file://`，裸盘符会被当成协议。 */
const { createLoom } = await import(pathToFileURL(path.join(PRODUCT, 'loom-e2e', 'harness.mjs')).href);

/* 桥控制「现在几点」的办法就是把 `Date.now` 换掉（`loom-bridge.mjs:51`），这里照抄：
 * 产品的 `now()` 读的就是它。不这么做，取面的时点会是脚本启动的那一刻。 */
const realNow = Date.now;
let clock = realNow();
Date.now = () => clock;

const OUT = process.env.OUT || path.join(HERE, 'work', 'diag-side.jsonl');
const LOG = process.env.LOG || path.join(HERE, 'work', 'diag-side.log');

function readJsonl(file) {
	return fs
		.readFileSync(file, 'utf8')
		.split('\n')
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line));
}
const squash = (text) => String(text ?? '').replace(/\s+/g, '');
const WINDOW = 8;
function windows(text, size = WINDOW) {
	const body = squash(text);
	const out = [];
	for (let i = 0; i + size <= body.length; i += 1) out.push(body.slice(i, i + size));
	return out;
}
/** 证据句是否被 `body` 包含：证据的 8 字窗出现，或 body 够长且整个出现。 */
function contains(body, evidence) {
	const hay = squash(body);
	if (!hay) return false;
	for (const win of windows(evidence)) if (hay.includes(win)) return true;
	const needle = squash(evidence);
	/* 短证据（< 8 字）没有 8 字窗，整段比一次。 */
	return hay.includes(needle);
}

const key = new Map(readJsonl(path.join(DATA, 'natural', 'natural-key-dev.jsonl')).map((one) => [one.id, one]));
const probes = new Map(readJsonl(path.join(DATA, 'natural', 'natural-probes-dev.jsonl')).map((one) => [one.id, one]));
const surface = new Map(
	readJsonl(path.join(HERE, 'work', 'natural-22-v7.jsonl')).map((one) => [one.id, one]),
);
const hist = new Map(
	['M01', 'M02'].map((who) => [
		who,
		readJsonl(path.join(DATA, 'histories', `${who}.jsonl`)).map((one) => ({
			turn: Number(one['轮次']),
			at: Date.parse(one['逻辑时间']),
			user: one['用户消息'],
			assistant: one['助手回复'],
		})),
	]),
);

/** 证据行 → `[{turn, text}]`。`user：…` 取到行尾，`F1：…` 也是一种证据。 */
function evidences(id) {
	const out = [];
	for (const raw of String(key.get(id).evidence ?? '').split('\n')) {
		const line = raw.trim().replace(/^-\s*/, '');
		if (!line) continue;
		const turn = /第\s*(\d+)\s*轮/.exec(line);
		const user = /user[:：]\s*(.+)$/.exec(line);
		const fact = /^F\d+[:：]\s*(.+)$/.exec(line);
		const text = user ? user[1] : fact ? fact[1] : null;
		if (text === null) continue;
		if (squash(text).length < 4) continue;
		out.push({ turn: turn ? Number(turn[1]) : null, text: text.trim() });
	}
	return out;
}

/**
 * 检索结果里「被端出来的是哪几样东西」。
 *
 * 不能拿 `#F` 的 `source_ids` 摊成行区间来判——那是一个**来源范围**，一个事件
 * 的 `source_ids` 能横跨几十行，盖住证据行不等于证据句被端出来了。`#F` 要按
 * **事实正文**认，`#E` 按事件正文认，只有 `#L` 才是行区间。
 */
function candidatesOf(text, db) {
	const lines = [];
	for (const one of text.matchAll(/#L(\d+)(?:-(\d+))?/g)) {
		const from = Number(one[1]);
		const to = one[2] === undefined ? from : Number(one[2]);
		lines.push([Math.min(from, to), Math.max(from, to)]);
	}
	const byFact = db.prepare('SELECT text FROM facts WHERE id = ?');
	const byEvent = db.prepare('SELECT title, summary FROM events WHERE id = ?');
	const bodies = [];
	for (const one of text.matchAll(/#F(\d+)/g)) {
		const row = byFact.get(Number(one[1]));
		if (row !== undefined) bodies.push(String(row.text));
	}
	for (const one of text.matchAll(/#E(\d+)/g)) {
		const row = byEvent.get(Number(one[1]));
		if (row !== undefined) bodies.push(`${row.title}\n${row.summary}`);
	}
	return { lines, bodies };
}
function covered(cand, l0Id, evidence) {
	if (l0Id !== null && cand.lines.some(([from, to]) => l0Id >= from && l0Id <= to)) return true;
	return cand.bodies.some((one) => contains(one, evidence));
}

/* 只跑漏检的题：命中的题没有「缺在哪」可问。 */
const LIMIT = Number(process.env.LIMIT ?? 0);
const misses = [...surface.values()]
	.filter((one) => !one.cover_any)
	.sort((a, b) => a.cutoff_turn - b.cutoff_turn)
	.slice(0, LIMIT > 0 ? LIMIT : undefined);
const log = fs.createWriteStream(LOG, { flags: 'w' });
const say = (line) => {
	log.write(`${line}\n`);
	console.log(line);
};
const fh = fs.createWriteStream(OUT, { flags: 'w' });

say(`漏检 ${misses.length} 题，题库 ${DATA}`);
const rows = [];
for (const who of ['M01', 'M02']) {
	const todo = misses.filter((one) => one.persona === who);
	if (todo.length === 0) continue;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `diag-side-${who}-`));
	const dbPath = path.join(dir, 'loom.db');
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
	const turns = hist.get(who);
	let pos = 0;
	const started = realNow();
	for (const probe of todo) {
		const cutoff = probe.cutoff_turn;
		while (pos < cutoff) {
			const row = turns[pos];
			await loom.turn(who, row.user, row.assistant, { at: row.at });
			pos += 1;
		}
		clock = Date.parse(probes.get(probe.id).probe.time);
		const query = probes.get(probe.id).probe.user;
		const text = String(await loom.call('memory_search', { query, limit: 10 }, who));
		/* 再问一次 30 条：区分「池子里根本没有」与「池子里有、排到十名外」。
		 * 判据的常量是 10（榜单口径），但 10 名外到 30 名的这一段决定了下一步
		 * 该动召回还是动名额——§87 的五条定律里，动名额那三条全是零和。 */
		const deep = String(await loom.call('memory_search', { query, limit: 30 }, who));
		const db = new DatabaseSync(dbPath, { readOnly: true });
		try {
			const cand = candidatesOf(text, db);
			const cand30 = candidatesOf(deep, db);
			const facts = db.prepare('SELECT id, text FROM facts').all();
			const events = db.prepare('SELECT id, title, summary FROM events').all();
			/* 用户行一次性读进来：证据行有一半没带「第N轮」（`F1：…` 那种），只能按文本认。
			 * 每题查一次 7 千行是 30 ms 级，比逐条 prepare 便宜。 */
			const userRows = db.prepare("SELECT id, turn, text FROM l0 WHERE session_id = ? AND role = 'user'").all(who);
			const evidence = [];
			for (const ev of evidences(probe.id)) {
				const row =
					(ev.turn === null ? undefined : userRows.find((one) => Number(one.turn) === ev.turn)) ??
					userRows.find((one) => contains(one.text, ev.text));
				const l0Id = row === undefined ? null : Number(row.id);
				const inL0 = row !== undefined && contains(row.text, ev.text);
				const fact = facts.find((one) => contains(one.text, ev.text)) ?? null;
				const event = events.find((one) => contains(`${one.title}\n${one.summary}`, ev.text)) ?? null;
				evidence.push({
					turn: ev.turn,
					text: ev.text,
					l0: l0Id,
					inL0,
					inFacts: fact === null ? null : Number(fact.id),
					inEvent: event === null ? null : Number(event.id),
					inCand: covered(cand, l0Id, ev.text),
				inCand30: covered(cand30, l0Id, ev.text),
					inPrompt: contains(probe.prompt, ev.text),
				});
			}
			const verdict = (() => {
				/* 证据没解析出来（key 里是纯 F 行或空）：这一格不能判，别算进任何一侧。 */
				if (evidence.length === 0) return 'no-key';
				const written = evidence.some((one) => one.inL0);
				const derived = evidence.some((one) => one.inFacts !== null || one.inEvent !== null);
				const refs = evidence.some((one) => one.inCand);
				if (!written) return 'write-l0';
				if (refs) return 'rank';
				if (!derived) return 'write-derive';
				return 'pool';
			})();
			const deepHit = evidence.some((one) => one.inCand30);
			rows.push({
				id: probe.id,
				persona: who,
				cls: key.get(probe.id).class,
				subtype: key.get(probe.id).subtype,
				cutoff,
				verdict,
				deepHit,
				evidence,
			});
			fh.write(`${JSON.stringify(rows[rows.length - 1])}\n`);
			const flag = (one) => (one ? '✓' : '·');
			const brief = evidence
				.map((one) => `${flag(one.inL0)}l0${flag(one.inFacts !== null || one.inEvent !== null)}派${flag(one.inCand)}候`)
				.join(' ');
			say(
				`${probe.id.padEnd(20)} ${String(key.get(probe.id).subtype ?? '').padEnd(4)}` +
					` ${verdict.padEnd(12)}${deepHit ? '+' : ' '} ${brief}  ${evidence[0]?.text.slice(0, 30) ?? '(无证据)'}`,
			);
		} finally {
			db.close();
		}
	}
	loom.dispose();
	say(`${who} 完成 ${todo.length} 题 ${((realNow() - started) / 1000).toFixed(0)}s`);
}

const deepN = rows.filter((row) => row.deepHit && row.verdict === 'pool').length;
say(`\n30 条以内能捞到的：${deepN} / ${rows.filter((row) => row.verdict === 'pool').length}（标 + 的那些）`);
const tally = new Map();
for (const row of rows) tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1);
say('');
say('=== 判定汇总 ===');
const MEAN = {
	'write-l0': 'l0 里没有这一行（写侧，最上游）',
	'write-derive': 'l0 有、派生层没写（写侧，派生）',
	'no-key': '证据没解析出来，这一格不判',
	pool: '派生有、没进检索候选（查找侧，池子）',
	rank: '进了候选、没占到位（查找侧，名额/排序）',
};
for (const [verdict, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
	say(`  ${verdict.padEnd(13)} ${String(n).padStart(2)}  ${MEAN[verdict] ?? ''}`);
}
fh.close();
log.end();
