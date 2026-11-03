/**
 * probe-search-preference.mjs — 长期规矩能不能被搜到、被忘掉
 *
 * 修之前的状态（v0.2.27）：`preferences` 有独立的 FTS 表，也有
 * `searchPreferences()`，块召回在用，只有 `memory_search` 的 `searchFor()`
 * 没接。于是常驻上限（`retrieval.residentPreferences`，默认 3）之外的规矩
 * 谁都够不着 —— 「我不吃香菜」写进去，第 4 条之后搜「香菜」是
 * 「没有找到相关记忆」，而那一行就在表里。
 *
 * 这个探针固定六件事：
 *   1. 关键词命中偏好，编号是 #P，不是 #F；
 *   2. `memory_expand` 能取回 P 的原文；
 *   3. 事实与偏好同号时，`memory_forget` 各走各的（不误删另一张表的行）；
 *   4. 退休之后块、搜索、expand 三处同时看不见；
 *   5. `permanent` 真删，且删完 expand 说「没有偏好」而不是「已被移出」；
 *   6. 跨身份查询不返回对方的规矩（规矩没有可见性标记，只能整类不给）；
 *   7. 编号填进错字段时不会让整轮白跑（`ref="99"` 当事实号；`id="P1"` 由宿主
 *      的参数校验先拦下，不会静默删错行）。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, MIN } from './harness.mjs';

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const withLoom = async (name, overrides, body) => {
  const root = mkdtempSync(join(tmpdir(), `loom-searchpref-${name}-`));
  const loom = createLoom({ dbPath: join(root, 'loom.db'), config: { timezone: 'Asia/Shanghai', ...overrides } });
  try {
    return await body(loom);
  } finally {
    loom.dispose();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
};

// 1–4. 能搜到、能取回、同号不误删、退休后三处一致
await withLoom('basic', {}, async (loom) => {
  // 四条 instruction：前三条被常驻带走，第四条（香菜）落在常驻之外
  await loom.call('memory_write', { text: '我不吃香菜', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '叫我老张', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我早上不看邮件', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我对花生过敏，很严重', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我喜欢爬山' }, 's1');

  const hit = String(await loom.call('memory_search', { query: '香菜' }, 's1'));
  check('常驻之外的规矩能被搜到', hit.includes('我不吃香菜'), hit.split('\n')[0]);
  check('编号是 #P 不是 #F', hit.includes('(#P1)'), hit.includes('(#P1)') ? '' : hit);
  check('偏好行不打 domain 列', !hit.includes('null'), hit.includes('null') ? hit : '');

  const expanded = String(await loom.call('memory_expand', { ref: 'P1' }, 's1'));
  check('expand P1 取回原文', expanded.includes('我不吃香菜'), expanded.split('\n')[0]);

  // 事实 #1 与偏好 #1 同时存在：删偏好不该动事实
  const before = String(await loom.call('memory_search', { query: '爬山' }, 's1'));
  check('事实 #F1 存在（同号样本就位）', before.includes('(#F1)'), before.split('\n')[0]);

  const retired = String(await loom.call('memory_forget', { ref: 'P1' }, 's1'));
  check('退休回话点名了那句话', retired.includes('我不吃香菜'), retired);

  const after = String(await loom.call('memory_search', { query: '香菜' }, 's1'));
  check('退休后搜不到', !after.includes('香菜'), after);

  const stillFact = String(await loom.call('memory_search', { query: '爬山' }, 's1'));
  check('同号的事实 #F1 没被连坐', stillFact.includes('(#F1)'), stillFact.split('\n')[0]);

  const goneExpand = String(await loom.call('memory_expand', { ref: 'P1' }, 's1'));
  check('退休后 expand 拒绝返回', goneExpand.includes('不在长期偏好区'), goneExpand);

  await loom.turn('s1', '今天天气不错', '适合出门。', { gapMs: 2 * MIN });
  const block = loom.memoryBlock('s1');
  check('退休后块里也没有它', !block.includes('香菜'), block.includes('香菜') ? block : '');

  // 事实这条路不能被改坏
  const factForget = String(await loom.call('memory_forget', { id: 1 }, 's1'));
  check('事实仍可用 id 删除', factForget.includes('已标记删除 #1') && factForget.includes('爬山'), factForget);
});

// 5. permanent 真删
await withLoom('purge', {}, async (loom) => {
  await loom.call('memory_write', { text: '我不吃香菜', kind: 'instruction' }, 's1');
  const purged = String(await loom.call('memory_forget', { ref: 'P3', permanent: true }, 's1'));
  // P3 不存在（只有一条），这里换成真编号
  check('不存在的编号给出「没有忘记」', purged.includes('没有忘记 P3'), purged);

  const real = String(await loom.call('memory_forget', { ref: 'P1', permanent: true }, 's1'));
  check('彻底删除回话带原文', real.includes('已彻底删除长期规矩 P1') && real.includes('香菜'), real);

  const afterExpand = String(await loom.call('memory_expand', { ref: 'P1' }, 's1'));
  check('彻底删除后是「没有偏好」而不是「已被移出」', afterExpand.includes('没有偏好 P1'), afterExpand);
});

// 6. 跨身份：规矩整类不返回，事实照旧
//
// harness 里每个会话都映射到 master（`identityForSession`），没有工具能造第二个
// 身份，所以这里先让插件把表建好，再用第二个连接塞一个 friend 和它的会话。这样
// 起来的 s2 是货真价实的朋友身份，跨身份分支才真的被走到。
{
  const root = mkdtempSync(join(tmpdir(), 'loom-searchpref-cross-'));
  const dbPath = join(root, 'loom.db');
  const config = { timezone: 'Asia/Shanghai' };
  createLoom({ dbPath, config }).dispose();
  const { DatabaseSync } = await import('node:sqlite');
  const seed = new DatabaseSync(dbPath);
  const at = Date.now();
  seed.prepare("INSERT INTO identities (id, name, role, status, created_at, last_active_at, metadata) VALUES ('friend-1', '小李', 'friend', 'active', ?, ?, '{}')").run(at, at);
  seed.prepare("INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at) VALUES ('s2', 'friend-1', 'Asia/Shanghai', ?, ?)").run(at, at);
  seed.close();

  const loom = createLoom({ dbPath, config });
  try {
    await loom.call('memory_write', { text: '我对花生过敏', kind: 'instruction' }, 's2');
    await loom.call('memory_write', { text: '我住在城东' }, 's2');

    const cross = String(await loom.call('memory_search', { query: '花生过敏', identity: 'friend-1' }, 's1'));
    check('主人跨身份查不到对方的规矩', !cross.includes('花生过敏'), cross);
    const crossFact = String(await loom.call('memory_search', { query: '城东', identity: 'friend-1' }, 's1'));
    check('同一扇门里对方的事实仍然可查（证明不是整条路断了）', crossFact.includes('城东'), crossFact);

    const theirs = String(await loom.call('memory_search', { query: '花生过敏' }, 's2'));
    check('朋友自己搜得到自己的规矩', theirs.includes('花生过敏'), theirs);

    // 主人不能替朋友收回规矩。这条不是权限洁癖：回话会点名被收回的那句话，
    // 而规矩本来就没有可见性标记（正因如此跨身份搜索整类不给）。给主人开一个
    // 例外，等于从后门把刚才关上的门又开回来。
    const masterTry = String(await loom.call('memory_forget', { ref: 'P1' }, 's1'));
    check('主人收不回别人的规矩', masterTry.includes('没有忘记 P1'), masterTry);
    const friendStill = String(await loom.call('memory_expand', { ref: 'P1' }, 's2'));
    check('被拒之后对方的规矩仍然有效', friendStill.includes('花生过敏'), friendStill.split('\n')[0]);

    const ownTry = String(await loom.call('memory_forget', { ref: 'P1' }, 's2'));
    check('朋友自己收得回自己的规矩', ownTry.includes('已移出') && ownTry.includes('花生过敏'), ownTry);
  } finally {
    loom.dispose();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

// 7. 编号填进错字段时，别让整轮白跑
//
// `ref=12`（把事实号写进 ref）是最容易发生的一个错，而 `ref` 是自由字符串，
// 挡不住 —— 所以工具自己把它当 F12 解析。`id="P3"` 是另一种错，但那个由宿主
// 的参数校验先拦下（`id` 声明为 integer），我们这里只证明宿主确实拦了。
await withLoom('handle', {}, async (loom) => {
  await loom.call('memory_write', { text: '我不吃香菜', kind: 'instruction' }, 's1');
  await loom.call('memory_write', { text: '我喜欢爬山' }, 's1');

  const bareInRef = String(await loom.call('memory_forget', { ref: '99' }, 's1'));
  check('ref 里的裸数字当事实号（不是语法错）', bareInRef.includes('没有删除 #99'), bareInRef);

  const typedInRef = String(await loom.call('memory_forget', { ref: 'F1' }, 's1'));
  check('ref 写成 F1 与 id=1 等价', typedInRef.includes('已标记删除 #1') && typedInRef.includes('爬山'), typedInRef);

  let rejected = '';
  try {
    await loom.call('memory_forget', { id: 'P1' }, 's1');
  } catch (error) {
    rejected = String(error?.message ?? error);
  }
  check('id 里塞字符串由宿主参数校验拒绝（不是静默删错）', rejected.includes('must be an integer'), rejected);

  const both = String(await loom.call('memory_forget', {}, 's1'));
  check('两个都没给时说人话', both.includes('没给编号'), both);
});

let failed = 0;
console.log('=== 长期规矩的检索与遗忘 ===');
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? '  ' + detail : ''}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);
process.exit(failed === 0 ? 0 : 1);
