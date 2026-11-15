/**
 * probe-deadline.mjs — 单次整合撞上 `maxRunSeconds` 之后，剩下的片段算不算「已整合」
 *
 * T05 的现场（design.md §112.7）：`consolidateSession` 在循环开头检查
 * `Date.now() > deadline`，到点就 `break`，但收尾那一句仍然把**全部** pending
 * 标成 `consolidated = 1`，`consolidated_through` 也推到最后一行的 id。
 *
 * 后果不是「慢」，是**静默漏抽**：被跳过的轮次永远不会再进抽取，
 * 报告里 `l0Processed` 还等于全部行数，从外面看不出任何异常。
 *
 * 这个探针只做三件事：
 *   1. 造一次必然超时的运行（每段 3 秒、上限 10 秒、4 段）；
 *   2. 查库：是否真的只处理了一部分（`pending > 0`、`through < maxId`）；
 *   3. 再跑一次：剩下的是否**补得上**，且已处理的不重复抽。
 *
 * 断言写的是**行为**，不是实现：只要「到点之后剩下的还留在 pending」成立，
 * 内部怎么记这个范围都可以。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-deadline-'));
const dbPath = join(root, 'loom.db');
const SID = 's-deadline';
const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const REPLY = JSON.stringify({
  title: '一段日常',
  summary: '聊了几件当天要办的小事。',
  aliases: [],
  emotion: { valence: 0, arousal: 0, salience: 0.4 },
  impression: null,
  diary: null,
  facts: [],
});

/** 一个每次调用都要等 `ms` 的假模型；`facts` 留空，所以每段只会调一次（不调判官）。 */
function slowLlm(ms) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'probe' }],
    listModels: async () => [{ id: 'probe-1' }],
    async *stream(request) {
      calls.push(request);
      await new Promise((resolve) => setTimeout(resolve, ms));
      yield { type: 'text-delta', text: REPLY };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

const read = (fn) => {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

const stats = () =>
  read((db) => ({
    rows: Number(db.prepare('SELECT COUNT(*) AS c FROM l0').get().c),
    pending: Number(db.prepare('SELECT COUNT(*) AS c FROM l0 WHERE consolidated = 0').get().c),
    maxId: Number(db.prepare('SELECT MAX(id) AS m FROM l0').get().m),
    through: Number(db.prepare('SELECT consolidated_through AS t FROM sessions WHERE session_id = ?').get(SID).t),
    events: Number(db.prepare('SELECT COUNT(*) AS c FROM events').get().c),
  }));

/** 把会话的 token 计数顶上去，让下一轮 turn-stopping 判定「该整合了」。 */
function makeDue() {
  read((db) => db.prepare('UPDATE sessions SET token_count = 1000000000 WHERE session_id = ?').run(SID));
}

/** 等一次整合**收尾**：`memory.consolidate` 的 audit 行是最后写的。 */
async function waitConsolidation(timeoutMs) {
  const before = read((db) => Number(db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'memory.consolidate'").get().c));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const now = read((db) => Number(db.prepare("SELECT COUNT(*) AS c FROM audit WHERE action = 'memory.consolidate'").get().c));
    if (now > before) return true;
  }
  return false;
}

const SENTENCES = [
  '上午去看了牙，医生说下个月再补一次，顺便把预约单拍了张照。',
  '下午交了房租，房东说下季度不涨，收据放在抽屉第二层。',
  '傍晚修了自行车，后闸线换了新的，花了三十五块。',
  '晚上把阳台的花都搬进来，降温了，怕冻着。',
];

let loom = null;
try {
  /* ---- 一、跑一次必然超时的整合 ---------------------------------------- */
  loom = createLoom({
    dbPath,
    llm: slowLlm(4000),
    config: {
      timezone: 'Asia/Shanghai',
      consolidation: { triggerTokens: 1e9, idleMinutes: 1e9, batchSize: 1, maxRunSeconds: 10, itemTimeoutSeconds: 5 },
    },
    settleRounds: 1,
  });
  for (const [index, text] of SENTENCES.entries()) {
    await loom.turn(SID, text, '好，我记下了。', { gapMs: (index + 1) * 2 * 3600e3 });
  }
  const before = stats();
  check('四轮八行都还在 pending', before.pending === 8 && before.rows === 8, `l0=${before.rows} pending=${before.pending}`);

  makeDue();
  loom.emit('agent/turn-stopping', { agent: { id: SID } });
  const finished = await waitConsolidation(60_000);
  check('整合跑完并留下了 audit', finished, finished ? '' : '60 秒内没等到 memory.consolidate');

  const after = stats();
  check('中途停下（事件数少于轮数）', after.events < 4, `events=${after.events}`);
  check('剩下的片段仍在 pending', after.pending > 0, `pending=${after.pending}`);
  check('会话游标没有推到库尾', after.through < after.maxId, `through=${after.through} maxId=${after.maxId}`);

  /* ---- 二、换一个快的模型再跑，剩下的要补上 ----------------------------- */
  loom.dispose();
  loom = null;
  const fast = slowLlm(0);
  loom = createLoom({
    dbPath,
    llm: fast,
    config: {
      timezone: 'Asia/Shanghai',
      consolidation: { triggerTokens: 1e9, idleMinutes: 1e9, batchSize: 1, maxRunSeconds: 10, itemTimeoutSeconds: 5 },
    },
    settleRounds: 1,
  });
  makeDue();
  loom.emit('agent/turn-stopping', { agent: { id: SID } });
  const finishedAgain = await waitConsolidation(30_000);
  check('第二次整合跑完', finishedAgain, finishedAgain ? '' : '30 秒内没等到 audit');

  const done = stats();
  check('剩余片段被补上', done.pending === 0, `pending=${done.pending}`);
  check('游标推到库尾', done.through === done.maxId, `through=${done.through} maxId=${done.maxId}`);
  check('没有重复抽已处理的轮', done.events === 4, `events=${done.events}`);
  check('补的那次只抽了剩下的', fast.calls.length === 4 - after.events, `模型调用 ${fast.calls.length} 次，剩余 ${4 - after.events} 段`);
} catch (error) {
  check('探针本身没抛错', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '));
} finally {
  try {
    loom?.dispose();
  } catch {}
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

let failed = 0;
for (const [label, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
}
console.log('');
process.exit(failed === 0 ? 0 : 1);
