/**
 * 灌入的每轮代价在哪一段突然跳（2026-11-14，§105.9 的遗留）。
 *
 * §105.5 的表里有一处没解释：2,000 → 2,500 轮之间，每轮灌入 40.8 → 142.3 ms，
 * 而同一段的取面是平滑的（0.18 → 0.26 s）。250 轮一段的量法看不出那一步踩在
 * 哪一轮，也看不出踩的是哪条语句。
 *
 * 这里两件事一起做：每 100 轮打一次中位/每轮耗时，并且把每段内按 SQL 模板聚合
 * **执行**时间。判据是「某条模板的每次耗时在某一段突然变大」，而不是「总耗时变大」
 * ——总量变大是结果，模板才是原因。
 *
 *     node bench-22/probe-ingest-step.mjs [--persona M02] [--to 2600] [--win 100]
 *
 * 只读产品接口，不改 `lib/`。库在临时目录，`--keep` 留一份给事后 EXPLAIN。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

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
const TO = Number(arg('to', 2600));
const WIN = Number(arg('win', 100));

/* ── 打点：按 SQL 模板聚合执行时间 ─────────────────────────────────────── */
let bucket = null;
const label = (sql) => String(sql).replace(/\s+/g, ' ').trim().slice(0, 120);
for (const name of ['run', 'all', 'get']) {
	const orig = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...a) {
		if (!bucket) return orig.apply(this, a);
		const began = performance.now();
		try {
			return orig.apply(this, a);
		} finally {
			const key = label(this.sourceSQL ?? '?');
			const one = bucket.get(key) ?? { n: 0, ms: 0 };
			one.n += 1;
			one.ms += performance.now() - began;
			bucket.set(key, one);
		}
	};
}
const origPrepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql, ...rest) {
	const stmt = origPrepare.call(this, sql, ...rest);
	try {
		Object.defineProperty(stmt, 'sourceSQL', { value: String(sql), enumerable: false });
	} catch {
		/* 不可写就算了 */
	}
	return stmt;
};

const rows = fs
	.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.slice(0, TO)
	.map((line) => JSON.parse(line));

const { createLoom } = await import('../loom-e2e/harness.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-step-'));
const dbPath = path.join(dir, 'loom.db');
const loom = createLoom({
	dbPath,
	config: { consolidation: { triggerTokens: 0 } },
	settleRounds: 1,
});

/* 行数快照：跳变如果和某张表跨过某个量同时发生，这条线索比耗时更硬。 */
const side = new DatabaseSync(dbPath);
const counts = () => {
	const one = (sql) => {
		try {
			return side.prepare(sql).get()?.n ?? 0;
		} catch {
			return 0;
		}
	};
	return {
		l0: one('SELECT COUNT(*) AS n FROM l0'),
		pending: one('SELECT COUNT(*) AS n FROM l0 WHERE consolidated = 0'),
		facts: one('SELECT COUNT(*) AS n FROM facts'),
		events: one('SELECT COUNT(*) AS n FROM events'),
		due: one('SELECT COUNT(*) AS n FROM l0_due'),
	};
};
/* 行数快照要和产品共用连接的话，会在灌入中途读到锁；单独开一条只读连接即可。 */

const perTurn = [];
const windows = [];
const beganAll = performance.now();
/* 第一段前 10 轮是建表、编译语句的预热，不进统计也不进模板聚合。 */
const WARM = 10;
for (const [index, row] of rows.entries()) {
	if (index === WARM) bucket = new Map();
	const began = performance.now();
	await loom.turn(PERSONA, row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
	perTurn.push(performance.now() - began);
	if ((index + 1) % WIN !== 0 && index !== rows.length - 1) continue;
	const from = Math.max(WARM, (index + 1) - WIN);
	const slice = perTurn.slice(from, index + 1).sort((a, b) => a - b);
	const stats = bucket ?? new Map();
	/* 行数快照自己会跑 COUNT(*)，把它挡在统计窗口外——第一版让它混进了模板表，
	 * 「SELECT COUNT(*) FROM l0」凭空涨了 2.5 倍，那是尺子的账。 */
	bucket = null;
	const c = counts();
	windows.push({
		at: index + 1,
		median: slice[Math.floor(slice.length / 2)],
		p90: slice[Math.floor(slice.length * 0.9)],
		wall: (performance.now() - beganAll) / 1000,
		stats,
		counts: c,
	});
	bucket = new Map();
}

console.log(`\n${PERSONA} 灌 ${perTurn.length} 轮，每 ${WIN} 轮一段，总耗时 ${((performance.now() - beganAll) / 1000).toFixed(0)} s`);
console.log(`  轮次段      中位       p90       l0   未整合  facts  events  l0_due`);
for (const one of windows) {
	const c = one.counts;
	console.log(
		`  ${String(one.at).padStart(5)}  ${one.median.toFixed(1).padStart(7)} ms  ${one.p90.toFixed(1).padStart(7)} ms  ` +
			`${String(c.l0).padStart(5)} ${String(c.pending).padStart(6)} ${String(c.facts).padStart(6)} ${String(c.events).padStart(7)} ${String(c.due).padStart(6)}`,
	);
}

/* 模板级的形状：每段的「每次耗时」。某条在某一段突然抬起来，它就是那一步。 */
const all = new Set();
for (const one of windows) for (const key of one.stats.keys()) all.add(key);
const shape = [];
for (const key of all) {
	const series = windows.map((one) => {
		const s = one.stats.get(key);
		return s ? { avg: s.ms / s.n, n: s.n } : { avg: 0, n: 0 };
	});
	const total = series.reduce((sum, s) => sum + s.avg * s.n, 0);
	const first = series.find((s) => s.n > 0);
	const last = [...series].reverse().find((s) => s.n > 0);
	shape.push({ key, total, series, first, last, ratio: last && first ? last.avg / Math.max(first.avg, 1e-6) : 1 });
}
shape.sort((a, b) => b.total - a.total);
console.log('\n=== 累计执行时间前 8 的模板（每段「每次耗时」ms）===');
const head = windows.map((one) => String(one.at).padStart(6)).join('');
for (const one of shape.slice(0, 8)) {
	const line = one.series.map((s) => (s.n ? s.avg.toFixed(2).padStart(6) : '     ·')).join('');
	console.log(`  ${(one.total / 1000).toFixed(2).padStart(6)}s ${line}  x${one.ratio.toFixed(1)}  ${one.key}`);
}
console.log(`  ${' '.repeat(8)}${head}`);
console.log('\n=== 每次耗时涨幅最大的模板（首段 → 末段，只算两段都有调用的）===');
for (const one of [...shape].sort((a, b) => b.ratio - a.ratio).slice(0, 6)) {
	console.log(`  ${'×'}${one.ratio.toFixed(1).padStart(5)}  ${one.first.avg.toFixed(2)} → ${one.last.avg.toFixed(2)} ms  ${one.key}`);
}

loom.dispose();
side.close();

if (argv.includes('--keep')) {
	const out = path.join(HERE, 'work', `${PERSONA}-${perTurn.length}.db`);
	fs.rmSync(out, { force: true });
	const src = new DatabaseSync(dbPath);
	try {
		src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
	} finally {
		src.close();
	}
	console.log(`\n库已保留：${out}`);
}
fs.rmSync(dir, { recursive: true, force: true });
