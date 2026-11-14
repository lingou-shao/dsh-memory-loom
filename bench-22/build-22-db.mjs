/**
 * 把 2.2 的某个人物灌进一个**留下来**的库，供反复查询。
 *
 * 取面脚本每题只往前推到 cutoff，跑完把临时库删了；它的产物是「答题模型看到什么」。
 * 想知道「到期区为什么不显示这一行」时，要的是库本身：`l0_due` 有没有那一行、
 * `quotesOnDay` 的候选集和排序、块里最后留下了哪几条。
 *
 *   node bench-22/build-22-db.mjs --persona M01 --turns 5668
 *   node bench-22/build-22-db.mjs --persona M02 --turns 2286 --out bench-22/work/db/M02.db
 *
 * 默认写在 `bench-22/work/db/<persona>-<turns>.db`；`FORCE=1` 重灌。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));
if (!DATA) throw new Error('找不到题库：设 BENCH22_DATA');

const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const PERSONA = argOf('persona', 'M01');
const TURNS = Number(argOf('turns', 0));
const OUT = argOf('out', path.join(HERE, 'work', 'db', `${PERSONA}-${TURNS || 'all'}.db`));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
if (fs.existsSync(OUT) && process.env.FORCE !== '1') {
	console.error(`${OUT} 已存在，跳过（FORCE=1 重灌）`);
	process.exit(0);
}
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(OUT + suffix, { force: true });

const rows = fs
	.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8')
	.split('\n')
	.filter((line) => line.trim())
	.map((line) => JSON.parse(line));
const use = TURNS ? rows.slice(0, TURNS) : rows;

const loom = createLoom({ dbPath: OUT, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
const started = Date.now();
let n = 0;
for (const row of use) {
	await loom.turn(PERSONA, row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
	n += 1;
	if (n % 500 === 0) console.error(`  ${n}/${use.length} 轮，${((Date.now() - started) / 1000).toFixed(0)}s`);
}
loom.dispose();
console.error(`${OUT} 灌完 ${use.length} 轮，${((Date.now() - started) / 1000).toFixed(0)}s`);
