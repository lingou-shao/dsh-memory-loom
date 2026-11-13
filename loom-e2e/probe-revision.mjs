/**
 * 用户自己更正自己时，旧的那条要不要退场？
 *
 * 这不是「用户说我们记错了」（那种要把旧条标 `disputed`，因为我们可能听岔了，
 * 而用户可能仍然那个意思），是**用户改口并说出旧值**：
 *
 *   医生让复查，我约了下个月10号
 *   我刚翻病历单子，发现我上回记错了，是这个月28号，我原来一直以为是下个月十号
 *
 * 第二句同时给了新值和旧值。缺了这条判断，库里会并排躺两条 `active`，
 * 一条说 10 号一条说 28 号，块里同等权威，读的人无从判断——2.1 里
 * `M01-G054` 一族四道就卡在这里。
 *
 * 判据不靠语义相似度，靠更正句自己报出的旧值：「下个月十号」能被搜到，
 * 而整句「我刚翻病历单子…」搜不到（那是 `findNeighbours` 的老问题）。
 *
 * 探针还要钉住**不该动**的那几种，因为这条规则最容易错在另一个方向：
 * 把一句「我怕记错」当成更正，或者让「十号记岔了」去作废「物业费每月十号交」。
 * 后者故意保留为「不触发」：只共享一个二元组时我们定位不到，宁可漏标。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-revision-session';
const root = mkdtempSync(join(tmpdir(), 'loom-revision-'));

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 每个场景一个库：一个断言要钉住的东西，不能受同库别的写入影响。 */
async function scenario(name, writes) {
  const dir = mkdtempSync(join(root, 's-'));
  const dbPath = join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { maintenanceIntervalSeconds: 10 } });
  const replies = [];
  for (const text of writes) {
    replies.push(await loom.call('memory_write', { text }, SESSION));
    await wait(5);
  }
  /* 先放手再开库：反过来的话 SQLite 的句柄还没落盘，读到的可能不是最后一次写入。 */
  loom.dispose();
  await wait(30);
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT id, text, status, superseded_by FROM facts ORDER BY id').all();
  const edges = db.prepare("SELECT from_id, to_id, edge_type FROM memory_edges WHERE edge_type = 'SUPERSEDES'").all();
  db.close();
  return { name, rows, edges, replies };
}

try {
  console.log('\n[1] 说出旧值的自我更正：旧条退场，新条留下');

  const OLD = '医生让复查，我约了下个月10号';
  const NEW = '我刚翻病历单子，发现我上回记错了，是这个月28号，我原来一直以为是下个月十号';
  {
    const r = await scenario('正向', [OLD, NEW]);
    const old = r.rows.find((row) => row.text === OLD);
    const now = r.rows.find((row) => row.text === NEW);
    check('旧值那条被标 superseded', old?.status === 'superseded', old?.status ?? '没写进去');
    check('新值那条保持 active', now?.status === 'active', now?.status ?? '没写进去');
    check('superseded_by 指向新条', old !== undefined && now !== undefined && old.superseded_by === now.id,
      `${old?.superseded_by} → #${now?.id}`);
    check('留了一条 SUPERSEDES 边', r.edges.length === 1 && r.edges[0].to_id === old?.id,
      `${r.edges.length} 条`);
    check('返回语说清了「标记旧记忆」', String(r.replies[1]).includes('取代'), String(r.replies[1]).slice(0, 40));
  }

  console.log('\n[2] 只是担心记错，不是更正');
  {
    const r = await scenario('负向-担心', ['我妈生日是十二号', '今天排班又看了三遍，我就是怕记错，怕迟到']);
    check('两条都还是 active', r.rows.every((row) => row.status === 'active'),
      r.rows.map((row) => row.status).join(','));
    check('没有凭空多出取代边', r.edges.length === 0, `${r.edges.length} 条`);
  }

  console.log('\n[3] 只共享一个词的旧值：定位不到，就不许动');
  {
    const r = await scenario('负向-撞数字', ['物业费每月十号交', '高姐是十二号生日，十号记岔了']);
    check('无关的那条没被牵连', r.rows[0].status === 'active', r.rows[0].status);
    check('没有取代边', r.edges.length === 0, `${r.edges.length} 条`);
  }

  console.log('\n[4] 认错但没说旧值：没有可定位的目标');
  {
    const r = await scenario('负向-无旧值', ['冰箱里还有两盒酸奶', '我刚才说错了，你别按那个记']);
    check('两条都还是 active', r.rows.every((row) => row.status === 'active'),
      r.rows.map((row) => row.status).join(','));
  }

  console.log('\n[5] 旧值在「记岔了」前面，也认');
  {
    const OLD2 = '何叔的棋是十一月二号送过去的';
    const NEW2 = '我想起来了，是十一月五号送的，二号记岔了';
    const r = await scenario('正向-后置', [OLD2, NEW2]);
    const old = r.rows.find((row) => row.text === OLD2);
    check('旧条被标 superseded', old?.status === 'superseded', old?.status ?? '没写进去');
  }

  /*
   * 这一段摘自 M01 的真实前史：规则抽取会把一段话拆成好几条事实，其中
   * 「我原来一直以为是下个月十号」自己成了一条。它引用的是**旧值**，不是更正。
   * 第一版没挡住它，它拿「下个月十号」去搜，把用户另一件事（搬家，也是
   * 「下个月10号」）的旧计划标成了已被取代——`#181 superseded #28`。
   */
  console.log('\n[6] 只是在复述旧值的那条，不许触发取代');
  {
    const r = await scenario('负向-复述旧值', [
      '医生让复查，我约了下个月10号',
      '我原来一直以为是下个月十号，白记这么久',
    ]);
    check('两条都还是 active', r.rows.every((row) => row.status === 'active'),
      r.rows.map((row) => row.status).join(','));
    check('没有取代边', r.edges.length === 0, `${r.edges.length} 条`);
  }
} finally {
  /* Windows 上句柄有时比进程晚一步放手，删不掉不是断言失败。 */
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* 临时目录，系统会自己收。 */
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
