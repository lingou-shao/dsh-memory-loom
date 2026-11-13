/**
 * 检索耗时随库大小的形状（2026-11-13）。
 *
 * 用户的问题不是「现在多慢」，是「库变大以后是不是每次检索都要更久」。要回答它
 * 只能造规模梯度，不能在一份库上量（§93：按行数增长的问题小基准量不出来）。
 *
 * 做法：拿一份已经灌好的真实库，把 `l0` 逐级复制（文本与 `tokens` 都是真语料，
 * 只换 id/session/turn），在每一级上跑同一批 dev 问句。每翻一倍报一次
 * 「ms/检索」和「ms/searchL0 调用」——两个数分开看，因为一个是结果，一个是成因。
 *
 * 已复制的内容会让同一个词的 DF 一并翻倍，这也正是真实增长时发生的事
 * （语料变大，命中的行数按比例变多），所以它测的是**排序代价**的增长，
 * 不是「库里多了一批与问句无关的词」那种乐观情形。
 *
 *   node bench-22/probe-search-scale.mjs --db bench-22/work/cmp-m02.db --n 8
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : fallback;
};
const dbIn = arg('db', path.join(HERE, 'work', 'cmp-m02.db'));
const PERSONA = arg('persona', 'M02');
const N = Number(arg('n', 8));
const LEVELS = Number(arg('levels', 3));

const DATA = [
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => fs.existsSync(path.join(one, 'exam-inputs.jsonl')));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-scale-'));
const copy = path.join(work, 'loom.db');
fs.copyFileSync(dbIn, copy);
for (const suffix of ['-wal', '-shm']) {
	if (fs.existsSync(dbIn + suffix)) fs.copyFileSync(dbIn + suffix, copy + suffix);
}

/* ── 打点：只计 searchL0 那一条，用来分「调用次数」与「单次代价」 ────────── */
let calls = { n: 0, ms: 0 };
let watching = false;
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
for (const name of ['run', 'all', 'get']) {
	const orig = StatementSync.prototype[name];
	StatementSync.prototype[name] = function (...a) {
		if (!watching) return orig.apply(this, a);
		const isL0 = String(this.sourceSQL ?? '').includes('bm25(l0_fts');
		const began = performance.now();
		try {
			return orig.apply(this, a);
		} finally {
			if (isL0) {
				calls.n += 1;
				calls.ms += performance.now() - began;
			}
		}
	};
}

const { createLoom } = await import('../loom-e2e/harness.mjs');
const loom = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
const questions = fs
	.readFileSync(path.join(DATA, 'exam-inputs.jsonl'), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line))
	.filter((row) => row.persona === PERSONA)
	.slice(0, N);

const runOne = async () => {
	calls = { n: 0, ms: 0 };
	watching = true;
	const began = performance.now();
	for (const item of questions) await loom.call('memory_search', { query: item.question, limit: 10 }, PERSONA);
	const total = performance.now() - began;
	watching = false;
	return { perSearch: total / questions.length, callsPer: calls.n / questions.length, perCall: calls.ms / calls.n, callMs: calls.ms / questions.length };
};

/* 预热：语句编译 + 页缓存。 */
await runOne();

const side = new DatabaseSync(copy);
const count = () => side.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
console.log(`起点 l0 ${count()} 行，${questions.length} 道 dev 问句\n`);
console.log('  规模      ms/检索   次/检索   单次 searchL0   searchL0 占比');
const out = [];
for (let level = 0; level <= LEVELS; level += 1) {
	const before = count();
	const one = await runOne();
	out.push({ rows: before, ...one });
	console.log(
		`  ${String(before).padStart(6)}  ${one.perSearch.toFixed(1).padStart(9)}  ${one.callsPer.toFixed(1).padStart(8)}  ` +
			`${one.perCall.toFixed(3).padStart(11)}ms  ${((one.callMs / one.perSearch) * 100).toFixed(0).padStart(9)}%`,
	);
	if (level === LEVELS) break;
	/* 复制一份：文本与 tokens 都是真语料，只换 id 之外的标识与轮次。 */
	side.exec(`
    INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone, event_id, consolidated, purge_at)
    SELECT session_id || '-g${level}', identity_id, turn + ${(level + 1) * 100000}, role, text, tokens,
           created_at, timezone, NULL, 1, NULL
    FROM l0 WHERE id <= ${before}
  `);
}

/* 规模翻倍时，ms/检索 涨了几倍：>1.5 就是「随库变大变慢」。 */
const first = out[0];
const last = out[out.length - 1];
const factor = last.perSearch / first.perSearch;
const rowsFactor = last.rows / first.rows;
console.log(
	`\n行数 ×${rowsFactor.toFixed(1)} → 每次检索 ×${factor.toFixed(2)}` +
		`（若线性于行数应为 ×${rowsFactor.toFixed(1)}，若与库大小无关应为 ×1.0）`,
);
console.log(
	`单次 searchL0 ×${(last.perCall / first.perCall).toFixed(2)}，调用次数 ×${(last.callsPer / first.callsPer).toFixed(2)}` +
		`　→ 增长来自${last.perCall / first.perCall > last.callsPer / first.callsPer ? '单次代价' : '调用次数'}`,
);

loom.dispose?.();
side.close();
fs.rmSync(work, { recursive: true, force: true });
