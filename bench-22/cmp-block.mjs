/**
 * 同一个库，两个版本的 `memoryBlock` 输出必须逐字相同（2026-11-13）。
 *
 * 到期区从「内存缓存 + 每次换实例重扫全库」改成「写侧算好、落到 `l0_due`」，
 * 是性能改动，**不该改变任何一行输出**。这类改动的风险恰好不体现在读数上
 * （读数只看检索到的行），只体现在块文本上：窗口算错一处，就是一条该提醒的
 * 事不提醒，或者一条不该冒的冒出来。
 *
 * 用法（两版各跑一次，然后比）：
 *
 *   node bench-22/cmp-block.mjs --build --persona M02 --db work/cmp.db
 *   node bench-22/cmp-block.mjs --db work/cmp.db --out /tmp/new.txt
 *   再在旧 tag 的 worktree 里跑第二次 --db ... --out /tmp/old.txt
 *   diff /tmp/old.txt /tmp/new.txt
 *
 * 同一个库被两个版本打开：旧版看不见 `l0_due`，会自己重扫 `l0` 按老规矩算；
 * 新版读表。两条路独立算，输出一致才说明判据等价。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const PERSONA = arg('persona', 'M02');
const TURNS = Number(arg('turns', 900));
const DB = arg('db', path.join(HERE, 'work', 'cmp.db'));
const OUT = arg('out', '');

/* 块里跟「现在」有关的部分（到期区）要拿同一个时刻算，否则两边比的是两个问题。
 * 取最后一轮的三天后：既在 120 天窗口里，又能让「这几天到期」那一档有内容。 */
const lastTurnAt = () => {
	const rows = fs.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8').split('\n').filter((l) => l.trim());
	const one = JSON.parse(rows.slice(0, TURNS)[TURNS - 1]);
	return Date.parse(one['逻辑时间']);
};

if (argv.includes('--build')) {
	fs.mkdirSync(path.dirname(DB), { recursive: true });
	fs.rmSync(DB, { force: true });
	const rows = fs
		.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8')
		.split('\n')
		.filter((l) => l.trim())
		.slice(0, TURNS)
		.map((l) => JSON.parse(l));
	const loom = createLoom({
		dbPath: DB,
		config: { consolidation: { triggerTokens: 0 } },
		settleRounds: 1,
	});
	const began = performance.now();
	for (const row of rows) await loom.turn(PERSONA, row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
	console.log(`灌 ${rows.length} 轮 ${((performance.now() - began) / 1000).toFixed(1)}s → ${DB}`);
	loom.dispose();
}

const loom = createLoom({ dbPath: DB, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
/*
 * `harness.memoryBlock(sessionId)` 没有 `at` 参数——它返回的是注册时那个
 * context 的 `text()`，用的是真实的 `Date.now()`。想要「把表拨到某个时刻再渲染
 * 块」，只能像 `bench-22/loom-bridge.mjs` 那样替换 `Date.now`，否则四个时刻
 * 渲染出来是同一份（第一版就是这么比的：块完全一样，等于没比）。
 */
const realNow = Date.now;
let clock = null;
Date.now = () => (clock === null ? realNow() : clock);
/*
 * 到期区（`quotesOnDay`）是这次改动唯一碰到的输出，而它只在「今天正好落在某个
 * 窗口里」时才出现在块上。拿最后一轮的时刻当 `at` 往往一条都不命中，那样两边
 * 比的是同一个空集，等于没比。`--due` 从库里挑一条命中行，把 `at` 设到它的
 * 到期日上，保证这块内容真的被渲染出来。
 */
const dueBase = () => {
	const db = new DatabaseSync(DB, { readOnly: true });
	try {
		const one = db.prepare('SELECT due_from FROM l0_due WHERE due_from IS NOT NULL ORDER BY created_at DESC LIMIT 1').get();
		return one === undefined ? null : Number(one['due_from']);
	} catch {
		return null;
	} finally {
		db.close();
	}
};
const AT = arg('at', '');
const picked = AT !== '' ? Date.parse(AT) : argv.includes('--due') ? dueBase() : null;
if (argv.includes('--due')) console.log(`at 基准取 l0_due 里最近一条的到期日：${picked === null ? '（无）' : new Date(picked).toISOString()}`);
/* 四个时刻各一份：到期区对 `at` 敏感，只看一个时点会漏掉窗口边界的偏移。 */
const base = picked ?? lastTurnAt();
const text = [0, 1, 3, 10]
	.map((plus) => {
		const at = base + plus * 864e5;
		clock = at;
		const block = loom.memoryBlock(PERSONA, { at });
		return `===== at=+${plus}d (${new Date(at).toISOString()}) =====\n${block}`;
	})
	.join('\n\n');
if (OUT === '') {
	console.log(text);
} else {
	fs.writeFileSync(OUT, text, 'utf8');
	console.log(`写出 ${OUT}（${text.length} 字）`);
}
loom.dispose();
