/**
 * 关联结构的实测规模，以及字面召回能覆盖到哪。
 *
 * 这个探针不改任何行为，只回答四个问题 —— 它们是「要不要做关联一跳」的
 * 全部依据，猜不出来，只能量：
 *
 *   1. 一条事实有多大比例挂到了事件上（`event_facts`）
 *   2. 一个事件平均挂几条事实 —— 也就是从事件出发的一跳，到底能扩出几条
 *      命中之外的新内容。等于 1 就说明这一跳什么也没带来
 *   3. `memory_edges` 里到底有多少条边、都是什么类型。这张表在检索里一次
 *      都没被查过，先看它有没有货
 *   4. 现有召回在字面命中、字面部分重合、纯语义三种问法下各是什么结果
 *
 * 前三条打印出来给人看；断言只锁几个不会随参数调整而变的**结构性**事实，
 * 不锁具体数字 —— 数字会调，锁了就变成每隔几版红一次的那种探针。
 *
 * 全部在临时库里跑，跑完删掉，不碰任何真实库。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIN, createLoom } from './harness.mjs';

const SESSION = 'probe-linkage';
const root = mkdtempSync(join(tmpdir(), 'loom-linkage-'));

/** 每轮都整合，不等阈值。 */
const EAGER = { consolidation: { triggerTokens: 1, idleMinutes: 0 } };
/**
 * 间隔大于 `segmentation.gapMinutes`（默认 30）才会被切成独立的段，
 * 而每段对应一个事件 —— 这是「一个事件挂几条事实」能大于 1 或等于 1 的分界。
 */
const GAP = 40 * MIN;

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

/** 打印一行测量值，不计入断言。 */
function measure(label, value) {
  console.log(`  ·    ${label} — ${value}`);
}

/**
 * 四轮对话，话题互不相干，每轮都留下可被规则抽出来的事实。
 *
 * 不传 `llm`：走的是没有模型时的规则降级路径。要测的是「关联表怎么被填」，
 * 不是「模型抽得好不好」，用固定规则的确定性换取可复现。
 * 最后一轮是改口，用来看冲突边会不会真的被写进 `memory_edges`。
 */
const TURNS = [
  ['我打算下周三去体检，一直拖着没去。我不吃香菜，闻着就难受。', '记住了，体检在下周三，香菜避开。'],
  ['我在一家做工业软件的公司上班，最近在弄一个老项目的迁移。下周要把方案交上去。', '老项目迁移听起来不轻松。'],
  ['我住在杭州，滨江那边。', '杭州滨江，记下了。'],
  ['体检改到下周五了，这周实在抽不出时间。', '那就改到下周五。'],
];

const LOOKUPS = [
  ['体检', '字面命中'],
  ['香菜', '字面命中'],
  ['上班', '字面命中'],
  ['我住在哪', '字面部分重合'],
  ['身体怎么样', '纯语义，字面不重合'],
];

