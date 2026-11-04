/**
 * 规则路径的抽取覆盖面（不调模型）。
 *
 * 守的是一条容易长期无人发现的性质：没有模型或配额用尽时，抽取退回规则，
 * 而规则只认识「人的经历」，不认识「对象的属性」。表现是整份语料一条事实
 * 都抽不出来，但所有指标都是绿的——原文在、检索能跑、只是问起来问不到。
 *
 * 这里量三件事：抽了多少、中多少（是否落在带槽位的那句上）、误伤多少
 * （把纯口语也当成事实）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const corpus = JSON.parse(readFileSync(join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));

const dbPath = join(tmpdir(), `loom-rules-${Date.now()}.db`);
const loom = createLoom({
  dbPath,
  config: {
    consolidation: { triggerTokens: 0, dailyLlmCalls: 0 },
    segmentation: { gapMinutes: 0 },
  },
});
for (const [i, seg] of corpus.entries()) {
  await loom.turn(`r${i}`, seg.text, '收到。', { gapMs: 30 * 60000 });
  await new Promise((r) => setTimeout(r, 4));
}
await loom.settle(8);
loom.dispose();

const db = new DatabaseSync(dbPath, { readOnly: true });
const facts = db.prepare("SELECT text FROM facts WHERE status IN ('active','disputed') ORDER BY id").all().map((row) => String(row.text));
db.close();

const slotLike = facts.filter((text) => /(?:调整为|首次确立为|改成了|设置为|设成|换成了)/u.test(text));
const filler = facts.filter((text) => !/[A-Za-z0-9]/u.test(text) && !/(?:调整为|首次确立为|改成了|设置为|设成|换成了)/u.test(text));

console.log(`语料 ${corpus.length} 段，抽出事实 ${facts.length} 条`);
console.log(`  落在带槽位句上 ${slotLike.length} 条（${((slotLike.length / Math.max(1, facts.length)) * 100).toFixed(0)}%）`);
console.log(`  不含具体值也不含槽位特征 ${filler.length} 条（${((filler.length / Math.max(1, facts.length)) * 100).toFixed(0)}%）`);
console.log(`  平均每段 ${(facts.length / corpus.length).toFixed(2)} 条`);
console.log('\n样例（前 6 条）：');
for (const text of facts.slice(0, 6)) console.log(`  · ${text.slice(0, 70)}`);
console.log('\n非槽位样例（前 4 条）：');
for (const text of filler.slice(0, 4)) console.log(`  · ${text.slice(0, 70)}`);
