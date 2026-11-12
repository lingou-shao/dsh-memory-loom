/**
 * 「今天到期」这一路的单元测试：合成了一个日子，问一句与它零共享的话。
 *
 *   node bench-22/probe-due-today.mjs
 *
 * 钉四件事：
 *   1. 到期当天，零共享的情形问句能把那一行捞出来（X4 的定义就是这一格）；
 *   2. 不到那天，同样的问句**不许**出现它（否则就是每轮都在报账）；
 *   3. 关掉开关（`dueToday: false`）时两侧都不出现——证明是开关在起作用，
 *      不是别的通道顺手带进来的。第 3 条最重要：没有它，第 1 条可能是巧合。
 *   4. 进的是**常驻块**、印的是**原话**，而且是**说对日子的那一句**（`营业厅`
 *      只在第三轮出现）。这一条是本轮改的位置：上一版塞检索结果，而 X4 的问句
 *      字面总能撞满十条闲聊，追加档永远没有空位（76 题 0 好 0 坏）。
 *
 * 只查块不查检索：这一路已经**只**在块里出现。检索结果里再加一份，就要么重复，
 * 要么去顶掉有字面证据的那条（§87 的五条定律里，顶替那几条全是零和）。
 *
 * 走桥而不是直接 `createLoom`，因为产品的时钟是 `Date.now()`，桥会把它拨到
 * 题目自己的 `now`；直接建实例只拿得到真实时间，「到期当天」根本造不出来。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const BRIDGE = path.join(HERE, 'loom-bridge.mjs');

const TURNS = [
	{ at: '2026-11-24T09:46:00+08:00', user: '房东今天发消息说月底前得往电表里预存电费，我打算存一百，不然撑不到月底', assistant: '记着了，月底之前去存。' },
	{ at: '2026-11-26T12:51:00+08:00', user: '我算了下每天大概三度，剩十一点六度，怕是撑不到月底', assistant: '那确实得早点去存。' },
	{ at: '2026-11-28T20:28:00+08:00', user: '对了电费还没存，周日营业厅没人，打算周一也就是月底那天下班去', assistant: '好，周一顺路。' },
	{ at: '2026-11-29T21:10:00+08:00', user: '这周末在家把柜子收拾了一遍，翻出来一堆旧票据', assistant: '收拾出来不少东西吧。' },
];
/** 与上面任何一句都不共享实词的「情形陈述」——X4 那些问句就长这样。 */
const QUERY = '吃完饭了\n下午估计也没啥人';
const DUE = '2026-11-30T12:27:51+08:00';
/** 只取【今天该做的事】那一节——块里别的分区也可能印到同一句话。 */
const dueSection = (block) => {
	const at = block.indexOf('【今天该做的事】');
	if (at < 0) return '';
	const rest = block.slice(at + '【今天该做的事】'.length);
	const next = rest.indexOf('【');
	return next < 0 ? rest : rest.slice(0, next);
};
const NOT_YET = '2026-11-20T12:00:00+08:00';

function bridge() {
	const proc = spawn(process.execPath, [BRIDGE], { stdio: ['pipe', 'pipe', 'inherit'] });
	let seq = 0;
	let buf = '';
	const waiting = new Map();
	proc.stdout.setEncoding('utf8');
	proc.stdout.on('data', (chunk) => {
		buf += chunk;
		for (let at = buf.indexOf('\n'); at >= 0; at = buf.indexOf('\n')) {
			const line = buf.slice(0, at).trim();
			buf = buf.slice(at + 1);
			if (!line) continue;
			const msg = JSON.parse(line);
			const slot = waiting.get(msg.id);
			if (slot === undefined) continue;
			waiting.delete(msg.id);
			/* 桥的响应是 `{ id, ok, ...payload }`，payload 摊在顶层，不是 `result`。 */
			if (msg.ok === false) slot.reject(new Error(msg.error));
			else slot.resolve(msg);
		}
	});
	return {
		rpc(op, payload = {}) {
			const id = (seq += 1);
			proc.stdin.write(JSON.stringify({ id, op, ...payload }) + '\n');
			return new Promise((resolve, reject) => waiting.set(id, { resolve, reject }));
		},
		close() {
			proc.stdin.end();
		},
	};
}

/**
 * 在某一时刻取一次块。
 *
 * **一次运行只问一个时刻**：`refreshBlock` 按会话缓存上一次的块，`recordMessage`
 * 才清它。同一个实例里连着问「到期日」和「非到期日」，第二次拿到的是第一次的
 * 缓存——第一版就是这么错的，于是关掉开关也「出现」，看起来像判据漏了。
 */
async function run(enabled, iso) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-due-${enabled ? 'on' : 'off'}-`));
	const cli = bridge();
	try {
		await cli.rpc('open', {
			db: path.join(dir, 'loom.db'),
			workDir: dir,
			config: { consolidation: { triggerTokens: 0 }, retrieval: { dueToday: enabled } },
		});
		for (const t of TURNS) {
			await cli.rpc('turn', { sid: 'M01', user: t.user, assistant: t.assistant, at: Date.parse(t.at) });
		}
		return String((await cli.rpc('block', { sid: 'M01', now: Date.parse(iso) })).text ?? '');
	} finally {
		cli.close();
	}
}

let bad = 0;
for (const enabled of [true, false]) {
	const onDue = await run(enabled, DUE);
	const before = await run(enabled, NOT_YET);
	const hitDue = /营业厅/.test(dueSection(onDue));
	const hitBefore = /营业厅/.test(dueSection(before));
	/* 那一行必须是**原话**（带「今天」标记的整句），不是摘写过的派生事实。 */
	const line = dueSection(onDue).split('\n').find((one) => one.includes('营业厅')) ?? '';
	const isQuote = line.includes('[今天]');
	const ok = hitDue === enabled && hitBefore === false && (enabled ? isQuote : true);
	console.log(
		`${ok ? '✓' : '✗'} dueToday ${enabled ? '开' : '关'}：到期日 ${hitDue ? '出现' : '未出现'}` +
			`${enabled && hitDue ? `（${isQuote ? '原话 + 今天标记' : '不是原话行'}）` : ''}，非到期日 ${hitBefore ? '出现' : '未出现'}`,
	);
	if (!ok) {
		bad += 1;
		console.log(`    到期日的返回：\n${onDue.split('\n').map((l) => `      ${l}`).join('\n')}`);
	}
}
console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项不符`);
process.exit(bad === 0 ? 0 : 1);
