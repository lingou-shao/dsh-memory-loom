/**
 * Benchmark 2.1 的取面脚本（开发集 212 题）。
 *
 * 1.0 那套（surface-coverage.mjs）是「证据原话在不在这几个面上」，需要
 * grading/evidence.jsonl 里的 fact 引文。2.1 的答案键只给 anchors（轮次 + 时间），
 * 没有引文，所以这里不量覆盖面，只**照评测程序的接口把记忆文本取出来**：
 * 注入块 + 搜索行 + 前两条指针的展开正文——就是答题模型真正会看到的那三段。
 *
 * 与官方 runner 的对齐点（逐条对过 benchmark-2.1/harness/bench21/runner.py）：
 *   - 只灌到 cutoff_turn 为止，一轮不多（`while pos < cutoff`）；
 *   - 灌完把钟拨到题目的 `now`（`clock = exam.now`），再检索；
 *   - 提取是只读的：只调 memory_search / memory_expand，不写；
 *   - 输出里带 `leak_turns`：从取回的文本里抠 `#L<轮次>`，凡大于 cutoff 的记下来。
 *     我们按构造不可能越界（库里根本没有未来的轮），这一列是「按构造」的证据。
 *
 *   node bench-hmb/surface-21.mjs                 # 两个人物全卷
 *   node bench-hmb/surface-21.mjs --personas M01
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const OUT = process.env.CMB21_OUT ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/work/surface-21.jsonl';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const LIMIT = Number(argOf('limit', 10));
const EXPANDS = Number(argOf('expands', 2));
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);
/** 已知会打崩进程的题号（`CMB21_SKIP=a,b`），跳过而不是整卷重来。 */
const SKIP = new Set(String(process.env.CMB21_SKIP ?? '').split(',').map((one) => one.trim()).filter(Boolean));
/** 逐轮落盘日志（`CMB21_TURNLOG=path`）：进程被硬杀时靠最后一行定位是哪一轮。 */
const TURNLOG = String(process.env.CMB21_TURNLOG ?? '');
/** 冒烟用：每个人物只取前 N 题（按 cutoff 升序），量接口不量成绩。 */
const N = Number(argOf('n', 0));
/**
 * 闸门的第三条旁路：共享几个内容词就放行（0 = 关闭，见 lib 的 `solidOverlap`）。
 * 它只能在 `createLoom` 时给 —— 运行时改 `loom.settings` 不会到达引擎（§70.7）。
 */
const SOLID = Number(argOf('solid', 0));
/** 话题链入口（§79）：`--topic always` 每次检索都跑。空 = 用产品默认（只看意图）。 */
const TOPIC = argOf('topic', '');

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/**
 * 从一段文本里抠出所有 `#L<起始>(-<结束>)?`。
 * 注意：这是 L0 的**行号**，不是轮次——一轮对话两行（用户一条、助手一条），
 * 所以 `#L31-34` 是第 16–17 轮。拿它直接跟 `cutoff_turn` 比会误报一倍（第一版就这么错了）。
 * 真正的越界判定在 `check-21-leak.mjs` 里，回库查 `turn` 列。
 */
