/**
 * Probe: 体检的时区判据看的是「历史行的时区」，不是「当前是不是 UTC」。
 *
 * 0.2.67 给 `memory_doctor` 加时区自检时，判据是
 * `!configured && /^utc$/iu.test(zone)` —— 运行时解析成 UTC 就直接算故障，文案是
 * 「日期判断会整体偏八小时」。这有两处错：
 *
 *   1. **对真的住在 UTC 的人是纯误报。** 伦敦的冬天、雷克雅未克、以及本来就该跑
 *      UTC 的服务器，他们的「今天」就是 UTC 的今天，一个字都没偏。文案在替一个
 *      东八区作者说话。
 *   2. **真正会出错的情形一个字都没查。** 库从东八区搬到 UTC 之后，历史行是按旧
 *      时区解析过的：旧行里「明天」对应的那天，比新会话的「明天」早一天。
 *
 * 它还让 CI 红了两轮（ubuntu runner 就是 UTC），而本地东八区全绿——症状是「本地
 * 全过、CI 全红」，追了两轮才落到这里（§107）。
 *
 * 现在钉四件事：
 *   1. 显式配 UTC 只是提示，不是故障（「UTC 不是罪」）；
 *   2. 未配置、运行时恰好是 UTC 时也只是提示（这一条只在 UTC 机器上真的有断言，
 *      东八区机器上打印 skip——两种机器都要绿，否则又变成「结论随机器变」）；
 *   3. 历史行是东八区、当前新会话按 UTC 渲染 → 报故障，并给出可操作的办法；
 *   4. 仍用那个东八区会话看 → 不报（会话时区是持久化的，旧会话本来就没错）。
 *
 *   node loom-e2e/probe-doctor-tz.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const EAST8 = 'Asia/Shanghai';
let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
};
const line = (report, label) => report.split('\n').find((one) => one.includes(label)) ?? '(没有这一行)';

const root = mkdtempSync(join(tmpdir(), 'loom-doctor-tz-'));
const dbPath = join(root, 'loom.db');

try {
  // ── 1. 显式配置 UTC：是提示，不是故障 ──────────────────────────────
  /**
   * 这一条不依赖机器：config 里写死 UTC，任何时区上跑出来都一样。
   * 「配了 UTC」和「运行时恰好是 UTC」在故障判定上必须同待遇——前者是用户的选择，
   * 后者是环境的事实，两者都不是「日期算错了」的证据。
   */
  let loom = createLoom({ dbPath: join(root, 'utc.db'), config: { timezone: 'UTC' }, settleRounds: 0 });
  await loom.turn('s', '我明天要去医院复查', '记下了。');
  const utcConfigured = String(await loom.call('memory_doctor', {}, 's'));
  check('显式配置 UTC 不判故障', /^· 时区/mu.test(utcConfigured), line(utcConfigured, '时区').trim());
  check('显式配置 UTC 时结论是「未发现故障」', utcConfigured.includes('未发现故障'));
  loom.dispose();

  // ── 2. 未配置 + 运行时是 UTC：同样只是提示 ─────────────────────────
  /**
   * `Intl` 的解析值是本进程启动时定下的，探针改不了。所以这一条：
   *   - 运行时就解析成 UTC（CI / 容器）→ 真的断言；
   *   - 解析成别的（开发机的东八区）→ 打印 skip，不算失败。
   *
   * 写成「按机器分支」而不是「干脆不测」，是因为 CI 那台机器恰好就是会出事的那台：
   * 出问题的那个环境必须在它上面有断言，否则又回到「本地全绿、CI 全红」。
   */
  const runtimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (/utc/iu.test(runtimeZone)) {
    const bare = createLoom({ dbPath: join(root, 'bare.db'), settleRounds: 0 });
    await bare.turn('s', '我明天要去医院复查', '记下了。');
    const report = String(await bare.call('memory_doctor', {}, 's'));
    check('未配置 + 运行时 UTC 不判故障', /^· 时区/mu.test(report), line(report, '时区').trim());
    check('未配置 + 运行时 UTC 时结论是「未发现故障」', report.includes('未发现故障'));
    // 条件式提醒不能丢：人在东八区、容器跑 UTC 是真实且常见的坑。
    check('仍留了条件式提醒', report.includes('如果你其实不在 UTC'));
    bare.dispose();
  } else {
    console.log(`  --   未配置 + 运行时 UTC 这一条跳过（本机解析成 ${runtimeZone}）`);
  }

  // ── 3. 库从东八区搬到 UTC：新会话必须报出来 ────────────────────────
  loom = createLoom({ dbPath, config: { timezone: EAST8, consolidation: { triggerTokens: 0 } }, settleRounds: 0 });
  await loom.turn('old', '我明天要去医院复查', '记下了。');
  await loom.turn('old', '我不吃香菜', '好的。');
  loom.dispose();

  loom = createLoom({ dbPath, config: { timezone: 'UTC' }, settleRounds: 0 });
  const drifted = String(await loom.call('memory_doctor', {}, 'fresh'));
  check('历史行时区与当前不一致时报故障', /^✗ 时区/mu.test(drifted), line(drifted, '时区').trim());
  check('说出库里是哪个时区、多少行', /Asia\/Shanghai\s+\d+\s+行/u.test(drifted));
  check('结论把它算作问题', /结论：发现 \d+ 处问题/u.test(drifted));
  check('下一步给出可操作的办法', drifted.includes('配成与历史行一致的那个'));
  loom.dispose();

  // ── 4. 仍用原来那个会话看：不报（它的时区没变，历史行没错） ─────────
  /**
   * 会话的时区是持久化在 `sessions.timezone` 上的，`timezoneOf` 优先读它。所以
   * 一条从东八区延续下来的会话，在 UTC 机器上继续跑也仍按东八区解析——它没有错，
   * 报它就是误报。这一条挡住「为了抓搬家而把所有旧会话都判死」。
   */
  loom = createLoom({ dbPath, config: { timezone: 'UTC' }, settleRounds: 0 });
  const continued = String(await loom.call('memory_doctor', {}, 'old'));
  check('旧会话自己看时不误报', /^· 时区/mu.test(continued), line(continued, '时区').trim());
  loom.dispose();
} catch (error) {
  failed += 1;
  console.log(`  FAIL 探针自身抛错 — ${String(error?.stack ?? error).split('\n')[0]}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}（${passed} 项断言）`);
  process.exitCode = failed === 0 ? 0 : 1;
}
