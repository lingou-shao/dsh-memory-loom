/**
 * 到期区：某一行到底有没有进 `l0_due`（2026-11-13）。
 *
 * 0.2.72 把到期窗口从「渲染时全库扫」改成「写入时算好落表」，2.2 自然榜上
 * 「沾到」从 34 掉到 31，少的那几条都是「下个月3号」「下周三」这种。
 * 这个脚本把某一句单独拎出来看：它在 `l0` 里、`l0_due` 里有没有、窗口是多少。
 *
 *   node bench-22/diag-due-gap.mjs --persona M01 --turns 1600 --like 一诺生日
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

const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : fallback;
};
const PERSONA = arg('persona', 'M01');
const TURNS = Number(arg('turns', 1600));
const LIKE = arg('like', '一诺生日');

const rows = fs
	.readFileSync(path.join(DATA, 'histories', `${PERSONA}.jsonl`), 'utf8')
	.split('\n')
	.filter((l) => l.trim())
	.slice(0, TURNS)
	.map((l) => JSON.parse(l));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-due-'));
const loom = createLoom({ dbPath: path.join(dir, 'loom.db'), config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
for (const row of rows) await loom.turn(PERSONA, row['用户消息'], row['助手回复'], { at: Date.parse(row['逻辑时间']) });
loom.dispose();

const db = new DatabaseSync(path.join(dir, 'loom.db'), { readOnly: true });
const show = (ts) => (ts === null || ts === undefined ? 'NULL' : new Date(Number(ts)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }));
const hits = db.prepare('SELECT id, turn, created_at, timezone, text FROM l0 WHERE role = ? AND text LIKE ?').all('user', `%${LIKE}%`);
console.log(`l0 命中 ${hits.length} 行`);
for (const h of hits) {
	const due = db.prepare('SELECT * FROM l0_due WHERE l0_id = ?').get(Number(h.id));
	console.log(`\n l0#${h.id}  turn ${h.turn}  说于 ${show(h.created_at)}  tz=${h.timezone}`);
	console.log(`   ${String(h.text).slice(0, 70)}`);
	if (due === undefined) {
		console.log('   l0_due：缺失');
	} else {
		console.log(`   l0_due：due ${show(due.due_from)} → ${show(due.due_to)}   节日 ${show(due.fest_from)} → ${show(due.fest_to)}   tz=${due.tz}`);
	}
}
const counted = db.prepare('SELECT COUNT(*) AS n FROM l0_due').get();
const total = db.prepare('SELECT COUNT(*) AS n FROM l0').get();
console.log(`\nl0_due ${counted.n} 行 / l0 ${total.n} 行`);
db.close();
fs.rmSync(dir, { recursive: true, force: true });
