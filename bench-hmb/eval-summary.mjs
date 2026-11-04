/**
 * 摘要选句的效果对比（只跑规则路径，不调模型）。
 *
 * 语料是 hive-memory-bench 的 chain 段：270 条互不相关的技术记录，每条里
 * 都有一句带「主体 + 属性 + 值」的槽位句，其余多是填充。评测要问的就是
 * 那个值，所以「摘要里有没有槽位句」直接决定了这条记录能不能被搜到。
 *
 * 对照用旧规则（首句 + 最长句）离线重算，和新代码产出的 event.summary 比。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const corpus = JSON.parse(readFileSync(join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));

const dbPath = join(tmpdir(), `loom-summary-${Date.now()}.db`);
const loom = createLoom({
  dbPath,
  config: {
    consolidation: { triggerTokens: 0, dailyLlmCalls: 0 },
    segmentation: { gapMinutes: 0 },
  },
});

for (const [i, seg] of corpus.entries()) {
  await loom.turn(`s${i}`, seg.text, '收到。', { gapMs: 30 * 60000 });
  await new Promise((r) => setTimeout(r, 4));
}
await loom.settle(8);
loom.dispose();

const db = new DatabaseSync(dbPath, { readOnly: true });
const rows = db.prepare('SELECT summary FROM events ORDER BY id ASC').all();
db.close();

// ── 旧规则重算：首句 + 最长句 ────────────────────────────────────────────
const OPENERS = /^(?:那么|但是|不过|所以|然后|对了|其实|也就是说|嗯|啊|诶|哎|哦)+[，,、。\s]*/u;
const splitSentences = (text) => [
  ...new Set(
    text
      .split(/(?<=[。！？!?；;])\s*/u)
      .map((part) => part.trim().replace(OPENERS, ''))
      .filter((part) => part.length >= 4),
  ),
];
const clipTo = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const oldSummary = (text) => {
  const parts = splitSentences(text);
  if (parts.length === 0) return clipTo(text.trim(), 200);
  const first = parts[0];
  let longest = first;
  for (const part of parts) if (part.length > longest.length) longest = part;
  return longest === first ? clipTo(first, 200) : clipTo(`${first} ${longest}`, 200);
};

// 槽位句：带「主体 的 属性 调整为/首次确立为 值」的那一句。
const slotSentence = (text) => {
  const parts = text.split(/(?<=[。！？!?；;])\s*/u);
  return parts.find((part) => /(?:调整为|首次确立为|改成了|设置为)/u.test(part)) ?? null;
};

const probeOf = (summary, slot) => {
  if (slot === null) return null;
  /*
   * 用「调整为 X」里的 X 当锚点，不用整句：句首的「不过」「那么」会被插件
   * 的 stripOpener 剥掉，按整句开头比对会把命中误判成未命中。
   */
  const m = /(?:调整为|首次确立为|改成了|设置为)\s*([^\s，。！？；]{2,})/u.exec(slot);
  const key = m === null ? slot.trim().slice(0, 10) : m[1];
  return summary.replace(/\s+/gu, '').includes(key.replace(/\s+/gu, ''));
};

const score = { new: 0, old: 0, total: 0, newLen: 0, oldLen: 0, grew: 0, shrank: 0 };
for (const [i, seg] of corpus.entries()) {
  const slot = slotSentence(seg.text);
  if (slot === null) continue;
  const fresh = String(rows[i]?.summary ?? '');
  const old = oldSummary(seg.text);
  const hitNew = probeOf(fresh, slot);
  const hitOld = probeOf(old, slot);
  if (hitNew === null || hitOld === null) continue;
  score.total += 1;
  if (hitNew) score.new += 1;
  if (hitOld) score.old += 1;
  score.newLen += fresh.length;
  score.oldLen += old.length;
  if (hitNew && !hitOld) score.grew += 1;
  if (!hitNew && hitOld) score.shrank += 1;
}

const pct = (n) => `${((n / score.total) * 100).toFixed(1)}%`;
console.log(`样本 ${score.total} 段（含槽位句的记录）`);
console.log(`  旧规则（首句+最长句）  槽位句进摘要 ${score.old} 段  ${pct(score.old)}  平均 ${(score.oldLen / score.total).toFixed(0)} 字`);
console.log(`  新规则（具体值优先） 槽位句进摘要 ${score.new} 段  ${pct(score.new)}  平均 ${(score.newLen / score.total).toFixed(0)} 字`);
console.log(`  变好 ${score.grew} 段 · 变差 ${score.shrank} 段`);
