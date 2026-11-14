/**
 * 台阶是不是 mark/rewind 带来的（2026-11-14，§105.9）。
 *
 * 同一个进程里连续灌 M02 到 2,800 轮，每轮 36–38 ms，一路平；可走桥
 * （`probe-run-cost.py`）到 2,100 轮之后突然变成 190–220 ms/轮，而且**持续**
 * 不回落。两边只差三件事：RPC 走 stdio、每 100 轮 `mark`（VACUUM INTO）、
 * 每 100 轮 `rewind`（关掉实例、把快照拷回来、重新建实例）。
 *
 * 这个脚本把 mark/rewind 搬进同一进程，模式用参数选，一次只动一个变量：
 *
 *   --mode none    不 snapshot 不重建（基线，应当一直平）
 *   --mode copy    每段把库拷成新文件，dispose 旧实例再从新文件建
 *   --mode vacuum  同 copy，但拷贝前先 wal_checkpoint(TRUNCATE) + VACUUM INTO
 *
 * 每段同时记 RSS 与 heap，区分「原生内存/句柄堆积」和「JS 堆」。
 *
 *     node bench-22/probe-rewind-step.mjs --mode vacuum --to 2800 --win 100
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
const TO = Number(arg('to', 2800));
const WIN = Number(arg('win', 100));
const MODE = arg('mode', 'vacuum');

const rows = fs
	.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.slice(0, TO)
	.map((line) => JSON.parse(line));

const { createLoom } = await import('../loom-e2e/harness.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-rew-'));
let dbPath = path.join(dir, 'loom.db');
const mk = (file, startTurns) =>
	createLoom({
		dbPath: file,
		config: { consolidation: { triggerTokens: 0 } },
		startTurns,
		settleRounds: 1,
	});
let loom = mk(dbPath, {});
let snapSeq = 0;

/** 桥的 snapshot()：另开连接 checkpoint 再 VACUUM INTO。 */
function snapshot() {
	snapSeq += 1;
	const target = path.join(dir, `snap-${snapSeq}.db`);
	const side = new DatabaseSync(dbPath);
	try {
		side.exec('PRAGMA busy_timeout = 8000');
		try {
			side.exec('PRAGMA wal_checkpoint(TRUNCATE)');
		} catch {
			/* 没有 WAL 也正常 */
		}
		side.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
	} finally {
		side.close();
	}
	return target;
}

/** 只 checkpoint，不做 VACUUM：区分「冻结」和「重写整库」两件事。 */
function checkpoint() {
	const side = new DatabaseSync(dbPath);
	try {
		side.exec('PRAGMA busy_timeout = 8000');
		side.exec('PRAGMA wal_checkpoint(TRUNCATE)');
	} finally {
		side.close();
	}
}

function copyOf(file) {
	const target = path.join(dir, `flat-${snapSeq}.db`);
	fs.rmSync(target, { force: true });
	fs.copyFileSync(file, target);
	return target;
}

/** 桥的 restore()：关实例、拷回新文件、重建。 */
function restore(snap) {
	const target = path.join(dir, `work-${snapSeq}.db`);
	loom.dispose?.();
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			fs.copyFileSync(snap, target);
			break;
		} catch (error) {
			if (error?.code !== 'EBUSY' && error?.code !== 'EPERM') throw error;
			const until = Date.now() + 50;
			while (Date.now() < until) {
				/* 重试等句柄释放 */
			}
		}
	}
	dbPath = target;
	loom = mk(dbPath, startTurns);
}
let startTurns = {};

const perTurn = [];
const windows = [];
const beganAll = performance.now();
for (const [index, row] of rows.entries()) {
	const began = performance.now();
	await loom.turn(PERSONA, row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
	perTurn.push(performance.now() - began);
	startTurns = { [PERSONA]: index + 1 };
	if ((index + 1) % WIN !== 0) continue;

	let markMs = 0;
	if (MODE !== 'none') {
		/* `--retrieve` 复刻 `probe-run-cost.py` 每段尾巴上的那三件事：常驻块、
		 * 检索、两次展开。它们都会写库（`markAccessed`、到期游标），而写的东西
		 * 下一句 rewind 就扔了——所以要问的是「这些读操作把什么东西留下了」。 */
		if (argv.includes('--retrieve')) {
			const q = rows[Math.max(0, index - 1)]?.['用户消息'] ?? '';
			loom.memoryBlock(PERSONA);
			const hits = String(loom.call('memory_search', { query: q, limit: 10 }, PERSONA));
			for (const ref of [...hits.matchAll(/#([FEPL]\d+(?:-\d+)?)/g)].map((m) => m[1]).slice(0, 2)) {
				loom.call('memory_expand', { ref: '#' + ref }, PERSONA);
			}
		}
		const t0 = performance.now();
		/* copy 模式也要先 checkpoint，否则拷到的是缺了 WAL 尾巴的旧状态——
		 * 那样比较的就不是「VACUUM 有没有害」，而是「少拷了几个提交」。 */
		const snap = MODE === 'vacuum' ? snapshot() : (checkpoint(), copyOf(dbPath));
		restore(snap);
		markMs = performance.now() - t0;
	}

	const slice = perTurn.slice(-WIN).sort((a, b) => a - b);
	const mem = process.memoryUsage();
	windows.push({
		at: index + 1,
		median: slice[Math.floor(WIN / 2)],
		avg: perTurn.slice(-WIN).reduce((sum, one) => sum + one, 0) / WIN,
		max: slice[WIN - 1],
		slow: perTurn.slice(-WIN).filter((one) => one > 3 * slice[Math.floor(WIN / 2)]).length,
		markMs,
		rss: mem.rss / 1048576,
		heap: mem.heapUsed / 1048576,
	});
}

console.log(`\n${PERSONA} 灌 ${perTurn.length} 轮 · 模式 ${MODE} · 每 ${WIN} 轮重建一次 · 总耗时 ${((performance.now() - beganAll) / 1000).toFixed(0)} s`);
console.log(`  轮次段      中位      均值      峰  慢轮  重建      RSS    heap`);
for (const one of windows) {
	console.log(
		`  ${String(one.at).padStart(5)}  ${one.median.toFixed(1).padStart(7)} ms  ${one.avg.toFixed(1).padStart(7)} ms  ` +
			`${one.max.toFixed(0).padStart(6)}  ${String(one.slow).padStart(3)}  ${one.markMs.toFixed(0).padStart(5)} ms  ` +
			`${one.rss.toFixed(0).padStart(5)} MB  ${one.heap.toFixed(0).padStart(4)} MB`,
	);
}

loom.dispose();
fs.rmSync(dir, { recursive: true, force: true });
