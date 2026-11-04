/**
 * 认领这条路：谁能发起、谁能审批、批准之后角色变成什么。
 *
 * 为什么值得一个探针：`claim` 曾经排在 `requireMaster` 之后，而 claimant 取的是
 * 当前 actor——等于只有主人能认领自己，而 `reviewClaim` 批准时把 claimant 提升成
 * `friend`。主人一旦走完这两步，就用自己的手把自己降成了朋友，此后 approve/list/
 * erase 全部失灵，也没有任何回程。
 *
 * 四条断言：
 *   1. 访客能发起认领，状态变 pending_review，认领记录是 pending；
 *   2. 主人发起认领被拒，且角色仍是 master；
 *   3. 主人批准后，访客变 friend；
 *   4. 已有同名朋友时，批准走合并而不是新建一个重名朋友。
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const DB = fileURLToPath(new URL('./tmp-claim.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

const MASTER_SESSION = 's-master';
const NOW = Date.now();
let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail === '' ? '' : ` — ${detail}`}`);
  }
};

const loom = createLoom({ dbPath: DB });
// 先让 master 的会话落库
await loom.turn(MASTER_SESSION, '早', '早。');

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 5000');
const addVisitor = (id, session, name) => {
  db.prepare('INSERT INTO identities (id, name, role, status, created_at, last_active_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, name, 'visitor', 'active', NOW, NOW, '{}');
  db.prepare('INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
    .run(session, id, 'Asia/Shanghai', NOW, NOW);
};
addVisitor('u-visitor', 's-visitor', '访客甲');
addVisitor('u-visitor2', 's-visitor2', '访客乙');
// 已有同名朋友：批准时应合并到它，而不是再建一个
db.prepare('INSERT INTO identities (id, name, role, status, created_at, last_active_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run('u-friend', '访客乙', 'friend', 'active', NOW, NOW, '{}');
const identityOf = (id) => db.prepare('SELECT id, name, role, status FROM identities WHERE id = ?').get(id);

console.log('[1] 访客发起认领');
const reply = await loom.call('memory_identity', { action: 'claim', name: '访客甲', evidence: '我记得那只猫叫煤球' }, 's-visitor');
check('访客能发起', String(reply).includes('已提交认领'), String(reply));
const claimed = identityOf('u-visitor');
check('状态转 pending_review', claimed.status === 'pending_review', String(claimed.status));
const claimRow = db.prepare("SELECT * FROM identity_claims WHERE claimant_identity = 'u-visitor' ORDER BY id DESC LIMIT 1").get();
check('认领记录是 pending', claimRow?.status === 'pending', String(claimRow?.status));

console.log('\n[2] 主人不能认领自己');
let refused = '';
try {
  await loom.call('memory_identity', { action: 'claim', name: '主人别称' }, MASTER_SESSION);
} catch (error) {
  refused = String(error?.message ?? error);
}
check('主人发起被拒', refused.includes('不需要认领'), refused || '没有抛错');
const master = identityOf('master');
check('主人角色未被改动', master.role === 'master' && master.status === 'active', `${master.role}/${master.status}`);

console.log('\n[3] 主人批准 → 访客转朋友');
const approved = await loom.call('memory_identity', { action: 'approve', claimId: Number(claimRow.id) }, MASTER_SESSION);
check('回话说明已通过', String(approved).includes('已通过'), String(approved));
const after = identityOf('u-visitor');
check('角色变成 friend', after.role === 'friend', String(after.role));
check('状态回到 active', after.status === 'active', String(after.status));

console.log('\n[4] 已有同名朋友 → 走合并');
const reply2 = await loom.call('memory_identity', { action: 'claim', name: '访客乙' }, 's-visitor2');
check('第二个访客也能认领', String(reply2).includes('已提交认领'), String(reply2));
const claim2 = db.prepare("SELECT * FROM identity_claims WHERE claimant_identity = 'u-visitor2' ORDER BY id DESC LIMIT 1").get();
const merged = await loom.call('memory_identity', { action: 'approve', claimId: Number(claim2.id) }, MASTER_SESSION);
check('回话点名合并到的身份', String(merged).includes('u-friend'), String(merged));
const src = identityOf('u-visitor2');
check('被并的一方标记 merged', src.status === 'merged', String(src.status));
const friends = Number(db.prepare("SELECT COUNT(*) AS n FROM identities WHERE name = '访客乙' AND role = 'friend' AND status = 'active'").get().n);
check('没有多出一个同名朋友', friends === 1, `${friends} 个`);

db.close();
loom.dispose();
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
