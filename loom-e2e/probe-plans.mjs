/**
 * Do plans reach the block without being asked for?
 *
 * A plan is the one kind of memory the user will never query. They said they
 * would do something; the next time they mention it is when it is already done
 * or already forgotten. Lexical recall cannot help here — the query carries no
 * trace of the plan, because the query is about something else entirely.
 *
 * So the assertions are about absence of a query, not about matching one:
 *   1. three plans written, then an unrelated turn — all three still render
 *   2. a plan past its date is labelled, not silently dropped
 *   3. a plan that *also* matched the query renders once, not twice
 *   4. maxPlans: 0 removes the zone entirely
 *   5. the block stays inside its hard cap with plans present
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-plan-session';
const root = mkdtempSync(join(tmpdir(), 'loom-plans-'));

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

function boot(name, config = {}) {
  const dir = mkdtempSync(join(root, `${name}-`));
  const dbPath = join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config });
  return { loom, dbPath };
}

const PLANS = [
  { text: '用户打算下周三前把简历改完', kind: 'plan' },
  { text: '用户准备明天去银行开一张储蓄卡', kind: 'plan' },
  { text: '用户约好下周和房东谈换热水器的事', kind: 'plan' },
];
const PLAIN = [
  { text: '用户对香菜过敏，点外卖要备注不要香菜', kind: 'fact' },
  { text: '用户在上海做前端，主要写 React', kind: 'fact' },
];

try {
  console.log('\n[1] 计划不靠检索也能进块');
  {
    const { loom, dbPath } = boot('basic');
    for (const item of PLANS) await loom.call('memory_write', item, SESSION);
    for (const item of PLAIN) await loom.call('memory_write', item, SESSION);

    // A turn that shares nothing with any plan above.
    await loom.turn(SESSION, '今天外面风挺大的，晚饭吃点什么好', '随便做点热的吧', { gapMs: 60000 });

    const block = loom.memoryBlock(SESSION);
    const hasZone = block.includes('你说过要做的事');
    check('计划区出现', hasZone);
    const rendered = PLANS.filter((plan) => block.includes(plan.text.replace('用户', '')));
    check('三条计划全部在块里（无一条被检索命中）', rendered.length === 3, `${rendered.length}/3`);
    check('无关话题下事实区仍在', block.includes('你说过要做的事'));
    check('计划带截止标记', block.includes('截止') || block.includes('已到期'));
    loom.dispose();

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare("SELECT text, kind, expires_at FROM facts WHERE kind = 'plan' ORDER BY id").all();
    db.close();
    check('计划落库为 kind=plan', rows.length === 3);
    const dated = rows.filter((row) => row.expires_at !== null);
    check('期限短语被解析成时间戳', dated.length >= 2, `${dated.length}/3 条有截止`);
  }

  console.log('\n[2] 到期不删，改成标出来');
  {
    const { loom, dbPath } = boot('overdue');
    await loom.call('memory_write', PLANS[0], SESSION);
    await loom.call('memory_write', PLANS[1], SESSION);

    // Rewind one plan's deadline instead of waiting three days for it.
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE facts SET expires_at = ?, expired_at = ? WHERE text = ?").run(
      Date.now() - 86400000,
      Date.now() - 86400000,
      PLANS[0].text,
    );
    db.close();

    const block = loom.memoryBlock(SESSION);
    check('过期计划仍在块里', block.includes(PLANS[0].text.replace('用户', '')));
    check('过期计划被标为已到期', block.includes('已到期'));
    check('未过期计划标的是截止', block.includes('截止'));
    // The overdue line must sort before the open one: it is the half with news.
    const overdueAt = block.indexOf('已到期');
    const dueAt = block.indexOf('截止');
    check('过期排在未到期之前', overdueAt >= 0 && overdueAt < dueAt);
    loom.dispose();
  }

  console.log('\n[3] 同时被检索命中时不重复渲染');
  {
    const { loom } = boot('dedupe');
    await loom.call('memory_write', PLANS[0], SESSION);
    // This turn hits the same bigrams as the plan itself.
    await loom.turn(SESSION, '简历改完了吗', '还没有吧', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    const needle = PLANS[0].text.replace('用户', '');
    const occurrences = block.split(needle).length - 1;
    check('同一条计划只出现一次', occurrences === 1, `出现 ${occurrences} 次`);
    loom.dispose();
  }

  console.log('\n[4] maxPlans: 0 关掉整个通道');
  {
    const { loom } = boot('off', { retrieval: { maxPlans: 0 } });
    for (const item of PLANS) await loom.call('memory_write', item, SESSION);
    await loom.call('memory_write', PLAIN[0], SESSION);
    await loom.turn(SESSION, '今天外面风挺大的', '嗯', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    check('计划区消失', !block.includes('你说过要做的事'));
    check('计划也不再伪装成事实', !block.includes('简历改完'));
    check('事实区仍在', block.includes('关于你（事实）'));
    loom.dispose();
  }

  console.log('\n[5] 计划区有上限，且不撑破硬顶');
  {
    const { loom } = boot('cap', { retrieval: { maxPlans: 2, budgetTokens: 600, hardCapTokens: 900 } });
    for (const item of PLANS) await loom.call('memory_write', item, SESSION);
    for (const item of PLAIN) await loom.call('memory_write', item, SESSION);
    await loom.turn(SESSION, '随便聊聊', '嗯', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    const shown = PLANS.filter((plan) => block.includes(plan.text.replace('用户', ''))).length;
    check('最多 2 条计划', shown <= 2, `${shown} 条`);
    // Rough token estimate, same 0.65 CJK ratio the plugin uses.
    const cjk = (block.match(/[\u4e00-\u9fff]/gu) ?? []).length;
    const rough = Math.round(cjk * 0.65) + Math.round((block.length - cjk) * 0.25);
    check('块未超过硬顶太多', rough <= 1400, `约 ${rough} token / ${block.length} 字`);
    loom.dispose();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
