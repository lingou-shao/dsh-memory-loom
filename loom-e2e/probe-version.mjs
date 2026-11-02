/**
 * Probe: 插件能不能自己说清「现在真正跑起来的是哪一版」。
 *
 * 为什么需要这一项：DSH 的即时重组只在「bundle 第一次出现在列表里」时触发。
 * 同一个 bundle 原地升级（`dsh plugin update` / 改 profile 再 pnpm install）之后，
 * 磁盘上的包换了、进程里跑的还是启动那一刻的代码——工具少几个、库 schema 没升、
 * 新工具报 unknown，而 `git status`、文件时间、版本号看上去全都是新的。
 *
 * 2026-11-02 真机上踩过一次：装到 0.2.23，实际跑的是 0.2.12，靠「工具数 9 个」才认出来。
 * 当时没有任何一个地方能直接回答「你跑的是哪版」，只能靠数工具反向推断。
 *
 * 现在 `memory_doctor` 第一行就报：运行版本、库 schema 版本、以及库上次被哪一版打开过。
 * 这个探针盯三件事：
 *   1. 医生第一行同时给出运行版本与库 schema，且运行版本等于 package.json 的版本
 *   2. `runtime.version` 真的落进了 meta 表（不是只在内存里算了一次）
 *   3. 换版本第一次启动时，旧值被挪进 `runtime.previousVersion` 并在医生里说出来
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(readFileSync(join(HERE, '..', 'package.json'), 'utf8')).version;
const SESSION = 'probe-version';
const root = mkdtempSync(join(tmpdir(), 'loom-version-'));
const dbPath = join(mkdtempSync(join(root, 'v-')), 'loom.db');

let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/** 直接读一个 meta 值（调用前必须先 dispose，Windows 上文件是独占锁的）。 */
function metaOf(key) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  } finally {
    db.close();
  }
}

try {
  // ── 1. 全新库：医生第一行自报版本 ────────────────────────────────────
  const first = createLoom({ dbPath });
  const report = String(await first.call('memory_doctor', {}, SESSION));
  const head = report.split('\n')[0] ?? '';
  check('医生第一行是版本行', head.includes('版本'), head);
  check('报出的是运行时版本（等于 package.json）', head.includes(`运行 ${PKG_VERSION}`), head);
  check('报出库 schema 版本', /库 schema v\d+/u.test(head), head);
  check('新库不该有「上次由」', !head.includes('库上次由'), head);
  const names = first.toolNames();
  check('关键工具都在（按名字查，不数个数）',
    ['memory_doctor', 'memory_resolve', 'memory_settle', 'memory_search'].every((n) => names.includes(n)),
    `${names.length} 个`);
  first.dispose();

  // ── 2. 版本真的落进了库，不是只算了一次 ─────────────────────────────
  check('meta 里记下了 runtime.version', metaOf('runtime.version') === PKG_VERSION, String(metaOf('runtime.version')));
  check('新库没有 previousVersion', metaOf('runtime.previousVersion') === undefined);

  // ── 3. 模拟「升级」：把库里的版本改成旧值，再启动一次 ────────────────
  const db = new DatabaseSync(dbPath);
  db.prepare("UPDATE meta SET value = '0.2.12' WHERE key = 'runtime.version'").run();
  db.close();

  const second = createLoom({ dbPath });
  const upgraded = String(await second.call('memory_doctor', {}, SESSION));
  const head2 = upgraded.split('\n')[0] ?? '';
  check('升级后医生说「库上次由 0.2.12 打开」', head2.includes('库上次由 0.2.12 打开'), head2);
  check('升级后运行版本仍是当前版本', head2.includes(`运行 ${PKG_VERSION}`), head2);
  second.dispose();

  check('runtime.version 已被更新回当前', metaOf('runtime.version') === PKG_VERSION);
  check('旧值被保留在 runtime.previousVersion', metaOf('runtime.previousVersion') === '0.2.12');

  // ── 4. 同版本再启动一次：不该反复改写 previousVersion ─────────────────
  const third = createLoom({ dbPath });
  third.call('memory_doctor', {}, SESSION);
  third.dispose();
  check('同版本重启不覆盖 previousVersion', metaOf('runtime.previousVersion') === '0.2.12');
} catch (error) {
  fail++;
  console.log(`  FAIL 探针自身抛错 — ${String(error?.stack ?? error).split('\n')[0]}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 项断言）`);
  process.exitCode = fail === 0 ? 0 : 1;
}
