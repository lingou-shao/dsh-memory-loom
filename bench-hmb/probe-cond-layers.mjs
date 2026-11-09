/**
 * 带条件/期限考点 5 个未覆盖时点缺在哪一层（§65）。
 *
 * 与 `probe-plan-layers.mjs` / `probe-plan-pool.mjs` 的分工一样，只是把四层摊在
 * 一个脚本里：L1 l0 有没有那一轮 → L2 派生层有没有那一句（含 aliases）→ L3 池里
 * 排第几 → L4 模型实际看到的两条指针是什么。判据必须是「先看层，再改」，否则又
 * 会落在 §56/§58/§62 那批「加候选」的零和上。
 *
 *   node bench-hmb/probe-cond-layers.mjs            # 全部 5 个时点
 *   node bench-hmb/probe-cond-layers.mjs --only P17
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : '';

/**
 * `quote` 用来在 l0 里定位金标那句（子串即可）；`probes` 是问句里能拿去做 FTS 的词，
 * 取「问句自己有的」而不是金标里的，否则量的是答案能不能搜到答案。
 */
const CASES = [
  {
    qid: 'P16-CASE-batch-music/d03',
    quote: '只有落雨或者阴天听着才对味',
    probes: ['天阴', '放', '歌', '路子']
  },
  {
    qid: 'P16-CASE-batch-music/d15',
    quote: '只有落雨或者阴天听着才对味',
    probes: ['雨刚', '吧台', '收完', '对味']
  },
  {
    qid: 'P16-CASE-batch-whisky/d15',
    quote: '我只有雨夜喝一小杯泥煤威士忌',
    probes: ['落雨', '盘点', '泥煤', '规矩']
  },
  {
    qid: 'P17-CASE-002/d15',
    quote: '不过下午三点后就不喝了',
    probes: ['提神', '咖啡', '合适']
  },
  {
    qid: 'P17-CASE-002/d45',
    quote: '不过下午三点后就不喝了',
    probes: ['提神', '咖啡', '合适']
  }
];

const head = (text, n = 46) => String(text ?? '').replace(/\n/gu, ' ').slice(0, n);

