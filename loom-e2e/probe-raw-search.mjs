/**
 * 原话通道：能不能直接找到「那句话在哪」，而不是找到一句关于它的摘要。
 *
 * 这一条是这次改造的核心，所以分五段钉住，每段都对着一处会悄悄退化的地方：
 *
 * 1. **抽不出来不等于找不到。** 带模型时事件是被压缩过的摘要，用户原话里的
 *    专有词（这里用「茉莉花茶」）根本不在派生层里。以前这种句子对任何工具都
 *    不可见，而它一直躺在 `l0` 里。这一节要的是：搜索能返回一个 `#L` 指针，
 *    展开逐字、带说话人。
 * 2. **开关是回滚门。** 关掉 `retrieval.rawSearch` 后结果必须逐字回到旧形状，
 *    否则 A/B 分不清是哪一个改动动了数字。
 * 3. **范围 ref。** `#L1-2` 是一整段问答；只回去一半，模型就只看见回答没看见
 *    问题，或者反过来。
 * 4. **不重复。** 派生层已经指到那一轮时，原话那行是同一句话第二次，要跳过。
 * 5. **升级与删除。** v5 老库要能把索引补起来（`rebuild`），被清理掉的轮要真的
 *    从索引里消失——两条都是「索引坏了但没人报错」的形态。
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, createLoomWithTimers, mockLlm, MIN } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const dir = join(tmpdir(), `loom-raw-search-${Date.now()}`);
const SECRET = '冰箱里那罐茉莉花茶别再动了，是我妈留的';
const QUERY = '茉莉花茶';

/* ── 1/2/3. 带模型：派生层里没有这个词，原话通道有 ────────────────── */
const llm = mockLlm(() =>
  JSON.stringify({
    title: '一段闲聊',
    summary: '聊了几句家里的事。',
    facts: [],
    aliases: [],
    emotion: { salience: 0.4, valence: 0, arousal: 0.2 },
    impression: null,
    diary: null
  })
);
const dbPath = join(dir, 'model.db');
const { loom, timers } = createLoomWithTimers({
  dbPath,
  llm,
  config: { consolidation: { triggerTokens: 0 }, segmentation: { gapMinutes: 5 } }
});
const SID = 'model';
await loom.turn(SID, SECRET, '知道了，不动。', { gapMs: 2 * MIN });
await loom.turn(SID, '今天有点闷', '开窗吧。', { gapMs: 40 * MIN });
for (const timer of timers) await timer.callback();
await loom.settle(8);

