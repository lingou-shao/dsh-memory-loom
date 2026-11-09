/**
 * 自己陈述的槽（§57）。
 *
 * 中文口语里主语经常整个省掉：「写悬疑的，住哈尔滨」没有「我」，可它说的就是说话
 * 人自己。老的槽规则是照 chain 语料写的（「首次确立为」「调整为」），这种句子一条
 * 也匹配不上；而 `looksWorthKeeping` 那张表认的是「我叫」「我住」，省了主语也过
 * 不去——于是这句话既不成事实、也不进槽，「我住哪个城市」在库里连一个坐标都没有。
 *
 * 这一段验五件事：
 *   1. 省主语的自我陈述被抽成 (用户, 属性, 值)；
 *   2. 第一人称问句靠这个坐标取回它（零二元组重合）；
 *   3. 第三人称不误挂：「我妈住哈尔滨」不是用户的槽；
 *   4. 「我是说…」这类不是职业陈述；
 *   5. 只有槽、没有别的证据时，也不把无关的近期事实顶到前面。
 *
 *   node probe-self-slot.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, DAY } from './harness.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const BASE = Date.parse('2026-04-01T23:10:00+08:00');
const dir = mkdtempSync(join(tmpdir(), 'loom-self-slot-'));
const dbPath = join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });

const SCRIPT = [
	['这么晚还醒着的？我叫秦渡，秦始皇的秦，渡口的渡。写悬疑的，住哈尔滨。最近赶稿，作息彻底颠了。', '嗯，秦渡。'],
	['我妈住哈尔滨，她那边冷。', '她那边是冷。'],
	['白天补了会儿觉。', '嗯。'],
	['我是说，那个稿子还没收尾。', '知道了。']
];
let at = BASE;
for (const [user, reply] of SCRIPT) {
	await loom.turn('self', user, reply, { at });
	at += DAY;
}

const rows = (() => {
	const db = new DatabaseSync(dbPath);
	const list = db.prepare('SELECT subject, attr, value, text FROM facts ORDER BY id').all();
	db.close();
	return list;
})();

/* ── 1. 写侧 ─────────────────────────────────────────────────────── */
console.log('\n[1] 省主语的自我陈述进槽');
const city = rows.find((row) => row.attr === '城市' && row.value === '哈尔滨');
check('「写悬疑的，住哈尔滨」→ (用户, 城市, 哈尔滨)', city !== undefined && city.subject === '用户', city === undefined ? '没有这一行' : `${city.subject}/${city.attr}/${city.value}`);
const name = rows.find((row) => row.attr === '名称');
check('「我叫秦渡…」→ (用户, 名称, 秦渡)', name !== undefined && name.value === '秦渡', name === undefined ? '没有这一行' : `${name.subject}/${name.attr}/${name.value}`);

/* ── 2. 读侧 ─────────────────────────────────────────────────────── */
console.log('\n[2] 第一人称问句靠坐标取回（零二元组重合）');
const cityAnswer = String(await loom.call('memory_search', { query: '我住哪个城市来着？', limit: 10 }, 'self'));
check('取回了住址那一句', cityAnswer.includes('住哈尔滨'), cityAnswer.split('\n').slice(0, 3).join(' ').slice(0, 80));
check('命中的是事实，不是靠词面撞上的别句', /#F\d+/u.test(cityAnswer), cityAnswer.split('\n')[1] ?? '');

/* ── 3. 第三人称不误挂 ───────────────────────────────────────────── */
console.log('\n[3] 第三人称不写成用户的槽');
const wrong = rows.filter((row) => row.subject === '用户' && row.attr === '城市' && String(row.text).includes('我妈'));
check('「我妈住哈尔滨」没有变成 (用户, 城市)', wrong.length === 0, `${wrong.length} 行`);

/* ── 4. 「我是说」不是职业 ───────────────────────────────────────── */
console.log('\n[4] 非陈述不进槽');
check('没有从「我是说…」抽出职业', rows.every((row) => row.attr !== '职业' || row.value !== '说'), rows.filter((row) => row.attr === '职业').map((row) => row.value).join('/'));

/* ── 5. 不把无关的近期事实顶上来 ─────────────────────────────────── */
console.log('\n[5] 槽命中不挤掉别的证据');
const other = String(await loom.call('memory_search', { query: '稿子收尾了吗', limit: 10 }, 'self'));
check('无关问句不会因为槽而捞出住址', !other.includes('住哈尔滨'), other.split('\n').slice(0, 3).join(' ').slice(0, 80));

loom.dispose();
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
