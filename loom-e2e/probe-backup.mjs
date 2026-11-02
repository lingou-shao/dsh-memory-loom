/**
 * probe-backup.mjs — 滚动快照探针
 *
 * `loom.db` 是单文件、明文、无副本。README 把备份写成用户责任，而实际上
 * 没人会做。这个探针验证：
 *   1. 有内容时，维护循环会生成快照；
 *   2. 快照是完整可读的库（不是拷了一半的文件）；
 *   3. 超过 `backup.keep` 的旧快照会被删掉；
 *   4. 快照用 `VACUUM INTO` 生成，所以不需要另外拷 `-wal`。
 *
 * 维护循环靠 setInterval 驱动，间隔下限是 10 秒，所以这个探针要等一轮。
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-backup-'));
const dbPath = join(root, 'loom.db');
const backupDir = join(root, 'backups');

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const snapshots = () => {
  try {
    return readdirSync(backupDir).filter((name) => /^loom-\d{4}-\d{2}-\d{2}-\d{4}\.db$/.test(name)).sort();
  } catch {
    return [];
  }
};

// 1. 预置 4 个旧快照：keep 设成 2，跑一轮后只应剩 2 个
mkdirSync(backupDir, { recursive: true });
const old = Date.now() - 30 * 86400000;
for (let index = 0; index < 4; index++) {
  const name = join(backupDir, `loom-2026-09-0${index + 1}-0300.db`);
  writeFileSync(name, '');
  const stamp = (old + index * 86400000) / 1000;
  utimesSync(name, stamp, stamp);
}

const loom = createLoom({
  dbPath,
  config: {
    timezone: 'Asia/Shanghai',
    maintenanceIntervalSeconds: 10,
    backup: { keep: 2, everyHours: 1 },
  },
});

try {
  await loom.call('memory_write', { text: '我不吃香菜，点外卖一定要备注', kind: 'fact' }, 's1');
  await loom.call('memory_write', { text: '我在做一个记忆插件', kind: 'fact' }, 's1');
  await loom.call('memory_write', { text: '我住在杭州', kind: 'fact' }, 's1');
  await loom.turn('s1', '今天把快照功能加上了', '好，库就不会一丢全丢了。', { gapMs: 2 * MIN });

  check('触发前有 4 个预置快照', snapshots().length === 4, `${snapshots().length} 个`);

  // 维护循环 10 秒一轮，等一轮多一点
  await new Promise((resolve) => setTimeout(resolve, 11500));

  const names = snapshots();
  check('维护循环生成了快照', names.length > 0, `${names.length} 个`);
  check('按 keep=2 清理了旧快照', names.length === 2, `剩 ${names.length} 个：${names.join(' ')}`);

  const newest = names.length > 0 ? join(backupDir, names[names.length - 1]) : null;
  if (newest !== null) {
    check('快照文件非空', statSync(newest).size > 0, `${statSync(newest).size} 字节`);

    const copy = new DatabaseSync(newest, { readOnly: true });
    const facts = Number(copy.prepare('SELECT COUNT(*) AS n FROM facts').get().n);
    const turns = Number(copy.prepare('SELECT COUNT(*) AS n FROM l0').get().n);
    const integrity = String(copy.prepare('PRAGMA quick_check').get().quick_check ?? '');
    copy.close();

    check('快照里有 3 条事实', facts === 3, `${facts} 条`);
    check('快照里有对话原文（WAL 内容已并入）', turns >= 2, `${turns} 条`);
    check('快照通过完整性检查', integrity === 'ok', integrity);

    // VACUUM INTO 的产物是自包含的：不应再依赖 -wal
    check('快照没有伴随 -wal 文件', !existsSync(`${newest}-wal`), '');
  }
} finally {
  loom.dispose();
}

let failed = 0;
console.log('=== 滚动快照 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // best effort
}

process.exit(failed === 0 ? 0 : 1);
