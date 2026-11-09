/**
 * 「写侧去上下文化」的分母（§63）。
 *
 * 问题：714 里剩下的未覆盖题，有多少是因为**那一轮省掉了话题名词**——问句说的是
 * 「灯箱」，库里存的是「师傅发来报价了」，两边零字面重合，但话题名词就在前几轮里。
 *
 * 这个脚本只量分母，不改产品：拿基线 jsonl 里未覆盖的 (题, 事实) 对，回到原始
 * 历史，看那条证据所在轮的**前 N 轮**里有没有问句的内容词。有，就说明「把前文
 * 的话题名词补进这一轮」这条写侧规则在原理上够得着；没有，就说明补也没用。
 *
 *   node bench-hmb/diag-anaphora.mjs                       # 默认读 loom-surface-witness.jsonl
 *   node bench-hmb/diag-anaphora.mjs --in loom-surface-cond2.jsonl
 *   node bench-hmb/diag-anaphora.mjs --personas P12,P17 --show
 */
import fs from 'node:fs';
import path from 'node:path';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : process.argv[at + 1];
};
const IN = path.join(BENCH, argOf('in', 'loom-surface-witness.jsonl'));
const PERSONAS = String(argOf('personas', 'P01,P12,P14,P16,P17,P20')).split(',').filter(Boolean);
const WINDOWS = [1, 2, 4, 8];
const SHOW = process.argv.includes('--show');

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const rows = jsonl(IN).filter((row) => PERSONAS.includes(row.persona));
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));
const answerKey = new Map(jsonl(path.join(DS, 'review-only', 'answer-key.jsonl')).map((row) => [row.id, row]));

const key = (text) => String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');

/** 问句与「这一段」共享的最长连续实词串——2 字就够，名字和物件名都在这。 */
function longestRun(question, text) {
  const q = key(question);
  const s = key(text);
  if (q.length < 2 || s.length < 2) return 0;
  let best = 0;
  for (let i = 0; i < q.length; i++) {
    for (let len = Math.min(8, q.length - i); len > best; len--) {
      if (s.includes(q.slice(i, i + len))) {
        best = len;
        break;
      }
    }
  }
  return best;
}

/**
 * 话题名词的候选：问句里长度 ≥2 的连续片段，去掉疑问/人称/时间这些到处都有的。
 * 不追求精确分词——这里要判的是「前文里能不能摸到那个词」，宁可宽一点。
 */
const GENERIC = new Set([
  '什么', '怎么', '哪个', '哪里', '多少', '多久', '我们', '你们', '他们', '她们', '咱们',
  '现在', '后来', '之前', '以前', '今天', '明天', '昨天', '时候', '帮我', '一下', '那个', '这个',
  '那次', '这次', '事情', '东西', '一起', '还是', '就是', '然后', '还有', '以及', '可以', '是不'
]);
function topicPieces(question) {
  const q = key(question);
  const out = new Set();
  for (let len = 4; len >= 2; len--) {
    for (let i = 0; i + len <= q.length; i++) {
      const piece = q.slice(i, i + len);
      if (GENERIC.has(piece)) continue;
      out.add(piece);
    }
  }
  return [...out];
}

/** 这一题的计分事实，连同证据轮号。口径与 surface-coverage 一致。 */
function scoredFacts(id) {
  const keyRow = answerKey.get(id);
  const ev = evidence.get(id);
  if (keyRow === undefined || ev === undefined) return [];
  const want = new Set(keyRow.scored_fact_ids ?? []);
  const quotesByFact = new Map();
  for (const source of ev.sources ?? []) {
    if (typeof source.quote !== 'string') continue;
    const list = quotesByFact.get(source.fact_id) ?? [];
    list.push(source.quote);
    quotesByFact.set(source.fact_id, list);
  }
  const out = [];
  for (const fact of ev.facts ?? []) {
    if (want.size > 0 && !want.has(fact.fact_id)) continue;
    const quotes = quotesByFact.get(fact.fact_id) ?? [];
    if (quotes.length === 0) continue;
    out.push({ factId: fact.fact_id, quotes, turns: fact.evidence_turns ?? [], meaning: fact.meaning ?? '' });
  }
  return out;
}

const histories = new Map();
function history(persona) {
  if (!histories.has(persona)) {
    histories.set(
      persona,
      jsonl(path.join(DS, 'histories', `${persona}.jsonl`)).map((turn) => ({
        n: turn['轮次'],
        user: String(turn['用户消息'] ?? ''),
        assistant: String(turn['助手回复'] ?? '')
      }))
    );
  }
  return histories.get(persona);
}

/* ── 摊开未覆盖的 (题, 事实) 对 ───────────────────────────────────────────── */

const facts = [];
for (const row of rows) {
  const factsOf = scoredFacts(row.id);
  if (factsOf.length === 0) continue;
  const seen = new Map((row.facts ?? []).map((fact) => [fact.factId, fact]));
  for (const fact of factsOf) {
    const got = seen.get(fact.factId);
    if (got === undefined) continue;
    const best = Math.max(got.blockR10 ?? 0, got.toolR10 ?? 0);
    if (best >= 0.8) continue;
    facts.push({ row, fact, best });
  }
}
const questions = new Set(facts.map((item) => item.row.id));

/* ── 逐条判：话题名词在不在前文 ───────────────────────────────────────────── */