for (const item of CASES) {
  if (only !== '' && !item.qid.includes(only)) continue;
  const exam = exams.find((one) => one.id === item.qid);
  if (exam === undefined) {
    console.log(`\n[${item.qid}] 题库里没有这道题`);
    continue;
  }
  const turns = jsonl(path.join(DS, 'histories', `${exam.persona}.jsonl`));
  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cond-'));
  const dbPath = path.join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
  for (const turn of turns) {
    if (turn['轮次'] > exam.cutoff_turn) break;
    clock = Date.parse(turn['逻辑时间']);
    await loom.turn('x', turn['用户消息'], turn['助手回复'], { at: clock });
  }
  Date.now = realNow;
  const db = new DatabaseSync(dbPath);

  console.log(`\n${'='.repeat(78)}\n[${item.qid}] 轮≤${exam.cutoff_turn}`);
  console.log(`Q: ${String(exam.question).replace(/\n/gu, ' | ')}`);

  /* L1 — l0 里那句在不在。 */
  const gold = db.prepare('SELECT id, turn, role, text FROM l0 WHERE text LIKE ?').all(`%${item.quote}%`);
  console.log(`\n L1 l0：命中 ${gold.length} 轮 → ${gold.map((row) => `t${row.turn}/${row.role}#${row.id}`).join(', ') || '（无）'}`);
  for (const row of gold.slice(0, 2)) console.log(`    t${row.turn}: ${head(row.text, 80)}`);
  const goldIds = gold.map((row) => row.id);

  /* L2 — 派生层：text / aliases / tokens 任一命中。 */
  const columns = db.prepare('PRAGMA table_info(facts)').all().map((row) => row.name);
  const keyCol = item.quote.slice(0, 8);
  const facts = db
    .prepare('SELECT * FROM facts WHERE text LIKE ? OR aliases LIKE ? OR tokens LIKE ?')
    .all(`%${keyCol}%`, `%${keyCol}%`, `%${keyCol}%`);
  console.log(`\n L2 facts：共 ${db.prepare('SELECT COUNT(*) AS n FROM facts').get().n} 行，命中「${keyCol}」${facts.length} 行`);
  for (const row of facts.slice(0, 6)) {
    console.log(`    #${row.id} kind=${row.kind} src=${row.source ?? ''} srcIds=${row.source_ids ?? ''}`);
    console.log(`      text=${head(row.text, 90)}`);
    console.log(`      aliases=${head(row.aliases, 120)}`);
  }
  for (const table of ['preferences', 'events', 'plans']) {
    if (!columns.length) break;
    const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (exists === undefined) continue;
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const hit = rows.filter((row) => String(row.text ?? '').includes(keyCol));
    if (rows.length === 0) continue;
    console.log(`    ${table}：${rows.length} 行，命中 ${hit.length}`);
    for (const row of hit.slice(0, 4)) console.log(`      #${row.id} ${head(row.text, 80)} aliases=${head(row.aliases, 60)}`);
  }

  /* L2.5 — facts 侧：严格（AND）与放宽（OR 前 12）两趟，目标行各排第几。 */
  const bigrams = (text) => {
    const out = [];
    for (const run of String(text).matchAll(/[\u3400-\u9fff]+/gu)) {
      const chars = [...run[0]];
      for (let i = 0; i + 1 < chars.length; i++) out.push(`${chars[i]}${chars[i + 1]}`);
    }
    for (const run of String(text).matchAll(/[A-Za-z]+/gu)) out.push(run[0].toLowerCase());
    for (const run of String(text).matchAll(/[0-9]+/gu)) out.push(run[0]);
    return out;
  };
  const targetIds = facts.map((row) => row.id);
  for (const [label, expr] of [
    ['严格 AND', [...new Set(bigrams(exam.question))].slice(0, 24).map((one) => `"${one}"`).join(' ')],
    ['放宽 OR12', [...new Set(bigrams(exam.question))].slice(0, 12).map((one) => `"${one}"`).join(' OR ')]
  ]) {
    let hits = [];
    try {
      hits = db
        .prepare(
          `SELECT f.id, bm25(facts_fts, 5.0, 1.0, 2.0, 1.0) AS s
           FROM facts_fts JOIN facts f ON f.id = facts_fts.rowid
           WHERE facts_fts MATCH ? AND f.identity_id = ? AND f.status IN ('active','disputed') AND f.isolated = 0
           ORDER BY bm25(facts_fts, 5.0, 1.0, 2.0, 1.0) LIMIT 12`
        )
        .all(expr, db.prepare('SELECT id FROM identities LIMIT 1').get()?.id ?? '');
    } catch (error) {
      hits = [];
      console.log(`  L2.5 ${label} 查询失败：${String(error?.message ?? error).slice(0, 50)}`);
    }
    const rank = hits.findIndex((row) => targetIds.includes(row.id));
    console.log(` L2.5 facts ${label}：跑出 ${hits.length} 行；目标${rank === -1 ? '不在前 12' : `排第 ${rank + 1}`}${hits.length ? ` ‖ ${hits.slice(0, 3).map((row) => `#${row.id}`).join(' ')}` : ''}`);
  }

  /* L2.6 — 闸门：命中行能不能过 relaxMinOverlap / aliasHit 这一关。 */
  const queryTokens = new Set(bigrams(exam.question));
  for (const row of facts) {
    const rowTokens = new Set([...bigrams(row.text ?? ''), ...bigrams(row.aliases ?? '')]);
    const shared = [...queryTokens].filter((one) => rowTokens.has(one));
    const containment = queryTokens.size === 0 ? 0 : shared.length / queryTokens.size;
    const aliasShared = [...queryTokens].filter((one) => new Set(bigrams(row.aliases ?? '')).has(one));
    console.log(
      ` L2.6 #${row.id} status=${row.status} isolated=${row.isolated} 覆盖=${containment.toFixed(3)}（${shared.join(',') || '无'}）别名命中=${aliasShared.join(',') || '无'}`
    );
  }

  /* L3 — 池：问句自己的词做 FTS，金标轮排第几。 */
  for (const probe of item.probes) {
    let hits = [];
    try {
      hits = db
        .prepare(
          `SELECT l.id, l.turn, l.role, substr(l.text, 1, 20) AS head
           FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid
           WHERE l0_fts MATCH ? ORDER BY bm25(l0_fts, 1.0, 1.0) LIMIT 15`
        )
        .all(`"${probe}"`);
    } catch {
      hits = [];
    }
    const rank = hits.findIndex((row) => goldIds.includes(row.id));
    console.log(
      ` L3 词「${probe}」命中 ${hits.length}${hits.length === 15 ? '+' : ''} 行；金标${rank === -1 ? '不在前 15' : `排第 ${rank + 1}`}` +
        `${hits.length ? ` ‖ ${hits.slice(0, 3).map((row) => `t${row.turn}:${head(row.head, 14)}`).join(' ')}` : ''}`
    );
  }

  /* L4 — 模型实际看到的指针。 */
  const search = String(await loom.call('memory_search', { query: exam.question, limit: 10 }, 'x'));
  console.log(`\n L4 memory_search（${search.length} 字）:`);
  console.log(search.split('\n').slice(0, 8).map((line) => `    ${head(line, 100)}`).join('\n'));
  const refs = [...new Set([...search.matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
  for (const ref of refs.slice(0, 2)) {
    const text = String(await loom.call('memory_expand', { ref: `#${ref}` }, 'x'));
    console.log(`    展开 #${ref} → ${head(text, 110)}`);
  }

  db.close();
  loom.dispose?.();
}