function l0Refs(text) {
	const out = [];
	for (const m of String(text).matchAll(/#L(\d+)(?:-(\d+))?/gu)) out.push([Number(m[1]), Number(m[2] ?? m[1])]);
	return out;
}

/*
 * 边跑边落盘。
 *
 * 全卷一轮 45 分钟，原来只在收尾 `writeFileSync` 一次，后台跑被打断就一点不剩
 * （2026-11-10 实际吃了这一下：M02 跑到 190/212 被回收，产物为空）。
 * 现在每题追加一行；`CMB21_RESUME=1` 时把已完成的题读回来，只补没做完的。
 * 越界那两列（`max_turn_seen` / `leak_turns`）要回库查行号，只在**整卷跑完**后
 * 补写一遍；中途断掉的文件缺这两列，但那两列是断言不是读数，不影响取面。
 */
const done = new Map();
if (process.env.CMB21_RESUME === '1' && fs.existsSync(OUT)) {
	for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
		if (!line.trim()) continue;
		const row = JSON.parse(line);
		done.set(row.id, row);
	}
	if (done.size > 0) console.error('续跑：已有', done.size, '题');
}

const rows = [];
for (const persona of PERSONAS) {
	const mine = exams.filter((one) => one.persona === persona).sort((a, b) => a.cutoff_turn - b.cutoff_turn);
	if (N > 0) mine.splice(N);
	if (mine.length === 0) continue;
	const already = mine.filter((one) => done.has(one.id)).map((one) => done.get(one.id));
	rows.push(...already);
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `s21-${persona}-`));
	const dbPath = path.join(dir, 'loom.db');

	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;

	/*
	 * 检查点（§81.2）：整卷重放要 15 分钟，后台进程到点会被收走，于是每轮都白跑。
	 * 把「库 + cursor + 时钟」定期存下来，重启时直接从断点接着灌，不再从第 1 轮重放。
	 * 用 `VACUUM INTO` 存快照（打开中的库直接 copy 可能拿到半页）。
	 */
	const CKPT = process.env.CMB21_CKPT ?? '';
	const ckptDir = CKPT === '' ? '' : path.join(CKPT, persona);
	if (ckptDir !== '' && fs.existsSync(path.join(ckptDir, 'meta.json'))) {
		fs.copyFileSync(path.join(ckptDir, 'loom.db'), dbPath);
		const meta = JSON.parse(fs.readFileSync(path.join(ckptDir, 'meta.json'), 'utf8'));
		clock = Number(meta.clock);
		console.error('检查点续跑：cursor', meta.cursor, '时钟', new Date(clock).toISOString());
	}

	const loom = createLoom({
		dbPath,
		config: { consolidation: { triggerTokens: 0 }, retrieval: { solidOverlap: SOLID, ...(TOPIC === '' ? {} : { topicTrigger: TOPIC }) } }
	});
	const SID = `s21-${persona}`;
	let cursor = 0;
	let previous = null;
	if (ckptDir !== '' && fs.existsSync(path.join(ckptDir, 'meta.json'))) {
		cursor = Number(JSON.parse(fs.readFileSync(path.join(ckptDir, 'meta.json'), 'utf8')).cursor);
	}
	const saveCheckpoint = () => {
		if (ckptDir === '') return;
		fs.mkdirSync(ckptDir, { recursive: true });
		const target = path.join(ckptDir, 'loom.db');
		const tmp = `${target}.tmp`;
		try {
			/* 另开一条只读连接做快照：引擎那条连接正在用，别在它上面跑 VACUUM。 */
			const side = new DatabaseSync(dbPath);
			side.exec('PRAGMA busy_timeout = 8000');
			fs.rmSync(tmp, { force: true });
			side.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
			side.close();
			fs.rmSync(target, { force: true });
			fs.renameSync(tmp, target);
			fs.writeFileSync(path.join(ckptDir, 'meta.json'), JSON.stringify({ cursor, clock, previous }), 'utf8');
		} catch (error) {
			console.error('检查点失败', String(error?.message ?? error));
		}
	};
	try {
		for (const exam of mine) {
			/*
			 * 单题容错（§81）：M02 跑到第 43 题（`M02-G011/d045`，cutoff 1504）时进程
			 * 直接消失、连错误都没打。那种死法不是 JS 异常，试不了就不试——记下来、跳过去，
			 * 别让一题带走剩下的 34 题。
			 */
			if (SKIP.has(exam.id)) {
				console.error('跳过', exam.id, '（CMB21_SKIP）');
				continue;
			}
			try {
			for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
				const turn = turns[cursor];
				const at = Date.parse(turn['逻辑时间']);
				clock = at;
				if (TURNLOG !== '') fs.appendFileSync(TURNLOG, `${persona} 轮次 ${turn['轮次']} cursor ${cursor}\n`, 'utf8');
				/* 先存再灌：`cursor` 记的是「下一条要灌的」，重启后才不会把同一条灌两遍。 */
				if (CKPT !== '' && cursor % 25 === 0) saveCheckpoint();
				await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
				previous = at;
			}
			clock = Math.max(clock, Date.parse(exam.now));
			if (done.has(exam.id)) continue;
			const block = String(loom.memoryBlock(SID));
			const search = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, SID));
			const refs = [...String(search).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]);
			const expanded = [];
			for (const ref of refs.slice(0, EXPANDS)) {
				try {
					expanded.push({ ref, text: String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)) });
				} catch (error) {
					expanded.push({ ref, text: '', error: String(error?.message ?? error) });
				}
			}
			const all = [block, search, ...expanded.map((one) => one.text)].join('\n');
			const row = {
				id: exam.id,
				persona,
				cutoff_turn: exam.cutoff_turn,
				now: exam.now,
				question: exam.question,
				context: { block, search, expanded },
				refs: l0Refs(all).map(([from, to]) => `${from}-${to}`)
			};
			rows.push(row);
			fs.appendFileSync(OUT, JSON.stringify(row) + '\n', 'utf8');
			saveCheckpoint();
			if (rows.length % 10 === 0) console.error(persona, rows.length, '题', 'cursor', cursor, '/', turns.length);
			} catch (error) {
				console.error('单题失败', exam.id, String(error?.stack ?? error));
			}
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}

	/*
	 * 越界判定要回库查 `turn` 列：`#L` 是行号不是轮次，直接比会误报一倍。
	 * 这里在同一个库上开只读连接，把每题抓到的行号映射成轮次，再跟 cutoff 比。
	 */
	const db = new DatabaseSync(dbPath, { readOnly: true });
	const turnOf = new Map(db.prepare('SELECT id, turn FROM l0').all().map((row) => [row.id, row.turn]));
	db.close();
	for (const row of rows.filter((one) => one.persona === persona)) {
		// 续跑读回来的行已经删了 `refs`（那是回库查轮次用的中间量），跳过即可。
		if (!row.refs) continue;
		let worst = 0;
		for (const span of row.refs) {
			const [from, to] = span.split('-').map(Number);
			for (let id = from; id <= to; id++) worst = Math.max(worst, turnOf.get(id) ?? 0);
		}
		row.max_turn_seen = worst;
		row.leak_turns = worst > row.cutoff_turn;
		delete row.refs;
	}
	console.error(persona, '完成', mine.length, '题；库', (fs.statSync(dbPath).size / 1024 / 1024).toFixed(1), 'MB');
}

fs.writeFileSync(OUT, rows.map((one) => JSON.stringify(one)).join('\n') + '\n', 'utf8');
const leaks = rows.filter((one) => one.leak_turns).map((one) => one.id);
const sizes = rows.map((one) => one.context.block.length + one.context.search.length);
console.log(`写 ${OUT}：${rows.length} 题，越界 ${leaks.length} 条`, leaks.slice(0, 5));
console.log('记忆文本长度中位', sizes.sort((a, b) => a - b)[sizes.length >> 1], '字');
