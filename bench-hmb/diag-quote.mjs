/**
 * 原话通道的候选长什么样。
 *
 * `memory_search` 只返回挑完的那几条，看不到「挑之前有什么」。这道工序要问的是
 * 一个很具体的问题：正确答案那一轮，到底进没进 bm25 的候选集？没进，是召回表达
 * 式的问题（词没进查询）；进了但没被选中，是挑选策略的问题（两条都花在同一时刻）。
 * 两者改法完全不同，所以得把中间层摊开。
 *
 *   node diag-quote.mjs --persona P17 --cutoff 202 --q "你答应写的渡口夜雾那段后来哪天交了？"
 *   node diag-quote.mjs --exam P17-CASE-008/d45
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const exams = JSON.parse(`[${fs.readFileSync(path.join(DS, 'exam-inputs.jsonl'), 'utf8').trim().split('\n').join(',')}]`);
const evidence = new Map(
  fs.readFileSync(path.join(BENCH, 'grading', 'evidence.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .map((row) => [row.id, row])
);

const examId = argOf('exam', null);
const exam = examId === null ? null : exams.find((one) => one.id === examId);
if (examId !== null && exam === undefined) {
  console.error(`没有这道题：${examId}`);
  process.exit(1);
}
const persona = exam?.persona ?? argOf('persona', 'P17');
const cutoff = Number(exam?.cutoff_turn ?? argOf('cutoff', 202));
const question = exam?.question ?? argOf('q', '');

/** 和 `lib/index.js` 的 `tokensOf` 同一套规则：CJK 二元组 + 拉丁词 + 数字串。 */
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const LATIN_RUN = /[A-Za-z]+/gu;
const DIGIT_RUN = /\d+/gu;
function tokensOf(text) {
  const tokens = [];
  for (const match of String(text).matchAll(CJK_RUN)) {
    const chars = [...match[0]];
    for (let index = 0; index < chars.length - 1; index++) tokens.push(`${chars[index]}${chars[index + 1]}`);
    if (chars.length === 1) tokens.push(chars[0]);
  }
  for (const match of String(text).matchAll(LATIN_RUN)) tokens.push(match[0].toLowerCase());
  for (const match of String(text).matchAll(DIGIT_RUN)) tokens.push(match[0]);
  return tokens;
}

const turns = fs.readFileSync(path.join(DS, 'histories', `${persona}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `diag-${persona}-`));
const dbPath = path.join(dir, 'loom.db');

const realNow = Date.now;
let clock = Date.parse(turns[0]['逻辑时间']);
Date.now = () => clock;
const loom = createLoom({
  dbPath,
  config: {
    consolidation: { triggerTokens: 0 },
    ...(process.argv.includes('--rawhits') || process.argv.includes('--rawbelow')
      ? {
          retrieval: {
            ...(process.argv.includes('--rawhits') ? { rawHits: Number(argOf('rawhits', 2)) } : {}),
            ...(process.argv.includes('--rawbelow') ? { relaxBelow: Number(argOf('rawbelow', 3)) } : {})
          }
        }
      : {})
  }
});
const SID = `diag-${persona}`;
let previous = null;
let cursor = 0;
try {
  for (; cursor < turns.length && turns[cursor]['轮次'] <= cutoff; cursor++) {
    const row = turns[cursor];
    const at = Date.parse(row['逻辑时间']);
    clock = at;
    const gap = previous === null ? 2 * MIN : Math.max(MIN / 2, at - previous);
    await loom.turn(SID, row['用户消息'], row['助手回复'], { gapMs: gap });
    previous = at;
  }
  clock = previous ?? clock;

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const turnOf = new Map();
  for (const row of db.prepare('SELECT id, turn, role, text FROM l0').all()) turnOf.set(row.id, row);

  const tokens = [...new Set(tokensOf(question))];
  const expr = tokens.slice(0, 200).map((token) => `"${token}"`).join(' OR ');
  const rows = db.prepare(`
    SELECT l.id, l.turn, l.role, l.text, bm25(l0_fts, 1.0, 1.0) AS bm25
    FROM l0_fts JOIN l0 l ON l.id = l0_fts.rowid
    WHERE l0_fts MATCH ?
    ORDER BY bm25 LIMIT 40
  `).all(expr);

  const evidenceRow = evidence.get(exam?.id ?? '');
  const anchors = new Set();
  for (const fact of evidenceRow?.facts ?? []) for (const turn of fact.evidence_turns ?? []) anchors.add(turn);
  for (const source of evidenceRow?.sources ?? []) if (Number.isFinite(source.turn)) anchors.add(source.turn);

  console.log(`题：${exam?.id ?? '(手输)'}  人物 ${persona}  截止 ${cutoff}`);
  console.log(`问：${question}`);
  console.log(`二元组 ${tokens.length} 个 · FTS 命中 ${rows.length} 行${anchors.size > 0 ? ` · 证据轮 ${[...anchors].join(',')}` : ''}`);
  console.log('');
  const hitTokens = (text) => {
    const own = new Set(tokensOf(text));
    return tokens.filter((token) => own.has(token));
  };
  for (const row of rows) {
    const mark = anchors.has(row.turn) ? '★' : ' ';
    const shared = hitTokens(row.text);
    console.log(`${mark} #L${row.id} t${String(row.turn).padStart(3)} ${row.role.padEnd(9)} bm25 ${row.bm25.toFixed(2)}  命中 ${shared.length}/${tokens.length}  ${shared.slice(0, 8).join('/')}`);
    console.log(`   ${String(row.text).replace(/\n/g, ' ').slice(0, 110)}`);
  }

  const final = String(await loom.call('memory_search', { query: question, limit: 10 }, SID));
  console.log('\n=== memory_search 最终给出 ===');
  console.log(final);

  if (process.argv.includes('--expand')) {
    const refs = [...new Set([...final.matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
    for (const ref of refs.slice(0, Number(process.env.HMB_EXPANDS ?? 3))) {
      console.log(`\n--- #${ref}`);
      console.log(String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)));
    }
  }

  if (process.argv.includes('--facts')) {
    const rows = db.prepare('SELECT id, kind, text, salience, confidence, created_at, domain, subject, attr, value, status FROM facts WHERE status IN (\'active\',\'superseded\') ORDER BY created_at DESC').all();
    console.log(`\n=== facts（${rows.length} 条，按时间倒序；槽位列 【主体·属性=值】） ===`);
    for (const row of rows) {
      const slot = row.subject && row.attr ? `  【${row.subject}·${row.attr}=${row.value ?? '∅'}】` : '';
      console.log(`#F${row.id} ${row.kind.padEnd(6)} sal ${Number(row.salience).toFixed(2)} ${new Date(Number(row.created_at)).toISOString().slice(0, 16)} ${String(row.text).replace(/\n/g, ' ').slice(0, 62)}${slot}`);
    }
    const prefs = db.prepare('SELECT id, text, created_at FROM preferences ORDER BY created_at DESC LIMIT 20').all();
    console.log(`\n=== preferences（最近 ${prefs.length} 条） ===`);
    for (const row of prefs) console.log(`#P${row.id} ${new Date(Number(row.created_at)).toISOString().slice(0, 16)} ${String(row.text).replace(/\n/g, ' ').slice(0, 80)}`);
  }
  db.close();
} finally {
  loom.dispose();
  Date.now = realNow;
}
