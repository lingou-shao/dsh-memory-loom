#!/usr/bin/env node
/**
 * 回退之后轮次号会不会重号（2026-11-12 自然榜那 9672 token 的病根）。
 *
 * 现象：某道题的取面里出现 `#L377-4608` 这种四千行的「一轮」，`memory_expand`
 * 一次吐 **106184 字**（全文），而成本项按 token 计；`used_turns` 也查成
 * 1..832 这种毫无意义的连续区间，于是轮次口径的命中率被压到 15.8%。
 *
 * 病根：`loom-e2e/harness.mjs` 的轮次号来自一个**进程内 Map**，而桥的 `rewind`
 * 是「整库快照 → `createLoom()` 重建实例」——Map 一重建就从 1 重新数，新灌的
 * 轮次与库里已有的轮次**同号**；`turnSpan` 取的是 `MIN(id)..MAX(id)`，同号两轮
 * 被算成一轮，区间横跨整段历史。
 *
 * 这里驱动**真正的桥**（行协议），因为出问题的是桥的 restore，不是产品：
 *
 *     node bench-22/probe-rewind-turns.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rewind-'));
const dbPath = path.join(dir, 'loom.db');
const CONFIG = { consolidation: { triggerTokens: 0 } };
let clock = Date.parse('2026-09-01T09:00:00+08:00');

const child = spawn(process.execPath, [path.join(HERE, 'loom-bridge.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
const lines = readline.createInterface({ input: child.stdout });
const waiting = new Map();
let seq = 0;
lines.on('line', (line) => {
	const resp = JSON.parse(line);
	const resolve = waiting.get(resp.id);
	waiting.delete(resp.id);
	resolve(resp);
});
const rpc = (op, extra = {}) =>
	new Promise((resolve) => {
		seq += 1;
		waiting.set(seq, resolve);
		child.stdin.write(`${JSON.stringify({ id: seq, op, ...extra })}\n`);
	}).then((resp) => {
		if (!resp.ok) throw new Error(`${op}: ${resp.error}`);
		return resp;
	});

async function feed(from, to) {
	for (let i = from; i <= to; i += 1) {
		clock += 3600_000;
		await rpc('turn', { sid: 'S', user: `第${i}轮 我想去看看那家新开的店`, assistant: `第${i}轮 好啊，几点去？`, at: clock });
	}
}

await rpc('open', { db: dbPath, workDir: dir, config: CONFIG });
await feed(1, 30);
const mark = await rpc('mark');
const snap = mark.snap;
await feed(31, 32);
await rpc('rewind', { snap });
/* mark 的幂等性：官方 `natural.py` 在 rewind 之后会再调一次 mark 并要求相等。
 * 必须在**继续往下灌之前**问这一次，否则问到的当然是新灌进来的轮数。 */
const again = (await rpc('mark')).token;
await feed(31, 35);

/* 读**当前**那个库：`rewind` 之后桥把库换成了 `work-<n>.db`，拿原来的路径
 * 读到的是一份已经被扔掉的状态（第一版就是这么写的，结果「最大 32 轮」）。 */
const live = (await rpc('stat')).db;
const rows = (() => {
	const db = new DatabaseSync(live, { readOnly: true });
	try {
		return {
			per: db.prepare('SELECT turn, COUNT(*) AS c FROM l0 GROUP BY turn ORDER BY turn').all(),
			wide: db.prepare('SELECT turn, MIN(id) AS a, MAX(id) AS b, MAX(id) - MIN(id) AS w FROM l0 GROUP BY turn ORDER BY w DESC LIMIT 3').all(),
			turns: db.prepare('SELECT COUNT(DISTINCT turn) AS n, MAX(turn) AS top FROM l0').get(),
		};
	} finally {
		db.close();
	}
})();

const dup = rows.per.filter((row) => row.c > 2);
const worst = rows.wide[0] ?? { w: 0 };
console.log(`库里轮次：${rows.turns.n} 个不同轮次，最大 ${rows.turns.top}`);
console.log(`最宽的一轮：${JSON.stringify(rows.wide)}`);
console.log(`重号的轮次：${dup.length} 个 ${JSON.stringify(dup.slice(0, 6))}`);

let bad = 0;
if (dup.length > 0) {
	bad += 1;
	console.log(`✗ 回退后轮次号重号 ${dup.length} 轮：新灌的 31..35 被写成了 ${JSON.stringify(dup.map((r) => r.turn))}`);
} else console.log('✓ 回退后轮次号不重号');
if (worst.w > 8) {
	bad += 1;
	console.log(`✗ 「一轮」的行区间宽到 ${worst.w} 行（正常一轮 2 行）：指针会横跨整段历史`);
} else console.log(`✓ 最宽的一轮 ${worst.w} 行`);
/* mark 的幂等性：`natural.py` 在 rewind 之后会再调一次 mark 并要求相等。 */
if (again !== mark.token) {
	bad += 1;
	console.log(`✗ rewind 之后 mark 报了 ${again}，mark 时是 ${mark.token}`);
} else console.log(`✓ rewind 之后 mark 仍是 ${again}`);

await rpc('close');
child.stdin.end();
fs.rmSync(dir, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);
