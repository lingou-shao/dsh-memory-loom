/**
 * probe-budget-degrade —— 配额用尽必须留下痕迹。
 *
 * 这个探针守的是一条**沉默的失败**：`consolidation.dailyLlmCalls` 用完之后，
 * `canUseLlm` 返回 false，抽取退回规则路径。原话仍然入库，只是抽不出压缩后
 * 的事实，于是「它好像不太记得了」要过几天才被察觉，而那时已经无法归因。
 *
 * 断言分三层，缺一层就测不到真实链路：
 *   1. report 里能区分出一共降级了几段、原因是 budget 还是 model；
 *   2. audit 里留下了当天那次的 degraded 与 reasons；
 *   3. 用户真正看得见的地方——memory_doctor——报出了用量。
 *
 * 第 2 层不是多余：doctor 读的就是 audit，只测 doctor 会把「audit 没写」和
 * 「doctor 读错了」混成同一个红。
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createLoomWithTimers, mockLlm, MIN } from './harness.mjs';

const SID = 'budget';
const dbPath = join(tmpdir(), `loom-budget-${Date.now()}.db`);

const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const replyOf = (request) => {
  const text = String(request?.messages?.[0]?.content?.[0]?.text ?? '');
  const line = text.split('\n').find((row) => row.includes('用户：')) ?? text.slice(0, 60);
  return JSON.stringify({
    title: '配额测试',
    summary: '一段用来消耗配额的话。',
    facts: [{ text: '用户在测试配额降级。', kind: 'fact', confidence: 0.8, quote: line.slice(0, 30) }],
    aliases: [],
    emotion: { salience: 0.4, valence: 0, arousal: 0.2 },
    impression: null,
    diary: null,
  });
};

const llm = mockLlm(replyOf);
const { loom, timers } = createLoomWithTimers({
  dbPath,
  llm,
  config: {
    consolidation: { triggerTokens: 0, dailyLlmCalls: 2, enabled: true },
    segmentation: { gapMinutes: 0 },
  },
});

const runMaintenance = async () => {
  for (const timer of timers) await timer.callback();
  await loom.settle(6);
};

// 五段，配额只够两次：后面的必然降级。
for (let i = 1; i <= 5; i++) {
  await loom.turn(SID, `第 ${i} 段：今天把迁移脚本改完了，记录一下第 ${i} 次配额实验。`, '收到。', { gapMs: 30 * MIN });
}
await runMaintenance();

// ── 第 1 层：report 里的原因分类 ──────────────────────────────────────
const db = new DatabaseSync(dbPath, { readOnly: true });
const auditRow = db.prepare("SELECT detail, at FROM audit WHERE action = 'memory.consolidate' ORDER BY at DESC LIMIT 1").get();
let detail = {};
try {
  detail = JSON.parse(String(auditRow?.detail ?? ''));
} catch {
  detail = {};
}

check('audit 记下了 degraded 字段', auditRow !== undefined && 'degraded' in detail, `degraded=${String(detail.degraded)}`);
check('降级原因是 budget 而不是 model', Number(detail.reasons?.budget ?? 0) > 0, `reasons=${JSON.stringify(detail.reasons ?? {})}`);
/*
 * 一段只能算一次。
 *
 * 同一段里抽取和判断会先后降级，按事件计数的版本在这里报出 2，而 doctor 那
 * 一行的单位是「段」——用户看到「配额用尽 4 段」时，实际只有 2 段记忆变弱。
 * 数值系统性偏大比偏小更难发现，因为偏大看起来总是「有在报问题」。
 */
const reasonSum = Object.values(detail.reasons ?? {}).reduce((sum, n) => sum + Number(n ?? 0), 0);
check('降级合计不超过段数', reasonSum <= Number(detail.segments ?? 0), `合计 ${reasonSum} / 段数 ${String(detail.segments)}`);
check('配额确实被消耗到上限', llm.calls.length >= 2, `模型调用 ${llm.calls.length} 次`);

// ── 第 2 层：doctor 报出用量 ──────────────────────────────────────────
const doctor = await loom.call('memory_doctor', {}, SID);
const budgetLine = String(doctor).split('\n').find((line) => line.includes('模型预算')) ?? '';
check('doctor 有「模型预算」这一行', budgetLine !== '', budgetLine.trim());
check('doctor 报出了用尽', budgetLine.includes('用尽'), budgetLine.trim().slice(0, 90));
/* 恢复方式走的是 doctor 末尾的「下一步：」，不在这一行里 */
check('doctor 给出了恢复方式', /明天|dailyLlmCalls/u.test(String(doctor)), '');

// ── 第 3 层：未超配额时不能误报 ───────────────────────────────────────
const db2Path = join(tmpdir(), `loom-budget-ok-${Date.now()}.db`);
const okLoom = createLoomWithTimers({
  dbPath: db2Path,
  llm: mockLlm(replyOf),
  config: { consolidation: { triggerTokens: 0, dailyLlmCalls: 800 }, segmentation: { gapMinutes: 0 } },
});
await okLoom.loom.turn('ok', '今天把迁移脚本改完了。', '收到。', { gapMs: 30 * MIN });
for (const timer of okLoom.timers) await timer.callback();
await okLoom.loom.settle(6);
const okDoctor = await okLoom.loom.call('memory_doctor', {}, 'ok');
const okLine = String(okDoctor).split('\n').find((line) => line.includes('模型预算')) ?? '';
check('配额充足时不报问题', okLine.startsWith('·') && !okLine.includes('用尽'), okLine.trim().slice(0, 60));

db.close();
loom.dispose();
okLoom.loom.dispose();
for (const path of [dbPath, db2Path, `${dbPath}-wal`, `${dbPath}-shm`, `${db2Path}-wal`, `${db2Path}-shm`]) {
  try { rmSync(path, { force: true }); } catch {}
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${failed.length === 0 ? '全部通过' : `${failed.length} 项失败`} · ${results.length} 项`);
if (failed.length > 0) process.exitCode = 1;
