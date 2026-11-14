/**
 * 打开一个**已经灌好的**库，把时钟拨到某一刻，问：那一刻的常驻块与检索结果是什么。
 *
 * 为什么要单独一个脚本：`probe_surface.py` 取面时每题都要重新灌到 cutoff，一次
 * 整卷 55 分钟；而「块里为什么没有这一行」是**只读**的问题，库不动。有了
 * `build-22-db.mjs` 留下的库，这里几秒一次。
 *
 *   node bench-22/diag-block-at.mjs --db work/db/M01-5668.db --sid M01 \
 *        --now 2027-02-01T14:10:14+08:00 --ask "下午好困
 * 眼皮直打架"
 *
 * 打印：常驻块、`memory_search` 的前 N 条、以及 `quotesOnDay` 的**全部候选**
 * （排序后，前 12 条），用来分辨「候选里没有」和「名额没排上」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB = path.resolve(argOf('db', path.join(HERE, 'work', 'db', 'M01-5668.db')));
const SID = argOf('sid', 'M01');
const NOW = argOf('now', null);
const ASK = argOf('ask', '');
const LIMIT = Number(argOf('limit', 10));
if (!fs.existsSync(DB)) throw new Error(`库不存在：${DB}`);
if (!NOW) throw new Error('要给 --now');

/* 产品读 `Date.now()`；不换掉，块里的「今天」就是脚本启动那一刻。 */
const realNow = Date.now;
let clock = Date.parse(NOW);
Date.now = () => clock;

const loom = createLoom({ dbPath: DB, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
/* 库是共享的，脚本只读不写回：打开时产品会写 trace / 刷新派生层，这里让它写，
 * 但库里已有的 l0 / facts 不动。 */
const block = loom.memoryBlock(SID);
console.log(`=== 常驻块（now=${NOW}，${block.length} 字）`);
console.log(block || '（空）');

if (ASK) {
	const out = String(await loom.call('memory_search', { query: ASK, limit: LIMIT }, SID));
	console.log(`\n=== memory_search(“${ASK.replace(/\n/g, ' / ')}”，limit=${LIMIT})`);
	console.log(out || '（空）');
	const deep = String(await loom.call('memory_search', { query: ASK, limit: 30 }, SID));
	console.log(`\n=== limit=30 的前 30 条（只看条数）`);
	console.log(deep.split('\n').slice(0, 2).join('\n'));
}
loom.dispose();
Date.now = realNow;

/* 候选集：复制 product 的查询，但**不截断**，好分辨「没候选」与「名额没排上」。 */
const db = new DatabaseSync(DB, { readOnly: true });
const at = Date.parse(NOW);
const rows = db
	.prepare(`SELECT l0_id AS id, turn, created_at, due_from, due_to, fest_from, fest_to, substr(text,1,60) AS text
	          FROM l0_due WHERE created_at >= ? AND (
	            (due_from IS NOT NULL AND due_from <= ? AND due_to >= ?) OR
	            (fest_from IS NOT NULL AND fest_from <= ? AND fest_to >= ?)
	          )`)
	.all(at - 120 * 864e5, at, at, at, at);
const show = (t) =>
	t === null || t === undefined ? '—' : new Date(Number(t)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
rows.sort((a, b) => {
	const la = a.due_from ?? a.fest_from;
	const lb = b.due_from ?? b.fest_from;
	const sa = Math.floor((Number(a.created_at) + 8 * 3600e3) / 864e5);
	const sb = Math.floor((Number(b.created_at) + 8 * 3600e3) / 864e5);
	return (lb - sb * 864e5) - (la - sa * 864e5);
});
console.log(`\n=== 到期候选（窗口覆盖 now 的全部 ${rows.length} 条，按提前量降序，前 12）`);
for (const r of rows.slice(0, 12)) {
	console.log(`  #${r.id} turn ${r.turn} 说于 ${show(r.created_at)}  due ${show(r.due_from)}→${show(r.due_to)}  fest ${show(r.fest_from)}→${show(r.fest_to)}`);
	console.log(`     ${String(r.text).replace(/\n/g, ' ')}`);
}
db.close();