const hist = (persona) => history(persona);
const turnOf = (persona, n) => hist(persona).find((turn) => turn.n === n) ?? null;

const report = [];
const stats = {
  facts: facts.length,
  questions: questions.size,
  inTurn: 0, // 原话确实落在证据轮里
  zeroOverlap: 0, // 原话与问句共享 <2 字
  recover: Object.fromEntries(WINDOWS.map((w) => [w, 0])),
  noTopic: 0, // 前 N 轮里一个话题词都摸不到
  examples: []
};

for (const item of facts) {
  const { row, fact } = item;
  const persona = row.persona;
  const quote = fact.quotes[0] ?? '';
  const turnNo = fact.turns[0];
  const turn = turnNo === undefined ? null : turnOf(persona, turnNo);
  const turnText = turn === null ? '' : `${turn.user}\n${turn.assistant}`;
  const inTurn = turn !== null && key(turnText).includes(key(quote).slice(0, Math.min(12, key(quote).length)));
  if (inTurn) stats.inTurn += 1;

  const overlap = longestRun(row.question, turnText);
  if (overlap < 2) stats.zeroOverlap += 1;

  const pieces = topicPieces(row.question);
  const entry = { id: row.id, factId: fact.factId, turn: turnNo, overlap, windows: {}, pieces: [] };
  let any = false;
  for (const w of WINDOWS) {
    const from = (turnNo ?? 1) - w;
    const before = hist(persona).filter((one) => one.n >= from && one.n < (turnNo ?? 1));
    const hay = key(before.map((one) => `${one.user}${one.assistant}`).join('\n'));
    const hit = pieces.filter((piece) => !key(turnText).includes(piece) && hay.includes(piece));
    entry.windows[w] = hit.length;
    if (hit.length > 0) {
      any = true;
      if (entry.pieces.length === 0) entry.pieces = hit.slice(0, 4);
    }
  }
  if (any) {
    for (const w of WINDOWS) if (entry.windows[w] > 0) stats.recover[w] += 1;
  } else stats.noTopic += 1;

  report.push(entry);
  if (SHOW && item.best < 0.5 && (entry.pieces.length > 0 || stats.examples.length < 6)) {
    stats.examples.push({
      id: row.id,
      turn: turnNo,
      note: inTurn ? '' : '原话不在此轮',
      overlap,
      pieces: entry.pieces,
      question: row.question.replace(/\n/gu, ' / '),
      quote: quote.replace(/\n/gu, ' / ').slice(0, 70)
    });
  }
}

/* ── 还是按题去重再看一遍：一道题只要有一条事实够得着就算够得着 ───────────── */

const byQuestion = new Map();
for (const entry of report) {
  const list = byQuestion.get(entry.id) ?? [];
  list.push(entry);
  byQuestion.set(entry.id, list);
}
const qStats = Object.fromEntries(WINDOWS.map((w) => [w, 0]));
let qNone = 0;
for (const list of byQuestion.values()) {
  let any = false;
  for (const w of WINDOWS) {
    if (list.some((entry) => entry.windows[w] > 0)) {
      qStats[w] += 1;
      any = true;
    }
  }
  if (!any) qNone += 1;
}

const pct = (a, b) => (b === 0 ? '0.0' : ((a / b) * 100).toFixed(1));
console.log(`\n基线：${path.basename(IN)}   未覆盖：${stats.questions} 题 / ${stats.facts} 个计分事实`);
console.log(`原话确实落在证据轮里：${stats.inTurn}/${stats.facts}（${pct(stats.inTurn, stats.facts)}%）`);
console.log(`证据轮与问句共享 <2 字：${stats.zeroOverlap}/${stats.facts}（${pct(stats.zeroOverlap, stats.facts)}%）`);
console.log('\n话题词能从「证据轮之前的 N 轮」里摸到（事实口径）：');
for (const w of WINDOWS) console.log(`  前 ${String(w).padStart(2)} 轮：${String(stats.recover[w]).padStart(3)} / ${stats.facts}  (${pct(stats.recover[w], stats.facts)}%)`);
console.log(`  一个都摸不到：${stats.noTopic} / ${stats.facts}  (${pct(stats.noTopic, stats.facts)}%)`);
console.log('\n按题去重（任一事实够得着即算）：');
for (const w of WINDOWS) console.log(`  前 ${String(w).padStart(2)} 轮：${String(qStats[w]).padStart(3)} / ${byQuestion.size}  (${pct(qStats[w], byQuestion.size)}%)`);
console.log(`  一个都摸不到：${qNone} / ${byQuestion.size}  (${pct(qNone, byQuestion.size)}%)`);

if (SHOW) {
  console.log('\n样本：');
  for (const one of stats.examples) {
    console.log(`\n[${one.id}] 轮 ${one.turn} ${one.note}  最长共享 ${one.overlap} 字`);
    console.log(`  Q: ${one.question}`);
    console.log(`  A: ${one.quote}`);
    console.log(`  话题词在前文：${one.pieces.join('、') || '（无）'}`);
  }
}

fs.writeFileSync(path.join(BENCH, 'diag-anaphora.json'), JSON.stringify({ stats, qStats, report }, null, 1));
console.log(`\n明细：${path.join(BENCH, 'diag-anaphora.json')}`);
