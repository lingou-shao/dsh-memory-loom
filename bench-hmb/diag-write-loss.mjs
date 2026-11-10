/**
 * 写侧到底丢了多少：整卷统计，不只看那 25 题。
 *
 * 0.2.54 那轮的库还在（s21-*），facts.source_ids 指向 l0 id，l0 有 turn。
 * 于是可以给每一轮算「产出了几条事实」，再看零产出的那些轮是什么形状。
 *
 * 关注三件事：
 *   1. 每轮零产出的比例（按人物分开，M01 与 M02 差了 5 倍，得解释）
 *   2. 零产出轮里分句的文本长度分布 —— `extractWithRules` 里 `clean.length > 220` 是直接 continue，
 *      但 `clean` 是**分句**不是整轮（第一版把两者搞混，错记成「204 轮整轮被跳过」，见 §70.6）
 *   3. 零产出轮的文本长度分布
 *
 *   node bench-hmb/diag-write-loss.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const DBS = {
	M01: path.join(os.tmpdir(), 's21-M01-T9F11n', 'loom.db'),
	M02: path.join(os.tmpdir(), 's21-M02-qpCGXz', 'loom.db')
};
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const norm = (text) => String(text ?? '').replace(/\s/gu, '');

for (const [persona, dbPath] of Object.entries(DBS)) {
	if (!fs.existsSync(dbPath)) {
		console.log(`${persona} 库不存在：${dbPath}`);
		continue;
	}
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const l0 = db.prepare("SELECT id, turn FROM l0 WHERE role = 'user'").all();
	const facts = db.prepare('SELECT id, text, source_ids FROM facts').all();
	const events = db.prepare('SELECT id, turn_from, turn_to, title FROM events').all();
	db.close();

	/* 事件覆盖：events 有 turn_from / turn_to，落在区间里就算被事件带上了 */
	const eventTurns = new Set();
	for (const ev of events) {
		for (let t = ev.turn_from; t <= ev.turn_to; t++) eventTurns.add(t);
	}

	const turnOfL0 = new Map(l0.map((one) => [one.id, one.turn]));
	const perTurn = new Map();
	for (const fact of facts) {
		for (const id of JSON.parse(fact.source_ids ?? '[]') ?? []) {
			const turn = turnOfL0.get(Number(id));
			if (turn === undefined) continue;
			perTurn.set(turn, (perTurn.get(turn) ?? 0) + 1);
		}
	}

	const zero = [];
	const has = [];
	for (const turn of turns) {
		const n = perTurn.get(turn['轮次']) ?? 0;
		const len = norm(turn['用户消息']).length;
		(n === 0 ? zero : has).push({ turn: turn['轮次'], len, n });
	}
	const noEvent = zero.filter((one) => !eventTurns.has(one.turn));
	const noEventSub = noEvent.filter((one) => one.len >= 6);
	const sub = turns.filter((t) => norm(t['用户消息']).length >= 6);
	const pct = (a, b) => `${((100 * a) / (b || 1)).toFixed(1)}%`;
	const q = (list, p) => {
		const s = list.map((x) => x.len).sort((a, b) => a - b);
		return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
	};

	console.log(`\n===== ${persona} =====`);
	console.log(`轮次 ${turns.length}  facts ${facts.length}  facts/轮 ${(facts.length / turns.length).toFixed(2)}`);
	console.log(`零产出轮 ${zero.length}（${pct(zero.length, turns.length)}）  有产出轮 ${has.length}`);
	console.log(`  事件 ${events.length} 条，覆盖轮次 ${eventTurns.size}`);
	console.log(`  零 fact 且不在任何事件区间 ${noEvent.length}（${pct(noEvent.length, turns.length)}）；其中文本 >=6 字 ${noEventSub.length}/${sub.length} = ${pct(noEventSub.length, sub.length)}`);
	console.log(`  零产出轮 文本长度 中位 ${q(zero, 0.5)} p90 ${q(zero, 0.9)} 最大 ${Math.max(...zero.map((x) => x.len))}`);
	console.log(`  有产出轮 文本长度 中位 ${q(has, 0.5)} p90 ${q(has, 0.9)}`);
	/*
	 * 这里原来算的是「整轮 > 220 字」，并直接读成「extractWithRules 跳过」。
	 * 错在 `clean` 是**分句**，不是整轮：`sentences()` 按 `。！？!?；;` 切，
	 * 一封 641 字的信切完每句都远短于 220。按分句重算，>220 的句子是 0 句。
	 */
	const SENT_SPLIT = /(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z一-鿿])/u;
	let sentTotal = 0;
	let sentOver = 0;
	for (const t of turns) {
		for (const s of String(t['用户消息']).replace(/[ \t]+/gu, ' ').split(SENT_SPLIT)) {
			if (!s.trim()) continue;
			sentTotal++;
			if (norm(s).length > 220) sentOver++;
		}
	}
	console.log(`  分句 >220 字（extractWithRules 真正的判据）：${sentOver}/${sentTotal} 句 = ${pct(sentOver, sentTotal)}  ← 上限从未触发`);
	const short6 = zero.filter((x) => x.len < 6);
	console.log(`  零产出且 <6 字：${short6.length}`);
	console.log('  零产出样例（前 8 条，按长度）');
	for (const one of [...zero].sort((a, b) => a.len - b.len).slice(0, 8)) {
		const t = turns.find((row) => row['轮次'] === one.turn);
		console.log(`    t${one.turn} ${String(one.len).padStart(3)} 字「${String(t['用户消息']).replace(/\n/g, ' / ').slice(0, 56)}」`);
	}
	console.log('  零产出里最长的 4 条');
	for (const one of [...zero].sort((a, b) => b.len - a.len).slice(0, 4)) {
		const t = turns.find((row) => row['轮次'] === one.turn);
		console.log(`    t${one.turn} ${String(one.len).padStart(4)} 字「${String(t['用户消息']).replace(/\n/g, ' / ').slice(0, 56)}」`);
	}
}