const on = String(await loom.call('memory_search', { query: QUERY, limit: 10 }, SID));
const rawLine = on.split('\n').find((line) => line.includes('#L')) ?? '';
const ref = (rawLine.match(/#(L\d+(?:-\d+)?)/) ?? [])[1] ?? '';

console.log('\n[1] 抽不出来不等于找不到');
check('派生层确实没有这个词', !on.includes('· fact') && !on.includes('· event'), on.split('\n').slice(0, 3).join(' | ').slice(0, 100));
check('搜索返回了原话指针', rawLine.length > 0, rawLine.trim());
check('这一行标着「原话」', rawLine.includes('原话'));
check('指针覆盖整段问答', /#L\d+-\d+/.test(rawLine), ref);

const expanded = String(await loom.call('memory_expand', { ref: `#${ref}` }, SID));
check('展开后逐字含原句', expanded.includes(SECRET), expanded.split('\n')[2] ?? '');
check('展开带说话人', expanded.includes('用户：') && expanded.includes('我：'));

console.log('\n[2] 开关关掉回到旧形状');
const off = createLoom({ dbPath, config: { retrieval: { rawSearch: false } } });
const withoutRaw = String(await off.call('memory_search', { query: QUERY, limit: 10 }, SID));
off.dispose();
check('关掉后没有 L 行', !withoutRaw.includes('#L'), withoutRaw.trim().slice(0, 80));
check('关掉后就是「没有找到」', withoutRaw.includes('没有找到'), withoutRaw.trim());

console.log('\n[3] 单行 ref 也能取');
const one = String(await loom.call('memory_expand', { ref: '#L1' }, SID));
check('#L1 只回一行', one.includes(SECRET) && !one.includes('知道了，不动'), one.split('\n')[2] ?? '');
loom.dispose();

/* ── 4. 规则路径：派生层已经指到那一轮时，不再重复一行 ─────────────── */
{
  const rulePath = join(dir, 'rule.db');
  const rule = createLoom({
    dbPath: rulePath,
    config: { consolidation: { triggerTokens: 0 }, segmentation: { gapMinutes: 120 } }
  });
  const id = 'rule';
  await rule.turn(id, SECRET, '知道了，不动。', { gapMs: 2 * MIN });
  await rule.turn(id, '好，那我去做饭', '去吧。', { gapMs: 3 * MIN });

  // 规则路径把用户那句话原样写进事件，所以派生层命中时就等于已经指到了那一轮。
  const hits = String(await rule.call('memory_search', { query: SECRET, limit: 10 }, id));
  const quoted = hits.split('\n').filter((line) => line.includes(SECRET)).length;
  console.log('\n[4] 同一轮不打印两次');
  check('这句话只出现一次', quoted === 1, `出现 ${quoted} 次`);
  check('这一条是派生层给的（不是 L）', hits.includes('#E') || hits.includes('#F'), hits.split('\n')[1]?.trim() ?? '');
  rule.dispose();
}

/* ── 5. v5 升级要补索引；删掉的轮要离开索引 ─────────────────────────── */
{
  const upgrade = join(dir, 'upgrade.db');
  const first = createLoom({ dbPath: upgrade, config: { consolidation: { triggerTokens: 0 } } });
  const id = 'up';
  await first.turn(id, SECRET, '知道了，不动。', { gapMs: 2 * MIN });
  await first.turn(id, '今天有点闷', '开窗吧。', { gapMs: 4 * MIN });
  first.dispose();

  /*
   * 装成 v5 老库：那个版本里根本没有这张索引表，连触发器也没有。
   * `delete-all` 对外部内容表不生效（它只清 contentless 的索引），所以照 v5 的
   * 真实形状把表和触发器一起删掉，比把索引清空更接近现场。
   */
  const raw = new DatabaseSync(upgrade);
  raw.exec('DROP TABLE IF EXISTS l0_fts');
  raw.exec('DROP TRIGGER IF EXISTS l0_ai');
  raw.exec('DROP TRIGGER IF EXISTS l0_ad');
  raw.exec('DROP TRIGGER IF EXISTS l0_au');
  raw.exec('PRAGMA user_version = 5');
  const hasTable = raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'l0_fts'").get().n;
  raw.close();

  const reopened = createLoom({ dbPath: upgrade, config: { consolidation: { triggerTokens: 0 } } });
  const db = new DatabaseSync(upgrade, { readOnly: true });
  const after = db.prepare('SELECT COUNT(*) AS n FROM l0_fts').get().n;
  const turns = db.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  db.close();

  console.log('\n[5] 升级补齐索引，删除离开索引');
  check('老库确实没有这张索引表', hasTable === 0, `${hasTable} 张`);
  check('重开之后索引补满', after === turns && turns > 0, `${after}/${turns} 条`);
  // 6 是原话索引落地的版本；之后的迁移只会往上加。
  check('schema 版本至少 6', Number(version) >= 6, String(version));

  const doctor = String(await reopened.call('memory_doctor', {}, id));
  const line = doctor.split('\n').find((row) => row.includes('原话索引')) ?? '';
  check('自检报出原话索引', line.length > 0, line.trim());

  // 删除一轮：FTS 触发器要把这两行一起带走，否则指针会指向不存在的原文。
  const write = new DatabaseSync(upgrade);
  write.prepare('DELETE FROM l0 WHERE turn = 1').run();
  const left = write.prepare('SELECT COUNT(*) AS n FROM l0_fts').get().n;
  write.close();
  check('删掉一轮后索引同步变少', left === turns - 2, `${left}/${turns}`);

  const gone = String(await reopened.call('memory_expand', { ref: '#L1-2' }, id));
  check('展开已删除的范围会明说', gone.includes('原文已经不在了'), gone.trim().slice(0, 60));
  check('删除后搜索不再返回这一段', !String(await reopened.call('memory_search', { query: QUERY, limit: 10 }, id)).includes('#L1'));
  reopened.dispose();
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
rmSync(dir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
