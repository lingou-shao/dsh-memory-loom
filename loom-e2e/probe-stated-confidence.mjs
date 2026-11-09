/**
 * probe-stated-confidence.mjs — 原话不该被标成「推断的」
 *
 * v0.2.54 修的是一个两行常数配错的问题：规则路径把 `confidence` 写死成 `.55`，
 * 而「待确认」的线是 `retrieval.unconfirmedBelow`（默认 `.6`）。两条线一夹，
 * 抽出来的**每一条**都低于阈值，于是每一行都带标记。
 *
 * Benchmark 2.1 上量到的后果：注入块的事实行 1009 行里 975 行带「待确认」（96.6%），
 * 而这个标记一条也没筛掉——它只是把用户原话降级成"线索"，成本落在作答上
 * （同一轮判分里 `over_hedged` 命中 33 次）。
 *
 * 这个探针钉住三件事：
 *   1. 规则路径抽出来的事实仍进块（别为了去标记把行弄丢）；
 *   2. 它不带「待确认」；
 *   3. 真正低置信的推断仍然带（别把标记整个废掉）。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-stated-'));
const dbPath = join(root, 'loom.db');

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

/* `triggerTokens: 0` 关掉合并，一轮一提取——探针不等合并周期。 */
const loom = createLoom({ dbPath, config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 0 } } });

try {
  for (const line of ['最近有点累', '我生日是4月17号，阳历的。', '我在街道办上班，合同工那种']) {
    await loom.turn('s1', line, '嗯，我记着。', { gapMs: 2 * MIN });
  }

  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT text, confidence FROM facts ORDER BY id').all();

  /* 一条低置信推断：模拟整合产物，置顶以保证一定渲染。 */
  const identityId = String(db.prepare('SELECT id FROM identities LIMIT 1').get().id);
  const now = Date.now();
  db.prepare(`
    INSERT INTO facts (
      identity_id, text, tokens, tags, kind, source, domain, subdomain, salience, base,
      stability, stability_max, access_count, last_access_at, created_at, updated_at,
      confidence, ttl, status, pinned, from_visitor, isolated, weight, source_ids, evidence
    ) VALUES (?, ?, ?, '', 'fact', 'dialogue', 'life', NULL, 0.5, 0.55,
      30, 1500, 0, ?, ?, ?, 0.35, 'none', 'active', 1, 0, 0, 1, '[]', '{}')
  `).run(identityId, '他好像养了一只叫年糕的猫', '他 好像 养了 一只 叫 年糕 的 猫', now, now, now);
  db.close();

  const block = loom.memoryBlock('s1');
  const lineOf = (needle) => block.split('\n').find((line) => line.includes(needle)) ?? '';

  const birthday = lineOf('生日');
  check('规则路径抽的原话进了记忆块', birthday.length > 0, birthday.slice(0, 50));
  check('规则路径抽的原话不带「待确认」', birthday.length > 0 && !birthday.includes('待确认'), birthday.slice(0, 50));
  check('规则路径的 confidence 高于阈值', rows.every((row) => row.confidence >= 0.6), JSON.stringify(rows.map((row) => row.confidence)));

  const inferred = lineOf('年糕');
  check('低置信推断仍然带「待确认」', inferred.includes('待确认'), inferred.slice(0, 50));
} finally {
  loom.dispose();
  /* 库文件可能还被 sqlite 句柄占着，删不掉不算失败（临时目录会被系统回收）。 */
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
}

for (const [label, ok, detail] of results) console.log(`  ${ok ? '✓' : '✗'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n失败 ${failed} 项（${results.length} 项）`);
process.exitCode = failed === 0 ? 0 : 1;