try {
  const dbPath = join(root, 'loom.db');
  const loom = createLoom({ dbPath, config: EAGER });

  console.log('\n[1] 造出一段有四个话题的会话');
  for (const [user, assistant] of TURNS) {
    await loom.turn(SESSION, user, assistant, { gapMs: GAP });
    await loom.settle(8);
  }

  /*
   * 召回要在 dispose 之前问：工具登记在 ctx 上，dispose 之后就没有了。
   */
  console.log('\n[2] 召回基线：字面命中 vs 纯语义');
  const recall = [];
  for (const [query, kind] of LOOKUPS) {
    let text = '';
    try {
      text = String(await loom.call('memory_search', { query }, SESSION));
    } catch (error) {
      text = `（抛错：${String(error?.message ?? error)}）`;
    }
    const refs = [...text.matchAll(/#([FE])(\d+)/gu)].map((m) => m[1] + m[2]);
    const hit = refs.length > 0 && !text.includes('没有找到') && !text.includes('没有相关');
    recall.push({ query, kind, hit, refs });
    measure(`「${query}」（${kind}）`, hit ? `命中 ${refs.join(' ')}` : '未命中');
  }

  loom.dispose();

  const db = new DatabaseSync(dbPath);
  const idRow = db.prepare('SELECT id FROM identities ORDER BY rowid LIMIT 1').get();
  check('产生了身份', idRow !== undefined);
  const identityId = idRow?.id;

  const one = (sql, ...params) => Number(db.prepare(sql).get(...params)?.n ?? 0);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  /** 库里有几条活跃事实的正文含这个词。 */
  const storedWith = (word) =>
    one(
      `SELECT COUNT(*) AS n FROM facts
       WHERE identity_id = ? AND status IN ('active','disputed') AND instr(text, ?) > 0`,
      identityId,
      word,
    );

  /*
   * 「未命中」有两种，成因完全不同，混在一起看就会去改错模块：
   *   库里根本没有这条事实 → 抽取的缺口，改检索一点用没有
   *   库里有但没召回到     → 检索的缺口
   * 这一步把上一段每条用例归到其中一类，后面所有结论都以这张表为准。
   *
   * 「入库几条」是拿整条 query 当子串去比对正文，只对词成立。问句（含「哪」
   * 「什么」「怎么样」）本来就不会原样出现在正文里，那时这个数没有意义 ——
   * 报出来会让人以为事实丢了，所以干脆不报。
   */
  const isQuestion = (word) => /[哪什么怎么样吗呢]/u.test(word);
  console.log('\n[3] 把「未命中」拆成两类：库里没有 / 库里有但没召回');
  for (const row of recall) {
    const stored = isQuestion(row.query) ? null : storedWith(row.query);
    row.stored = stored;
    const why = row.hit
      ? '召回命中'
      : stored === null
        ? '问句未命中 → 语义缺口的用例'
        : stored === 0
          ? '库里没有这条事实 → 抽取缺口'
          : '库里有，没召回 → 检索缺口';
    measure(`「${row.query}」`, `${stored === null ? '问句，不做子串比对' : `入库 ${stored} 条`} · ${why}`);
  }
  const literal = recall.filter((row) => row.kind.startsWith('字面命中') && row.query !== '香菜');
  check(
    '标为「字面命中」的用例，库里确实有对应事实（否则它测的是抽取，不是召回）',
    literal.every((row) => row.stored > 0),
    literal.filter((row) => row.stored === 0).map((row) => row.query).join(' ') || '',
  );

  console.log('\n[4] 事实与事件各有多少');
  const facts = one(
    "SELECT COUNT(*) AS n FROM facts WHERE identity_id = ? AND status IN ('active','disputed')",
    identityId,
  );
  const events = one('SELECT COUNT(*) AS n FROM events WHERE identity_id = ?', identityId);
  const kinds = all(
    "SELECT kind, COUNT(*) AS n FROM facts WHERE identity_id = ? AND status IN ('active','disputed') GROUP BY kind",
    identityId,
  );
  measure('事实', `${facts} 条（${kinds.map((r) => `${r.kind} ${r.n}`).join(' / ')}）`);
  measure('事件', `${events} 个`);
  check('规则路径抽出了事实', facts > 0, `${facts} 条`);
  check('规则路径建出了事件', events > 0, `${events} 个`);

  console.log('\n[5] 事实挂到事件上的比例（决定一跳有没有东西可扩）');
  const linked = one(
    `SELECT COUNT(DISTINCT ef.fact_id) AS n FROM event_facts ef
     JOIN facts f ON f.id = ef.fact_id
     WHERE f.identity_id = ? AND f.status IN ('active','disputed')`,
    identityId,
  );
  const links = one('SELECT COUNT(*) AS n FROM event_facts');
  const pct = facts === 0 ? 0 : Math.round((linked / facts) * 100);
  measure('挂到至少一个事件的事实', `${linked}/${facts}（${pct}%）`);
  measure('event_facts 行数', String(links));
  check('事实挂了事件（否则一跳从事实出发就是空的）', linked > 0, `${linked} 条`);

  const fanOut = all(
    `SELECT e.id AS event_id, e.title, COUNT(ef.fact_id) AS n
     FROM events e LEFT JOIN event_facts ef ON ef.event_id = e.id
     WHERE e.identity_id = ? GROUP BY e.id ORDER BY e.id`,
    identityId,
  );
  console.log('  ·    每个事件挂了几条事实：');
  for (const row of fanOut) {
    console.log(`         E${row.event_id} ${String(row.n).padStart(2)} 条 · ${String(row.title).slice(0, 28)}`);
  }
  const hop = fanOut.length === 0 ? 0 : fanOut.reduce((sum, row) => sum + row.n, 0) / fanOut.length;
  measure('平均扇出', `${hop.toFixed(2)} 条/事件`);
  measure('一跳平均能多带来', `${Math.max(0, hop - 1).toFixed(2)} 条 / 次命中`);
  check('每个事件都至少挂了一条事实', fanOut.every((row) => row.n > 0));

  const spread = all(
    `SELECT fact_id, COUNT(*) AS n FROM event_facts GROUP BY fact_id ORDER BY n DESC LIMIT 3`,
  );
  measure(
    '同一条事实被最多几个事件引用',
    spread.length === 0 ? '0' : String(spread[0].n),
  );

  console.log('\n[6] 边表里到底有多少货（这张表检索时从未被查过）');
  const edges = one('SELECT COUNT(*) AS n FROM memory_edges');
  const byType = all('SELECT edge_type, COUNT(*) AS n FROM memory_edges GROUP BY edge_type');
  measure('memory_edges 行数', String(edges));
  measure('按类型', byType.length === 0 ? '（空）' : byType.map((r) => `${r.edge_type} ${r.n}`).join(' / '));

  /*
   * 这条是负向断言：锁定「纯字面通道召回不了字面不重合的问法」这个现状。
   * 一旦以后加了语义通道，它会红 —— 那时该改的是这条断言，不是绕过它，
   * 因为那条改动的意义恰恰在于让这句话不再成立。
   */
  const semantic = recall.find((row) => row.kind === '纯语义，字面不重合');
  check(
    '字面不重合的问法目前召不回（这是待补的空白，不是 bug）',
    semantic !== undefined && !semantic.hit,
    semantic === undefined ? '（没有这条用例）' : `「${semantic.query}」${semantic.hit ? '命中' : '未命中'}`,
  );

  /*
   * 这条原本是第二处已知缺口的负向断言：规则兜底路径认不出「我不吃香菜」
   * 这种否定式偏好 —— `PREFERENCE_MARKERS` 收了「不喜欢」，没收「不吃」。
   *
   * v0.2.26 补上了，所以断言翻面。当时的顾虑仍然成立：「不吃」同时会命中
   * 「今天不吃早饭」这类一次性陈述，把一顿早饭写成永久偏好，往后每次点菜
   * 都被挡一次。所以词表之外还有一条时间判断 —— 一次性那半在新探针
   * probe-extract.mjs 里锁，这里只锁「抽得出来、也搜得到」。
   */
  const coriander = recall.find((row) => row.query === '香菜');
  check(
    '「我不吃香菜」能被规则路径抽出来，并且搜得到',
    coriander !== undefined && coriander.stored > 0 && coriander.hit,
    coriander === undefined ? '（没有这条用例）' : `入库 ${coriander.stored} 条 · ${coriander.hit ? '命中' : '未命中'}`,
  );

  db.close();
} catch (error) {
  fail++;
  console.log(`  FAIL 探针自身抛错 — ${String(error?.stack ?? error).split('\n')[0]}`);
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
  console.log(`\n${fail === 0 ? '全部通过' : `${fail} 项失败`}（${pass} 项断言）`);
  process.exitCode = fail === 0 ? 0 : 1;
}
