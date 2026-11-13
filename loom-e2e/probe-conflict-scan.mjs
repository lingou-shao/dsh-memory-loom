/**
 * Does the store notice when two of its own facts contradict each other?
 *
 * Consolidation asks the model to judge `contradicts`, and that is the only path
 * that can catch a rewording. Its failure mode is silent: when the model does
 * not notice, both rows stay `active`, and the memory block presents two
 * contradicting sentences with equal authority. Nothing anywhere says they
 * disagree.
 *
 * This probe covers the mechanical half of the backstop — the half that can be
 * decided without a model: same vocabulary, different number or different
 * negation. It also pins the part that is easy to get wrong in the other
 * direction: unrelated facts must not be flagged, or the block gradually marks
 * everything as suspect and the label stops meaning anything.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-conflict-session';
const root = mkdtempSync(join(tmpdir(), 'loom-conflict-'));

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

const PAIRS = [
  { old: '用户有 3 个孩子，老大已经上初中了', now: '用户有 5 个孩子，老大已经上初中了', why: '数字不同' },
  { old: '用户喜欢吃甜的，每天下午都要来一块蛋糕', now: '用户不喜欢吃甜的，每天下午都要来一块蛋糕', why: '否定极性不同' },
];
const UNRELATED = [
  '用户在上海做前端，主要写 React',
  '用户喜欢拍胶片，手上有台奥林巴斯',
];
/*
 * 含否定字、但不表否定的固定搭配。这几对说的是同一件事，标成矛盾是**反向**的错：
 * 一条一致的记忆被降成「可能已过时」，权重减半，块里还印一句「这两条说的不一样」。
 *
 * 这条判断错在**词形当语义**：「不错」的「不」修饰的是「错」，整个词是肯定。
 * 中文里这一族很多（差不多 / 不得了 / 忍不住 / 不得不 / 不好意思 / 没多久），
 * 而它们全都含标准否定字。
 *
 * 这三对故意**另开一个库**跑。第一版把它们写进同一个库，结果无关的两对（数字、
 * 否定极性）从 `disputed` 变成 `superseded`——不是逻辑变了，是分段边界变了：
 * 多六行文本让「3 个孩子」和「5 个孩子」落进不同段落，槽位比较在**写入时**就判了
 * 取代，压根没走到这一轮维护的矛盾扫描。断言本身没错，是它被前置条件绑架了。
 * 一个断言要钉住的东西，不能受同一个库里别的写入影响。
 */
const NOT_NEGATIONS = [
  { left: '用户觉得这家川菜馆的菜不错，下次还去', right: '用户觉得这家川菜馆的菜挺好吃，下次还去', why: '「不错」' },
  { left: '用户的房租差不多该交了，月底那几天手头紧', right: '用户的房租快该交了，月底那几天手头紧', why: '「差不多」' },
  { left: '用户忍不住笑了一路，说那场面太滑稽', right: '用户笑了一路，说那场面太滑稽', why: '「忍不住」' },
];

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  console.log('\n[1] 数字和否定能被抓出来，无关的不会');
  {
    const dir = mkdtempSync(join(root, 'scan-'));
    const dbPath = join(dir, 'loom.db');
    // One second, so the probe does not wait a real maintenance cycle.
    const loom = createLoom({ dbPath, config: { maintenanceIntervalSeconds: 10 } });

    for (const pair of PAIRS) {
      await loom.call('memory_write', { text: pair.old }, SESSION);
      await wait(5);
      await loom.call('memory_write', { text: pair.now }, SESSION);
      await wait(5);
    }
    for (const text of UNRELATED) {
      await loom.call('memory_write', { text }, SESSION);
      await wait(5);
    }

    await wait(11000);

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT text, status FROM facts ORDER BY id').all();
    db.close();

    const disputed = rows.filter((row) => row.status === 'disputed');
    check('两条旧事实被标为待确认', disputed.length === 2, `${disputed.length} 条`);
    for (const pair of PAIRS) {
      const hit = disputed.some((row) => row.text === pair.old);
      check(`${pair.why}：旧的那条被标记`, hit);
    }
    const unrelatedMarked = rows.filter(
      (row) => row.status === 'disputed' && UNRELATED.includes(row.text),
    );
    check('无关事实没被牵连', unrelatedMarked.length === 0);
    const newerKept = rows.filter((row) => PAIRS.some((pair) => pair.now === row.text) && row.status === 'active');
    check('新的那条保持 active', newerKept.length === 2, `${newerKept.length}/2`);

    console.log('\n[2] 标了之后块里要说出来');
    await loom.turn(SESSION, '孩子最近怎么样', '挺好的吧', { gapMs: 60000 });
    const block = loom.memoryBlock(SESSION);
    check('块里出现「可能已过时」', block.includes('可能已过时'));

    console.log('\n[3] 体检报告要看得到数量');
    const report = await loom.call('memory_doctor', {}, SESSION);
    const text = typeof report === 'string' ? report : JSON.stringify(report);
    check('报告含计划与矛盾一行', text.includes('计划与矛盾'), '');
    check('报告里矛盾数不为零', /([1-9]\d*)\/\d+ 条待确认/u.test(text));

    console.log('\n[4] 同一对不会被反复标记');
    const before = disputed.length;
    await wait(11000);
    const db2 = new DatabaseSync(dbPath);
    const after = db2.prepare("SELECT COUNT(*) AS n FROM facts WHERE status = 'disputed'").get().n;
    db2.close();
    check('第二轮没有新增', after === before, `${before} → ${after}`);

    loom.dispose();
  }

  console.log('\n[5] 含否定字、却不表否定的固定搭配，一条都不许被标');
  {
    const dir = mkdtempSync(join(root, 'idiom-'));
    const dbPath = join(dir, 'loom.db');
    const loom = createLoom({ dbPath, config: { maintenanceIntervalSeconds: 10 } });

    for (const pair of NOT_NEGATIONS) {
      await loom.call('memory_write', { text: pair.left }, SESSION);
      await wait(5);
      await loom.call('memory_write', { text: pair.right }, SESSION);
      await wait(5);
    }

    await wait(11000);

    const db = new DatabaseSync(dbPath);
    const rows = db.prepare('SELECT text, status FROM facts ORDER BY id').all();
    db.close();

    for (const pair of NOT_NEGATIONS) {
      const row = rows.find((candidate) => candidate.text === pair.left);
      check(`${pair.why} 不是否定`, row !== undefined && row.status !== 'disputed', row?.status ?? '没写进去');
    }
    const flagged = rows.filter((row) => row.status === 'disputed').length;
    check('这一组一条都没被标', flagged === 0, `${flagged} 条`);

    loom.dispose();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
