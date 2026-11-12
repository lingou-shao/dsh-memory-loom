/**
 * 「今天到期」这一路在**真实题库**上到底有没有料 —— 拿 2.2 的 X4 逐题验。
 *
 *   node bench-22/diag-due.mjs NAT22-M01-D2003
 *
 * 三问，顺序不能反（§86.3 的教训：先问闸门，再问写侧）：
 *   1. 写侧有没有那一行：库里 `facts` / `l0` 有没有一句能把日子解到目标日；
 *   2. 闸门开不开：`strictHits` 是不是 0（否则这条通道根本没跑）；
 *   3. 端出来没有：`memory_search` 的返回里有没有它。
 *
 * 只跑一道题，不走全卷——目的是定位，不是读数。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/(?=[A-Za-z]:)/, '');
const DATA = [
	process.env.BENCH22_DATA ? path.join(process.env.BENCH22_DATA, 'benchmark-2.2', 'dataset') : '',
	path.join(HERE, '..', '..', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
	path.join(os.homedir(), 'Desktop', 'cmb-2.2', 'benchmark-2.2', 'dataset'),
].find((one) => one && fs.existsSync(path.join(one, 'histories', 'M01.jsonl')));

const id = process.argv[2] ?? 'NAT22-M01-D2003';
const read = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const probes = read(path.join(DATA, 'natural', 'natural-probes-dev.jsonl'));
const keys = read(path.join(DATA, 'natural', 'natural-key-dev.jsonl'));
const probe = probes.find((p) => p.id === id);
const key = keys.find((k) => k.id === id);
if (!probe) {
	console.error(`没有这道题：${id}`);
	process.exit(2);
}
const persona = probe.persona;
const history = read(path.join(DATA, 'histories', `${persona}.jsonl`));
const cutoff = probe.cutoff_turn;
const seq = cutoff + (probe.tail?.length ?? 0);

console.log(`${id} ${key.class}/${key.subtype}  persona ${persona}  截止 ${cutoff}  问：${probe.probe.user.replace(/\s+/g, ' ').slice(0, 60)}`);
console.log(`now = ${probe.probe.time}\n`);

const { createLoom } = await import('../loom-e2e/harness.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-diag-due-'));
const dbPath = path.join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } }, settleRounds: 1 });
for (let i = 0; i < cutoff; i += 1) {
	const r = history[i];
	await loom.turn(persona, r['用户消息'], r['助手回复'], { at: Date.parse(r['逻辑时间']) });
}
for (const [n, t] of (probe.tail ?? []).entries()) {
	await loom.turn(persona, t['user'], t['assistant'], { at: Date.parse(t.time) });
}

/* ① 写侧：库里的计划事实，due_from 都解到了哪天 */
const db = new DatabaseSync(dbPath, { readOnly: true });
const local = (ms) => (ms === null || ms === undefined ? '—' : new Date(Number(ms)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).slice(0, 10));
const plans = db.prepare("SELECT id, kind, due_from, text FROM facts WHERE identity_id = ? AND due_from IS NOT NULL ORDER BY due_from DESC LIMIT 12").all(persona);
console.log(`① 事实里带到期日的：${plans.length} 条`);
for (const r of plans) console.log(`   #F${r.id} ${local(r.due_from)}  ${String(r.text).slice(0, 46)}`);

const today = probe.probe.time.slice(0, 10);
const l0 = db.prepare("SELECT id, turn, text FROM l0 WHERE identity_id = ? AND role = 'user' AND (text LIKE '%周%' OR text LIKE '%号%' OR text LIKE '%月%' OR text LIKE '%明天%' OR text LIKE '%后天%') ORDER BY id DESC LIMIT 2000").all(persona);
console.log(`\n① 原话里带日子词的：${l0.length} 条（扫最近 2000）`);

/* ② 闸门 + ③ 端出来 */
const out = String(await loom.call('memory_search', { query: probe.probe.user, limit: 10 }, persona));
console.log(`\n③ memory_search 返回：\n${out.split('\n').map((l) => '   ' + l).join('\n')}`);
const want = key.evidence.match(/第(\d+)轮/g) ?? [];
console.log(`\n   证据轮：${want.join(' ')}`);
console.log(`   返回里出现的到期日（${today}）：${out.includes(today) ? '有' : '没有'}`);

db.close();
loom.dispose();
fs.rmSync(dir, { recursive: true, force: true });
