/**
 * 逐通道关闭，定位 `memory_search` 里每一条结果是从哪条路进来的。
 *
 *   node bench-22/diag-lane.mjs --db work/db/M01-5668.db --ask "..." --now ISO
 *
 * 只读库、不改 lib。判据是「关掉某一路，某条结果消失」，比读代码推断可靠：
 * 同一条结果可能同时被几条路命中，关一路不掉不等于没用。
 */
import path from 'node:path';
import { createLoom } from '../loom-e2e/harness.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const argOf = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i === -1 ? fallback : process.argv[i + 1];
};
const DB = path.resolve(argOf('db', path.join(HERE, 'work', 'db', 'M01-5668.db')));
const ASK = String(argOf('ask', '')).replaceAll('\\n', '\n');
const NOW = argOf('now', '2027-02-01T14:10:00+08:00');
const SID = argOf('sid', 'M01');

const realNow = Date.now;
Date.now = () => Date.parse(NOW);

const runs = {
	基线: {},
	'关原话 rawSearch=false': { retrieval: { rawSearch: false } },
	'关放宽 relaxMatch=false': { retrieval: { relaxMatch: false } },
	'关槽位 slotMax=0': { retrieval: { slotMax: 0 } },
	'实词旁路 solidOverlap=0': { retrieval: { solidOverlap: 0 } },
	'稀有旁路 rareTail=false': { retrieval: { rareTail: false } },
	'只留过闸 关原话+关稀有': { retrieval: { rawSearch: false, rareTail: false } },
	'闸门拉满 relaxMinOverlap=.99': { retrieval: { relaxMinOverlap: 0.99 } },
};

for (const [name, cfg] of Object.entries(runs)) {
	const loom = createLoom({ dbPath: DB, config: { consolidation: { triggerTokens: 0 }, ...cfg }, settleRounds: 1 });
	const out = String(await loom.call('memory_search', { query: ASK, limit: 10 }, SID));
	loom.dispose();
	const refs = [...out.matchAll(/#([EFDL][\w-]*)/g)].map((one) => one[1]);
	console.log(`${name.padEnd(32)} ${String(refs.length).padStart(3)} 条 | ${refs.join(' ')}`);
}
Date.now = realNow;
