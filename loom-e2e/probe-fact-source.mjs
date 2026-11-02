/**
 * probe-fact-source.mjs — 事实溯源标注探针
 *
 * `facts` 表一直有 `source` 与 `confidence`，但渲染时只用到了 pinned /
 * possiblyStale / 日期 / 类型。结果所有事实看起来一样权威：用户亲口立下的
 * 规矩，和整合时从对话里推断出来的一句话，渲染出来完全同形。
 *
 * 这个探针验证 v0.2.15 的规则：
 *   - `source = manual`（用户通过 memory_write 亲手写的）不标注；
 *   - `source = dialogue` 且 confidence < 0.6 标「待确认」；
 *   - 置信度够高的推断不标，避免噪音。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-source-'));
const dbPath = join(root, 'loom.db');

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const loom = createLoom({ dbPath, config: { timezone: 'Asia/Shanghai' } });

try {
  // 用户亲手写的：不该被标注
  await loom.call('memory_write', {
    text: '我不吃香菜，点外卖一定要备注',
    kind: 'fact',
    pinned: true,
  }, 's1');

  await loom.turn('s1', '最近有点累', '那就早点睡。', { gapMs: 2 * MIN });

  // 模拟整合产物：一条低置信推断、一条高置信推断，都置顶以保证一定渲染出来
  const db = new DatabaseSync(dbPath);
  const identityId = String(db.prepare('SELECT id FROM identities LIMIT 1').get().id);
  const now = Date.now();
  const insert = db.prepare(`
    INSERT INTO facts (
      identity_id, text, tokens, tags, kind, source, domain, subdomain, salience, base,
      stability, stability_max, access_count, last_access_at, created_at, updated_at,
      confidence, ttl, status, pinned, from_visitor, isolated, weight, source_ids, evidence
    ) VALUES (?, ?, ?, '', 'fact', 'dialogue', 'life', NULL, 0.5, 0.55,
      30, 1500, 0, ?, ?, ?, ?, 'none', 'active', 1, 0, 0, 1, '[]', '{}')
  `);
  insert.run(identityId, '他好像养了一只叫年糕的猫', '他 好像 养了 一只 叫 年糕 的 猫', now, now, now, 0.35);
  insert.run(identityId, '他在杭州做后端开发', '他 在 杭州 做 后端 开发', now + 1, now + 1, now + 1, 0.8);
  db.close();

  await loom.turn('s1', '帮我看看这段代码', '发过来。', { gapMs: 2 * MIN });

  const block = loom.memoryBlock('s1');

  const lineOf = (needle) => block.split('\n').find((line) => line.includes(needle)) ?? '';

  const manual = lineOf('香菜');
  const lowConfidence = lineOf('年糕');
  const highConfidence = lineOf('杭州');

  check('手动写入的事实出现在记忆块', manual.length > 0, manual.slice(0, 40));
  check('手动写入的不带「待确认」', manual.length > 0 && !manual.includes('待确认'), manual);
  check('低置信推断出现在记忆块', lowConfidence.length > 0, lowConfidence.slice(0, 40));
  check('低置信推断带「待确认」', lowConfidence.includes('待确认'), lowConfidence);
  check('高置信推断不带「待确认」', highConfidence.length > 0 && !highConfidence.includes('待确认'), highConfidence);

  // 协议块必须解释这个标记，否则模型不知道它是什么意思
  const protocol = loom.protocol();
  check('协议解释了「待确认」', protocol.includes('待确认'), protocol.includes('待确认') ? '' : '模型会误解这个标记');
} finally {
  loom.dispose();
}

let failed = 0;
console.log('=== 事实溯源标注 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && !ok ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // best effort
}

process.exit(failed === 0 ? 0 : 1);
