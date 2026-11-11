#!/usr/bin/env node
/*
* 「手上已经有一个稀有词，为什么不直接用它查一次」——新通道的上界。
*
* 起因（§88）：58 道漏检按最稀有的共享内容二元组重排，I 桶 32 道里 **26 道**共享的
* 词其实在 `rareLimit` 之内（M01 的「奶茶」DF 6/23、M02 的「送汤」DF 33/19 除外）。
* 也就是说字面证据在手上，却还是没端出来——因为现有一条通道（`rareTokenHit`）只在
* **bm25 已经捞回来的那 10 行**里挑，承载行根本不在池子里，它再准也没有输入。
*
* 这个探针只量上界：把问句换成「那个最稀有的词」本身再搜一次，看承载行会不会出来。
* 出来 → 直查一条稀有词是可行的；不出来 → 连这个词的直查都排不上，通道也救不了。
*
*   node bench-hmb/probe-21-rare-direct.mjs [--kind R] [--personas M01,M02] [--show 30]
*
* 判据与 `anchors-21.mjs` 一致：锚点轮用户消息的任一 8 字窗出现在这一次结果里。
*/
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const WORK = 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const KINDS = String(argOf('kind', 'R')).split(',').filter(Boolean);
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);
const SHOW = Number(argOf('show', 30));
const LIMIT = Number(argOf('limit', 10));
const WIN = 8;

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) => String(text ?? '').replace(/[\s，。！？、；：,.!?;:""''（）()…—\-~～\[\]【】\/]/gu, '');
function covers(clause, text) {
	const c = norm(clause);
	const t = norm(text);
	if (!c || !t) return false;
	if (c.length < WIN) return t.includes(c);
	if (t.includes(c)) return true;
	for (let i = 0; i + WIN <= c.length; i++) if (t.includes(c.slice(i, i + WIN))) return true;
	return false;
}

const evidence = JSON.parse(fs.readFileSync(`${WORK}/diag-evidence.json`, 'utf8')).rows.filter((row) => KINDS.includes(row.kind));
const exams = new Map(jsonl(path.join(DS, 'exam-inputs.jsonl')).map((one) => [one.id, one]));
const keys = new Map(jsonl(path.join(DS, 'answer-key.jsonl')).map((one) => [one.id, one]));

const results = [];
for (const persona of PERSONAS) {
	const targets = evidence.map((row) => ({ row, exam: exams.get(row.id) })).filter((one) => one.exam && one.exam.persona === persona).sort((a, b) => a.exam.cutoff_turn - b.exam.cutoff_turn);
	if (targets.length === 0) continue;
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const byTurn = new Map(turns.map((turn) => [Number(turn['轮次']), turn]));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `rared-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');
	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const sid = `rared-${persona}`;
	let cursor = 0;
	try {
		for (const { row, exam } of targets) {
			/*
			* `<= cutoff` 与官方 runner 的 `while pos < cutoff` 是**同一件事**：
			* runner 里的 `pos` 是 `turns` 的 0 基下标，`pos < cutoff` 灌的正是
			* 轮次 1..cutoff（含提问那一轮）。§88 复查时先把它误读成「少灌一轮」，
			* 改过一次 `<`，两处取面脚本对不上，已改回。
			*/
			for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				clock = Date.parse(turn['逻辑时间']);
				await loom.turn(sid, turn['用户消息'], turn['助手回复'], { at: clock });
			}
			clock = Date.parse(exam.now);
			const anchors = (keys.get(exam.id)?.anchors ?? []).map((one) => byTurn.get(Number(one.last_turn))?.['用户消息'] ?? '').filter((text) => norm(text).length >= WIN);
			const at = (out) => {
				const lines = out.split('\n');
				const index = lines.findIndex((line) => anchors.some((anchor) => covers(anchor, line)));
				return { hit: index >= 0, line: index >= 0 ? index + 1 : null, rows: (out.match(/#[FEL]\d/gu) ?? []).length };
			};
			const plain = at(String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, sid)));
			const direct = row.bestToken === null ? { hit: false, line: null, rows: 0 } : at(String(await loom.call('memory_search', { query: row.bestToken, limit: LIMIT }, sid)));
			results.push({ id: row.id, persona, kind: row.kind, bestToken: row.bestToken, minDf: row.minDf, rareLimit: row.rareLimit, plain, direct, question: exam.question });
			console.error(`  ${row.id} 原问句 ${plain.hit ? `✓${plain.line}` : '✗'} · 直查「${row.bestToken}」${direct.hit ? `✓${direct.line}` : '✗'} (${direct.rows} 条)`);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

const ok = (pick) => results.filter(pick).length;
console.log(`\n共 ${results.length} 题（kind=${KINDS.join(',')}，limit ${LIMIT}）`);
console.log(`  原问句命中          ${ok((one) => one.plain.hit)}`);
console.log(`  稀有词直查命中      ${ok((one) => one.direct.hit)}`);
console.log(`  直查救回（原不中、直查中）  ${ok((one) => !one.plain.hit && one.direct.hit)}`);
console.log(`  两档都不中          ${ok((one) => !one.plain.hit && !one.direct.hit)}`);

for (const bucket of ['救回', '仍不中']) {
	const list = results.filter((one) => (bucket === '救回' ? !one.plain.hit && one.direct.hit : !one.plain.hit && !one.direct.hit));
	if (!list.length) continue;
	console.log(`\n=== ${bucket}（${list.length}） ===`);
	for (const one of list.slice(0, SHOW)) {
		console.log(`· ${one.id} [${one.kind}] DF ${one.minDf}/${one.rareLimit} 「${one.bestToken}」 直查 ${one.direct.hit ? `第${one.direct.line}行/${one.direct.rows}条` : `✗（${one.direct.rows} 条）`}`);
		console.log(`   Q: ${one.question.slice(0, 55)}`);
	}
}
fs.writeFileSync(`${WORK}/probe-rare-direct.json`, JSON.stringify(results, null, 1));
console.log(`\n写成 ${WORK}/probe-rare-direct.json`);
