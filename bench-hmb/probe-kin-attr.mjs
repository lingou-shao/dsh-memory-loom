/**
 * 槽通道能不能接住「我爸 + 身体/忌口」这一类（§63）。
 *
 * `P01-CASE-006` 的两条计分事实是纯零主语碎片：「腰不好 / 久坐得垫个小枕头」
 * 「还爱听评书 / 手机外放特别大声 / 不吃芹菜」，上一轮是「想起来我爸」。
 * 问句「我爸明天要坐很久……注意什么」和它们**共享 0 个二元组**，任何词面通道
 * 都摸不到；但槽通道（`slotFacts`）不设覆盖率闸门，只要坐标写得进去就能取回。
 *
 * 这个探针只回答两件事：
 *   ① 这两句到底有没有进 facts 表（有行才谈得上挂坐标）；
 *   ② 现在的 `slotFacts` 对这句问句返回什么。
 *
 *   node bench-hmb/probe-kin-attr.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

const persona = 'P01';
const cutoff = 202;
const question = '我爸明天要坐很久，我想给他准备吃的和路上用的东西，你帮我想想要注意什么？';
const turns = jsonl(path.join(DS, 'histories', `${persona}.jsonl`));

const realNow = Date.now;
let clock = Date.parse(turns[0]['逻辑时间']);
Date.now = () => clock;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinslot-'));
const dbPath = path.join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const SID = 'x';
for (const turn of turns) {
  if (turn['轮次'] > cutoff) break;
  clock = Date.parse(turn['逻辑时间']);
  await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at: clock });
}
Date.now = realNow;

const db = new DatabaseSync(dbPath);
const facts = db.prepare('SELECT id, kind, text, aliases, subject, attr, value FROM facts').all();
console.log(`facts 共 ${facts.length} 行。含这几个词的：`);
for (const needle of ['腰', '久坐', '芹菜', '评书', '枕头', '我爸']) {
  const hit = facts.filter((row) => String(row.text).includes(needle) || String(row.aliases).includes(needle));
  console.log(`  ${needle.padEnd(3)} ${hit.length} 行  ${hit.slice(0, 3).map((r) => `「${String(r.text).slice(0, 30)}」`).join(' ')}`);
}
const slots = facts.filter((row) => row.subject !== '');
console.log(`\n带坐标的行 ${slots.length} 条：`);
for (const row of slots.slice(0, 12)) console.log(`  ${row.subject} · ${row.attr} = ${row.value}   「${String(row.text).slice(0, 34)}」`);

const ctx = { identityId: loom.identityId ?? undefined };
let chain = [];
try {
  chain = loom.store?.slotFacts
    ? loom.store.slotFacts(ctx.identityId ?? 'default', question, 10)
    : [];
} catch (error) {
  console.log(`slotFacts 调用失败：${String(error?.message ?? error)}`);
}
console.log(`\nslotFacts(问句) 返回 ${chain.length} 条`);
for (const row of chain.slice(0, 6)) console.log(`  [${row.subject} · ${row.attr}] ${String(row.text).slice(0, 40)}`);

const search = String(await loom.call('memory_search', { query: question, limit: 10 }, SID));
console.log(`\nmemory_search 返回：\n${search.slice(0, 600)}`);
db.close();
