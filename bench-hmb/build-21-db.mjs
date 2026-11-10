/**
 * 把某个人物的全卷灌进一个**留下来**的库，供离线分析。
 *
 * 取面脚本（surface-21.mjs）每题只往前推到 cutoff，跑完就把临时库删了——它的产物
 * 是「答题模型看到什么」，不是库本身。想知道「锚点词有几行」「答案轮离最后一次提
 * 到它有多远」这类问题时，要的是库。
 *
 * 能一次灌到底、再按 `created_at <= now` 回看过去，靠的是 l0 只追加：`UPDATE l0`
 * 只写 `consolidated` / `event_id` 两个标记列，`text` 永不改写（`lib/index.js:3046`）。
 * 所以全量库上任何 `now` 时刻的 l0 切片都等于当时那台库。facts / events 不是这样
 * （它们会被归并重写），分析里不碰那两张表。
 *
 *   node bench-hmb/build-21-db.mjs                    # 两个人物的库都建
 *   node bench-hmb/build-21-db.mjs --personas M01
 *   node bench-hmb/build-21-db.mjs --out /tmp/loom21 # 默认写到 /tmp/loom21
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const DS = process.env.CMB21_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench/benchmark-2.1/dataset';
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const PERSONAS = String(argOf('personas', 'M01,M02')).split(',').filter(Boolean);
const OUT = argOf('out', path.join(os.tmpdir(), 'loom21'));
fs.mkdirSync(OUT, { recursive: true });

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

for (const persona of PERSONAS) {
	const turns = jsonl(path.join(DS, `${persona}.jsonl`));
	const dbPath = path.join(OUT, `${persona}.db`);
	if (fs.existsSync(dbPath) && process.env.FORCE !== '1') {
		console.error(`${persona}: ${dbPath} 已存在，跳过（FORCE=1 重灌）`);
		continue;
	}
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });

	const realNow = Date.now;
	let clock = Date.parse(turns[0]['逻辑时间']);
	Date.now = () => clock;
	const started = realNow();
	const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
	const SID = `s21-${persona}`;
	try {
		for (let i = 0; i < turns.length; i++) {
			const turn = turns[i];
			const at = Date.parse(turn['逻辑时间']);
			clock = at;
			await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
			if ((i + 1) % 200 === 0) console.error(`  ${persona} ${i + 1}/${turns.length} 轮`);
		}
	} finally {
		loom.dispose?.();
		Date.now = realNow;
	}
	console.error(`${persona} 完成：${turns.length} 轮，${((realNow() - started) / 1000).toFixed(0)} 秒 → ${dbPath}`);
}
