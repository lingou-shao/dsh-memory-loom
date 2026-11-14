/**
 * Probe: 口径变更后留下的存量行，必须被体检看见。
 *
 * 为什么需要这一项：v0.2.22 把期限收窄到 `kind=plan`（design §24.1），判据只加在
 * 写入口，已有行原样留着 `expires_at`。这类行有三处都看不见：
 *   - 渲染层照样印「(期限 10-31)」，模型读到一条会过期的事实；
 *   - `memory_doctor` 的时间统计只数计划，所以体检不报；
 *   - 它不在计划区，`overduePlans` 不会来问。
 * 而维护对 any TTL'd fact 生效：到期会打 `expired_at`，`expiryFactor` 随后按半衰期
 * 减它的分。于是一条「邵是……作者」会以 45 天半衰期慢慢烂掉，界面上只有一行日期。
 *
 * 这个探针盯三件事：
 *   1. 干净库不误报（新写的事实永远没有窗口）
 *   2. 存在存量行时，医生把它算成问题，并说出清理哪几个字段
 *   3. 清掉之后恢复「未发现故障」——不能一旦报过就永远报
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-stray-due';
/**
 * 时区必须显式钉住：**它能把结论改掉**。
 *
 * 2026-11-14 这一条让 CI 连红两轮（两个 node 版本一起挂），而本地全绿——因为
 * `memory_doctor` 当时有一条自检把「运行时解析成 UTC」判成故障（「日期判断会整体
 * 偏八小时」），于是同一个干净库：
 *
 *    EAST8 机器 → `结论：未发现故障` → 断言绿
 *    UTC 机器（容器/CI 默认） → `结论：发现 1 处问题` → 断言红
 *
 * 那条判据在 0.2.75 改对了（见 `probe-doctor-tz.mjs`：现在比的是「历史行的时区与
 * 当前是否一致」，UTC 本身不再算故障）。但这条探针**仍然钉住时区**，理由是它要验
 * 的主题是「存量行会被体检看见」，与时区无关，结论就不该随机器变——钉住输入比
 * 依赖「上游恰好不再用那个量」可靠。
 */
const TZ = 'Asia/Shanghai';
const root = mkdtempSync(join(tmpdir(), 'loom-stray-'));
const dbPath = join(root, 'loom.db');

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

try {
  // ── 1. 干净库：写一条普通事实，医生不该报 ────────────────────────────
  const first = createLoom({ dbPath, config: { timezone: TZ } });
  await first.call('memory_write', { text: '用户在写一个记忆插件', kind: 'fact' }, SESSION);
  // 第二条用来覆盖 superseded：被取代的行照样会被 factLine 渲染，检测不能只看 active。
  await first.call('memory_write', { text: '用户上次用的是另一个存储引擎', kind: 'fact' }, SESSION);
  const clean = String(await first.call('memory_doctor', {}, SESSION));
  check('干净库不报「非计划记忆仍带期限」', !clean.includes('非计划记忆仍带期限'));
  check('干净库结论是「未发现故障」', clean.includes('未发现故障'));
  first.dispose();

  // ── 2. 制造两种存量行，覆盖三个字段和两种状态 ────────────────────────
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT id FROM facts WHERE kind = 'fact' ORDER BY id").all();
  check('库里有两条可被污染的事实', rows.length === 2, `${rows.length} 条`);
  const past = Date.now() - 5 * 864e5;
  // 第一条：窗口 + 过期戳，就是真实库里那行的形状（维护按 TTL 打的戳）。
  db.prepare("UPDATE facts SET ttl = 'absolute', expires_at = ?, expired_at = ? WHERE id = ?")
    .run(past, past + 864e5, rows[0].id);
  // 第二条：只剩窗口起点，而且已被取代——检测不能依赖 status，也不能只看 expires_at。
  db.prepare("UPDATE facts SET status = 'superseded', ttl = 'absolute', due_from = ? WHERE id = ?")
    .run(past, rows[1].id);
  db.close();

  // ── 3. 医生必须把它算成问题，并说出清哪几个字段 ──────────────────────
  const second = createLoom({ dbPath, config: { timezone: TZ } });
  const dirty = String(await second.call('memory_doctor', {}, SESSION));
  check('报出「2 条非计划记忆仍带期限」', dirty.includes('2 条非计划记忆仍带期限'), dirty.split('\n').find((l) => l.includes('非计划')) ?? '(没有这一行)');
  check('结论把它算作问题', /结论：发现 \d+ 处问题/u.test(dirty));
  check('提示里给出清理字段', dirty.includes('expires_at') && dirty.includes('ttl = \'none\''));
  // 新库没有计划，所以这句话该是「还没有带期限的计划」——不是「记忆」。
  check('计划统计文案不再冒充全部', dirty.includes('还没有带期限的计划') && !dirty.includes('还没有带期限的记忆'));
  second.dispose();

  // ── 4. 清掉之后必须恢复，否则一次报过就永远报 ────────────────────────
  const db2 = new DatabaseSync(dbPath);
  db2.prepare("UPDATE facts SET expires_at = NULL, due_from = NULL, expired_at = NULL, ttl = 'none' WHERE kind <> 'plan'").run();
  db2.close();

  const third = createLoom({ dbPath, config: { timezone: TZ } });
  const healed = String(await third.call('memory_doctor', {}, SESSION));
  check('清理后不再报', !healed.includes('非计划记忆仍带期限'));
  check('清理后结论回到「未发现故障」', healed.includes('未发现故障'));
  third.dispose();
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
