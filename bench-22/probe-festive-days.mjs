/**
 * 节日与农历这一路的单元测试。
 *
 *   node bench-22/probe-festive-days.mjs
 *
 * 钉四件事：
 *   1. **农历日期**（「农历腊月十二」）到那天出现在【今天该做的事】，别的日子不出现；
 *   2. **节日前 N 天**（「春节前三天之前」）同上；
 *   3. **过去指向的节日**（「中秋那天…请了晚班的假」）**任何时刻都不许出现**——
 *      节日名年年循环，这是这一路最大的假阳性来源；
 *   4. 关掉 `dueTodayFestive` 时三条全部不出现，证明是这一路在起作用。
 *
 * 日期都按 `Intl` 的农历数据算，不按记忆：2027-02-06 是腊月三十（除夕），
 * 所以正月初一是 2027-02-07，「春节前三天」落在 02-04。第一版探针按
 * 「春节 = 02-06」写期望值，差了整整一天。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const BRIDGE = path.join(HERE, 'loom-bridge.mjs');

const TURNS = [
	{ at: '2026-11-12T09:10:00+08:00', user: '对了我爸的生日是农历腊月十二，老家都过农历的，我得提前准备', assistant: '记下了，腊月十二。' },
	{ at: '2026-11-12T09:20:00+08:00', user: '老霍说春节前三天之前给她个答复，哪怕是婉拒，也得有个话', assistant: '那得早点定。' },
	{ at: '2026-11-12T09:30:00+08:00', user: '中秋那天霜霜特意请了晚班的假，我俩在东关这边分了一盒蛋黄月饼', assistant: '她这个人真没得说。' },
	{ at: '2026-11-12T09:40:00+08:00', user: '今天先把图纸收一收，晚上回去再说', assistant: '好。' },
];

const AT = {
	early: '2026-12-05T12:00:00+08:00',
	lunar: '2027-01-19T12:00:00+08:00',
	/* 三个时刻围着「春节前三天」的窗口：02-03 / 02-04 在内，02-02 在外。
	 *
	 * 02-03 这个点同时是**春节日期表的回归测试**：ICU 的农历说 2027 年正月初一
	 * 是 02-07（官方是 02-06），用 `Intl` 算出来的窗口是 02-04–02-06，会漏掉
	 * 02-03。所以这条断言一红，就是春节表被绕过了。 */
	outside: '2027-02-02T12:00:00+08:00',
	before: '2027-02-04T12:00:00+08:00',
	edge: '2027-02-03T12:00:00+08:00',
	late: '2027-03-01T12:00:00+08:00',
};

const dueSection = (block) => {
	const at = block.indexOf('【今天该做的事】');
	if (at < 0) return '';
	const rest = block.slice(at + '【今天该做的事】'.length);
	const next = rest.indexOf('【');
	return next < 0 ? rest : rest.slice(0, next);
};

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

/** 一次运行只问一个时刻：块按会话缓存，同一实例连问两个时刻会拿到第一份。 */
async function blockAt(festive, iso) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `loom-fest-${festive ? 'on' : 'off'}-`));
	const cli = bridge();
	try {
		await cli.rpc('open', {
			db: path.join(dir, 'loom.db'),
			workDir: dir,
			config: { consolidation: { triggerTokens: 0 }, retrieval: { dueToday: true, dueTodayFestive: festive } },
		});
		for (const t of TURNS) await cli.rpc('turn', { sid: 'M01', user: t.user, assistant: t.assistant, at: Date.parse(t.at) });
		return String((await cli.rpc('block', { sid: 'M01', now: Date.parse(iso) })).text ?? '');
	} finally {
		cli.close();
	}
}

const LUNAR = /腊月十二/u;
const BEFORE = /春节前三天/u;
const PAST = /蛋黄月饼/u;

let bad = 0;
const check = (label, ok) => {
	if (!ok) bad += 1;
	console.log(`${ok ? '✓' : '✗'} ${label}`);
};

for (const festive of [true, false]) {
	const early = dueSection(await blockAt(festive, AT.early));
	const lunar = dueSection(await blockAt(festive, AT.lunar));
	const before = dueSection(await blockAt(festive, AT.before));
	const edge = dueSection(await blockAt(festive, AT.edge));
	const outside = dueSection(await blockAt(festive, AT.outside));
	const late = dueSection(await blockAt(festive, AT.late));

	if (festive) {
		check('农历：12-05 不出现', !LUNAR.test(early));
		check('农历：01-19（腊月十二）出现', LUNAR.test(lunar));
		check('农历：03-01 不出现（已过）', !LUNAR.test(late));
		check('节日前 N 天：01-19 不出现', !BEFORE.test(lunar));
		check('节日前 N 天：02-04（春节前三天）出现', BEFORE.test(before));
		check('节日前 N 天：02-03（窗口第一天）出现', BEFORE.test(edge));
		check('节日前 N 天：02-02 不出现（窗口前一天）', !BEFORE.test(outside));
		check('节日前 N 天：03-01 不出现', !BEFORE.test(late));
		check('过去指向的节日：「中秋那天」任何时刻都不出现', !PAST.test(early) && !PAST.test(lunar) && !PAST.test(before) && !PAST.test(late));
		/* 出现的必须是**原话行**（带「今天」标记），不是派生摘写。 */
		const line = lunar.split('\n').find((one) => LUNAR.test(one)) ?? '';
		check('出现的是原话行（带 [今天] 标记）', line.includes('[今天]'));
	} else {
		const any = [early, lunar, before, edge, outside, late].some((one) => LUNAR.test(one) || BEFORE.test(one) || PAST.test(one));
		check('关掉 dueTodayFestive：六条都不出现', !any);
	}
}

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 条不符`);
process.exit(bad === 0 ? 0 : 1);
