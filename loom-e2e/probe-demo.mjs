/**
 * 承诺是延迟兑现的 —— 这一版把「什么时候兑现」提到了当下。
 *
 * 装上它的头两周里，旗舰功能一次都不会触发：说要做的事还没到日子，记忆块
 * 除了记下这句话什么都不做。用户的合理结论是「它只是记了几句话」，而那是
 * 所有记忆插件都会做的事。所以两处把日子说出来：
 *
 *   1. 记忆块里还没到期的计划行，补一句「到期后我会问一句」
 *   2. `memory_doctor` 报一行「下一步」：最近一条没结果的计划哪天到期、之后
 *      第一次对话就会问、没回答多久再问一次
 *
 * 外加 `memory_demo`：在一个内存库里把整圈跑一遍给人看。这里要盯住的是它
 * **不许**碰真实库 —— 一个会写用户记忆的演示，比没有演示更糟。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-demo-session';
const root = mkdtempSync(join(tmpdir(), 'loom-demo-probe-'));

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

/** 读真实库的计数，用独立连接（WAL 下多读一没问题）。 */
function counts(dbPath) {
  const db = new DatabaseSync(dbPath);
  const one = (sql) => Number(db.prepare(sql).get().n ?? 0);
  const result = {
    facts: one('SELECT COUNT(*) AS n FROM facts'),
    plans: one("SELECT COUNT(*) AS n FROM facts WHERE kind = 'plan'"),
  };
  db.close();
  return result;
}

/** 去掉时间戳与自增号，用来比较两次演示的输出是否同构。 */
const normalise = (text) => text.replace(/\d{4}-\d\d-\d\d \d\d:\d\d/g, '<ts>').replace(/#\d+/g, '#n');

try {
  console.log('\n[1] 演示：三幕都在，说的和真跑的一样');
  {
    const { loom, dbPath } = boot('once');
    const before = counts(dbPath);
    const out = String(await loom.call('memory_demo', {}, SESSION));

    check('memory_demo 挂上了', loom.toolNames().includes('memory_demo'));
    check('演示说清了自己用的是内存库', /内存库/.test(out), out.split('\n')[0].slice(0, 30));
    check('第一幕：记成计划并给出期限', /记成计划 #\d+，期限 \d{4}-\d\d-\d\d/.test(out));
    check(
      '没到期的那行写着「到期后我会问一句」',
      /· 截止\][^\n]*（到期后我会问一句）/u.test(out),
      out.split('\n').find((row) => row.includes('· 截止]')) ?? '(没有这一行)',
    );
    check(
      '已到期的那行不再重复这句话',
      !/· 已到期[^\n]*（到期后我会问一句）/u.test(out),
      '同一句话在到期前后各写一次会读成两件事',
    );
    check('第二幕：到期那行在催问「后来成了吗」', /· 已到期[^\n]*后来成了吗/u.test(out));
    check('第三幕：答了之后写出一条「已办成」的新事实', /已办成（\d\d-\d\d 确认）/.test(out));
    check('演示收尾说明「真实使用要真的等」', /真的要等|才会开口/.test(out));

    const after = counts(dbPath);
    check('演示没往真实库写任何事实', after.facts === before.facts, `${before.facts} → ${after.facts}`);
    check('演示没往真实库写计划', after.plans === before.plans && after.plans === 0, `${after.plans} 条`);
    loom.dispose();
  }

  console.log('\n[2] 连跑两次：每次从空库开始，不累积');
  {
    const { loom } = boot('twice');
    const first = String(await loom.call('memory_demo', {}, SESSION));
    const second = String(await loom.call('memory_demo', {}, SESSION));
    check(
      '两次输出同构',
      normalise(first) === normalise(second),
      normalise(first) === normalise(second) ? '' : '说明演示库没有隔离，第二次带上了第一次的痕迹',
    );
    check('两次都从 #1 开始编号', /计划 #1/.test(second), '共享一个库时这里会变成 #3');
    loom.dispose();
  }

  console.log('\n[3] 医生报告：下一步哪天动');
  {
    const { loom, dbPath } = boot('doctor');
    const empty = String(await loom.call('memory_doctor', {}, SESSION));
    check('没有计划时不报「下一步」', !empty.includes('· 下一步'), '空报告不该多一行噪音');

    await loom.call('memory_write', { text: '下周五去体检', kind: 'plan' }, SESSION);
    const doc = String(await loom.call('memory_doctor', {}, SESSION));
    const line = doc.split('\n').find((row) => row.startsWith('· 下一步')) ?? '';
    check('有计划时报出「下一步」', line.length > 0);
    check('这一行带确切日期', /\d{4}-\d\d-\d\d \d\d:\d\d 到期/.test(line), line);
    check('这一行说清「之后第一次对话就会问」', /之后第一次对话就会问/.test(line), line);
    check('这一行带上被问的那条计划', line.includes('下周五去体检'), line);
    check('「下一步」只报一行', (doc.match(/· 下一步/g) ?? []).length === 1);

    const db = new DatabaseSync(dbPath);
    const id = Number(db.prepare("SELECT id FROM facts WHERE kind = 'plan' ORDER BY id LIMIT 1").get().id);
    db.close();
    await loom.call('memory_resolve', { id, done: true }, SESSION);
    const settled = String(await loom.call('memory_doctor', {}, SESSION));
    check('收尾之后不再报「下一步」', !settled.includes('· 下一步'), '已经办成的没什么要等');
    check('收尾被记进计划那行', /条已有结果/.test(settled), settled.split('\n').find((row) => row.includes('计划与矛盾')) ?? '');
    loom.dispose();
  }

  console.log('\n[4] 再问间隔跟着配置走，不写死在文案里');
  {
    const { loom } = boot('gap', { retrieval: { planNudgeDays: 0 } });
    await loom.call('memory_write', { text: '下周五去体检', kind: 'plan' }, SESSION);
    const line = String(await loom.call('memory_doctor', {}, SESSION))
      .split('\n')
      .find((row) => row.startsWith('· 下一步')) ?? '';
    check('planNudgeDays=0 时不提「每 N 天再问」', !/每 \d+ 天再问一次/.test(line), line);
    loom.dispose();
  }

  console.log('\n[5] 没日期的计划不承诺日期');
  {
    const { loom } = boot('nodate');
    await loom.call('memory_write', { text: '打算换工作', kind: 'plan' }, SESSION);
    const block = String(loom.memoryBlock(SESSION));
    const line = block.split('\n').find((row) => row.includes('换工作')) ?? '';
    check('没解析出日期的计划渲染成「未定期限」', line.includes('未定期限'), line);
    check(
      '这一行不写「到期后我会问一句」',
      !line.includes('到期后我会问一句'),
      '没有日子的承诺，写一句「到期后」就是在骗人',
    );
    loom.dispose();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
