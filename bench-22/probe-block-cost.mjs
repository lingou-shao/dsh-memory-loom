/**
 * 常驻块的单次代价：`dueToday` 开与关各跑十次，看首轮与稳态。
 *
 * 起因：接了「今天该做的事」之后，自然榜 M02 从每题 15 秒涨到 30 秒，M01 从
 * 380 秒涨到 620 秒。猜了三种原因（正则太密、`Intl` 太慢、缓存没生效），都不该
 * 靠猜——直接量。
 *
 *   node bench-22/probe-block-cost.mjs <某个 loom.db>
 *
 * 用现成的库（跑批留下的临时目录里就有），不重新灌历史。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const PRODUCT = process.env.LOOM_PRODUCT || path.join(HERE, '..');
/* 实例要经 harness 建：`lib/index.js` 导出的是插件钩子，不导出 `createLoom`。 */
const { createLoom } = await import(pathToFileURL(path.join(PRODUCT, 'loom-e2e', 'harness.mjs')).href);

const src = process.argv[2];
if (typeof src !== 'string' || !fs.existsSync(src)) {
	console.error('用法：node bench-22/probe-block-cost.mjs <loom.db>');
	process.exit(2);
}

const runs = Number(process.env.RUNS ?? 10);
const rows = (() => {
	const db = new DatabaseSync(src, { readOnly: true });
	try {
		return db.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
	} finally {
		db.close();
	}
})();
console.log(`库 ${src}\n  l0 ${rows} 行`);

for (const on of [false, true]) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `blockcost-${on ? 'on' : 'off'}-`));
	const copy = path.join(dir, 'loom.db');
	fs.copyFileSync(src, copy);
	const loom = createLoom({ dbPath: copy, config: { consolidation: { triggerTokens: 0 }, retrieval: { dueToday: on } } });
	const sid = (() => {
		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			return db.prepare('SELECT session_id FROM l0 GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 1').get().session_id;
		} finally {
			db.close();
		}
	})();
	const spent = [];
	for (let i = 0; i < runs; i += 1) {
		const began = performance.now();
		loom.memoryBlock(sid);
		spent.push(performance.now() - began);
	}
	loom.dispose?.();
	console.log(
		`  dueToday ${on ? '开' : '关'}：首轮 ${spent[0].toFixed(0)} ms，` +
			`第 2–${runs} 次中位 ${[...spent.slice(1)].sort((a, b) => a - b)[Math.floor((runs - 1) / 2)].toFixed(1)} ms`,
	);
}
