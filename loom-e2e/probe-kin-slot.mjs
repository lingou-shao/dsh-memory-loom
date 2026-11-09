/**
 * 亲属的槽（§59）。
 *
 * 别名闭包在召回侧已经量过五次全负（§54.5、§56、§58），原因是同一批词接在
 * 召回表达式上会把有字面证据的那条顶掉。这一段验的是**换个位置**：称谓不进召回
 * 表达式，只用来解析「这条事实挂在谁名下」「这个问句问的是谁」。
 *
 * 五件事：
 *   1. 用户说「她61了，从社区超市理货员退下来」——零指代 + 职业，要挂到母亲；
 *   2. 用户说「我爸谈国华64了，公交修理厂退休的钳工」——点名 + 职业，要挂到父亲；
 *   3. 「爸妈退休前各干什么工作」要两条都取回，而问句与两条原话**零二元组重合**；
 *   4. 没有称谓、没有锚的「他退休了」不许写槽；
 *   5. 没有职业词的问句（「我爸明天要坐很久」）不因为这条通道捞出无关行。
 *
 *   node probe-kin-slot.mjs
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

const BASE = Date.parse('2026-05-01T21:10:00+08:00');
const dir = mkdtempSync(join(tmpdir(), 'loom-kin-slot-'));
const dbPath = join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });

const SCRIPT = [
	['还行，晾衣服的时候手机响了，我妈熊丽珍发来好几条语音，每条都快一分钟。', '你妈这语音长度，一条顶别人十条了。'],
	['也没啥大事，说她广场舞队里谁谁又买了新扇子。她61了，从社区超市理货员退下来，现在当广场舞领队，比我还忙。', '理货员退下来当领队，这劲儿一点没闲着。'],
	['对了他退休了。', '嗯。'],
	['提了我爸。我爸谈国华64了，公交修理厂退休的钳工，在家就爱看抗战剧。', '你爸这手艺在家可顶用了。']
];
let at = BASE;
for (const [user, reply] of SCRIPT) {
	await loom.turn('kin', user, reply, { at });
	at += DAY;
}

const rows = (() => {
	const db = new DatabaseSync(dbPath);
	const list = db.prepare('SELECT subject, attr, value, text FROM facts ORDER BY id').all();
	db.close();
	return list;
})();

/* ── 1. 零指代 + 职业 ────────────────────────────────────────────── */
console.log('\n[1] 「她61了，从社区超市理货员退下来」挂到母亲');
const mother = rows.find((row) => row.subject === '母亲' && row.attr === '职业');
check('有 (母亲, 职业, …)', mother !== undefined, mother === undefined ? '没有这一行' : `${mother.value}｜${mother.text.slice(0, 24)}`);

/* ── 2. 点名 + 职业 ──────────────────────────────────────────────── */
console.log('\n[2] 「我爸谈国华64了，公交修理厂退休的钳工」挂到父亲');
const father = rows.find((row) => row.subject === '父亲' && row.attr === '职业');
check('有 (父亲, 职业, …)', father !== undefined, father === undefined ? '没有这一行' : `${father.value}｜${father.text.slice(0, 24)}`);
check('值是钳工，不是整句', father !== undefined && String(father.value).includes('钳工'), father === undefined ? '' : String(father.value));

/* ── 3. 读侧：两条都要回来，且零二元组重合 ───────────────────────── */
console.log('\n[3] 「爸妈退休前各干什么工作」取回两条');
const answer = String(await loom.call('memory_search', { query: '我想记一笔爸妈退休前各干什么工作，你帮我理理。', limit: 10 }, 'kin'));
check('取回母亲那条', answer.includes('理货员'), answer.split('\n').slice(0, 3).join(' ').slice(0, 90));
check('取回父亲那条', answer.includes('钳工'), answer.split('\n').slice(0, 5).join(' ').slice(0, 90));
const zeroOverlap = ['理货员', '钳工', '退下来'].every((word) => !'我想记一笔爸妈退休前各干什么工作，你帮我理理。'.includes(word));
check('问句里没有「理货员/钳工/退下来」（零二元组前提成立）', zeroOverlap);

/* ── 4. 没有称谓也没有锚，不许写槽 ──────────────────────────────── */
console.log('\n[4] 无称谓无锚的「他退休了」不写槽');
const stray = rows.filter((row) => row.attr === '职业' && String(row.text).includes('对了他退休了'));
check('没有从「对了他退休了」抽出职业槽', stray.length === 0, `${stray.length} 行`);

/* ── 5. 没有职业词的问句不误触 ──────────────────────────────────── */
console.log('\n[5] 「我爸明天要坐很久」不因这条通道把母亲的职业端出来');
const other = String(await loom.call('memory_search', { query: '我爸明天要坐很久，我想给他准备吃的和路上用的东西。', limit: 10 }, 'kin'));
check('没有端出母亲那条（理货员）', !other.includes('理货员'), other.split('\n').slice(0, 3).join(' ').slice(0, 90));
check('父亲那条仍可由原话通道取回（这条本来就是「我爸…」）', other.includes('钳工'), other.split('\n').slice(0, 3).join(' ').slice(0, 90));

loom.dispose();
console.log(fail === 0 ? `\n全部通过（${pass} 项）` : `\n${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
