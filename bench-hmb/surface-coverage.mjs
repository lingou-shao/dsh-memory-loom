/**
 * 全卷扫描：一道题需要的那段话，在 loom 交给模型的东西里到底有没有。
 *
 * 与 `retrieval-hit.mjs` 的区别是覆盖面的口径：
 *   - retrieval-hit 只看「某条结果的来源区间有没有盖住证据轮」，是**位置**口径，
 *     位置对了内容也可能不在（区间盖住了、抽出来的却是残句）。
 *   - 这个脚本用证据原话本身当标准答案，量**内容**是否出现在三个面上：常驻块、
 *     搜索结果、模型实际会展开的那两条指针。
 *
 * 三个人物 × 全部时点：按 cutoff 升序增量灌库，走到一道题的截止点就当场取三面。
 * 这样一次 pass 覆盖全卷 714 题，不必每个时点重建一次库。
 *
 * 判据：先按 `answer-key.jsonl` 的 `scored_fact_ids` 挑出真正计分的事实，再拿
 * `evidence.jsonl` 里对应 fact 的原话，切成 10 字窗口，看有多少窗口在这些面上
 * 出现过（`r10`）。`r10 >= 0.8` 记作「这一条的事实内容到了」。粗粒度的大词覆盖
 * （`r2`，二元组）另外记一列，用来分辨「原文到了」和「只有几个词撞上了」。
 *
 *   node surface-coverage.mjs                  # 六个人物，全时点
 *   node surface-coverage.mjs --personas P01,P17
 *   node surface-coverage.mjs --limit-new 0    # 不限时点（默认不限）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const OUT = path.join(BENCH, process.env.HMB_OUT ?? 'loom-surface.jsonl');
const SUMMARY = path.join(BENCH, process.env.HMB_SUMMARY ?? 'loom-surface-summary.json');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const LIMIT = Number(argOf('limit', 10));
const EXPANDS = Number(argOf('expands', 2));
const PERSONAS = String(argOf('personas', 'P01,P12,P14,P16,P17,P20')).split(',').filter(Boolean);
/** 对照臂：关掉 0.2.37 的原话通道，用来量新通道到底贡献了多少覆盖面。 */
const RETRIEVAL = {
  ...(process.argv.includes('--no-raw') ? { rawSearch: false } : {}),
  // 闸门扫描用：`--relax 0` 关掉「问句覆盖率」这道闸，看召回能放开到多少。
  ...(process.argv.includes('--relax') ? { relaxMinOverlap: Number(argOf('relax', 0.25)) } : {}),
  // 原话通道什么时候启动。默认「派生层少于 3 条」——闸门一放开，它就永远不启动了。
  ...(process.argv.includes('--rawbelow') ? { relaxBelow: Number(argOf('rawbelow', 3)) } : {}),
  // 闸门的第三条旁路（§71）：共享 N 个内容词就放行，不按问句比例算。
  ...(process.argv.includes('--solid') ? { solidOverlap: Number(argOf('solid', 3)) } : {})
};

for (const need of [
  path.join(DS, 'exam-inputs.jsonl'),
  path.join(BENCH, 'grading', 'evidence.jsonl'),
  path.join(DS, 'review-only', 'answer-key.jsonl')
]) {
  if (!fs.existsSync(need)) {
    console.error(`找不到题库：${need}`);
    process.exit(1);
  }
}

const jsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const exams = jsonl(path.join(DS, 'exam-inputs.jsonl'));
const evidence = new Map(jsonl(path.join(BENCH, 'grading', 'evidence.jsonl')).map((row) => [row.id, row]));
const answerKey = new Map(jsonl(path.join(DS, 'review-only', 'answer-key.jsonl')).map((row) => [row.id, row]));

/** 摘掉空白与标点：全角引号、省略号不该决定「这句在不在」。 */
function key(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 一个字符串的全部 n 字窗口，做成集合，之后查成员是 O(1)。 */
function grams(text, n) {
  const s = key(text);
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

/** 原话有多少比例的 10 字窗口出现在文面上——0 表示一个字都没照到。 */
function ratio(textGramSet, quote, n) {
  const s = key(quote);
  if (s.length < n) return textGramSet.has(s) ? 1 : 0;
  let hit = 0;
  let total = 0;
  for (let i = 0; i + n <= s.length; i++) {
    total += 1;
    if (textGramSet.has(s.slice(i, i + n))) hit += 1;
  }
  return total === 0 ? 0 : hit / total;
}

/** 这道题真正计分的那几条事实，连同它们的证据原话与轮号。 */
function scoredFacts(questionId) {
  const keyRow = answerKey.get(questionId);
  const ev = evidence.get(questionId);
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
    out.push({
      factId: fact.fact_id,
      meaning: fact.meaning ?? '',
      quotes,
      turns: fact.evidence_turns ?? []
    });
  }
  return out;
}

function refsOf(text) {
  return [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
}

function history(persona) {
  return fs.readFileSync(path.join(DS, 'histories', `${persona}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

const rows = [];
const summaryOf = (list) => {
  const n = list.length;
  const pct = (value) => (n === 0 ? 0 : Number(((value / n) * 100).toFixed(1)));
  const covered = (field) => list.filter((item) => item.facts.length > 0 && item.facts.every((fact) => fact[field] >= 0.8)).length;
  return {
    questions: n,
    blockCovered: covered('blockR10'),
    blockPct: pct(covered('blockR10')),
    searchCovered: covered('searchR10'),
    searchPct: pct(covered('searchR10')),
    toolCovered: covered('toolR10'),
    toolPct: pct(covered('toolR10')),
    /** 三面并起来——模型手上最大的信息量。 */
    anyCovered: list.filter((item) => item.facts.length > 0 && item.facts.every((fact) => Math.max(fact.blockR10, fact.toolR10) >= 0.8)).length,
    anyPct: pct(list.filter((item) => item.facts.length > 0 && item.facts.every((fact) => Math.max(fact.blockR10, fact.toolR10) >= 0.8)).length),
    blockTokensMedian: median(list.map((item) => item.blockTokens)),
    locatedPct: pct(list.filter((item) => item.located).length)
  };
};
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

for (const persona of PERSONAS) {
  const mine = exams.filter((exam) => exam.persona === persona).sort((a, b) => a.cutoff_turn - b.cutoff_turn);
  if (mine.length === 0) continue;
  const turns = history(persona);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `surf-${persona}-`));
  const dbPath = path.join(dir, 'loom.db');

  const realNow = Date.now;
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;

  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 }, retrieval: RETRIEVAL } });
  const SID = `surf-${persona}`;
  let previous = null;
  let cursor = 0;
  let done = 0;
  const startedAt = Date.now();
  try {
    for (const exam of mine) {
      for (; cursor < turns.length && turns[cursor]['轮次'] <= exam.cutoff_turn; cursor++) {
        const turn = turns[cursor];
        const at = Date.parse(turn['逻辑时间']);
        clock = at;
        const gap = previous === null ? 2 * MIN : Math.max(MIN / 2, at - previous);
        await loom.turn(SID, turn['用户消息'], turn['助手回复'], { at });
        previous = at;
      }
      clock = Math.max(clock, Date.parse(exam.now));
      await loom.ready?.();
      const block = String(loom.memoryBlock(SID));
      const search = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, SID));
      const refs = refsOf(search);

      /*
       * 模拟模型：只有看到指针才可能去展开，所以按结果的打印顺序取前两条。
       * 按「哪条盖住了证据轮」来挑就是拿答案挑，量出来的不是产品。
       */
      const expanded = [];
      for (const ref of refs.slice(0, EXPANDS)) {
        try {
          expanded.push({ ref, text: String(await loom.call('memory_expand', { ref: `#${ref}` }, SID)) });
        } catch (error) {
          expanded.push({ ref, text: '', error: String(error?.message ?? error) });
        }
      }

      const blockG10 = grams(block, 10);
      const blockG2 = grams(block, 2);
      const searchG10 = grams(search, 10);
      const toolText = [search, ...expanded.map((one) => one.text)].join('\n');
      const toolG10 = grams(toolText, 10);
      const toolG2 = grams(toolText, 2);

      const facts = scoredFacts(exam.id).map((fact) => {
        const best = (set10, set2) => {
          let r10 = 0;
          let r2 = 0;
          for (const quote of fact.quotes) {
            r10 = Math.max(r10, ratio(set10, quote, 10));
            r2 = Math.max(r2, ratio(set2, quote, 2));
          }
          return [Number(r10.toFixed(3)), Number(r2.toFixed(3))];
        };
        const [blockR10, blockR2] = best(blockG10, blockG2);
        const [searchR10, searchR2] = best(searchG10, blockG2);
        const [toolR10, toolR2] = best(toolG10, toolG2);
        return { factId: fact.factId, turns: fact.turns, blockR10, blockR2, searchR10, searchR2, toolR10, toolR2 };
      });

      const keyRow = answerKey.get(exam.id) ?? {};
      rows.push({
        id: exam.id,
        persona,
        kind: keyRow.kind ?? null,
        tags: keyRow.content_tags ?? [],
        intervalDays: keyRow.interval_days ?? null,
        cutoffTurn: exam.cutoff_turn,
        now: exam.now,
        question: exam.question,
        blockTokens: Math.ceil(block.length / 1.6),
        blockChars: block.length,
        blockLines: block.split('\n').filter((line) => line.startsWith('- ')).length,
        searchChars: search.length,
        refs,
        rawRefs: refs.filter((ref) => ref.startsWith('L')).length,
        expands: expanded.map((one) => one.ref),
        located: refs.length > 0,
        facts,
        /** 原样留着，答题样本直接从这儿取，不再重跑一遍灌库。 */
        context: { block, search, expanded }
      });

      done += 1;
      if (done % 25 === 0) {
        const rate = ((Date.now() - startedAt) / done / 1000).toFixed(2);
        process.stdout.write(`${persona} ${done}/${mine.length} · ${rate}s/题\n`);
      }
    }
  } finally {
    loom.dispose();
    Date.now = realNow;
  }
  process.stdout.write(`${persona} 完成 ${mine.length} 题（库 ${dbPath}）\n`);
}

fs.writeFileSync(OUT, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

const rate = (part, total) => (total === 0 ? 0 : Number(((part / total) * 100).toFixed(1)));
const bucket = (items, pick) => {
  const map = new Map();
  for (const item of items) {
    const name = pick(item);
    const list = map.get(name) ?? [];
    list.push(item);
    map.set(name, list);
  }
  return [...map.entries()].sort((a, b) => b[1].length - a[1].length).map(([name, list]) => ({
    name,
    ...summaryOf(list)
  }));
};

const all = rows.filter((row) => row.facts.length > 0);
const summary = {
  generatedAt: new Date().toISOString(),
  limit: LIMIT,
  expands: EXPANDS,
  retrieval: RETRIEVAL,
  total: rows.length,
  withFacts: all.length,
  overall: summaryOf(all),
  byInterval: bucket(all, (row) => `d${String(row.intervalDays).padStart(2, '0')}`),
  byTag: bucket(all, (row) => (row.tags[0] ?? '（无）')),
  byKind: bucket(all, (row) => row.kind ?? '（无）'),
  byPersona: bucket(all, (row) => row.persona)
};
fs.writeFileSync(SUMMARY, JSON.stringify(summary, null, 1) + '\n');

console.log('');
console.log(`题 ${summary.total}（有计分事实 ${summary.withFacts}）· 搜索取 ${LIMIT} 条 · 展开前 ${EXPANDS} 条指针`);
console.log(`块内覆盖原话   ${summary.overall.blockCovered}/${summary.withFacts} = ${summary.overall.blockPct}%`);
console.log(`搜索命中覆盖   ${summary.overall.searchCovered}/${summary.withFacts} = ${summary.overall.searchPct}%`);
console.log(`工具面覆盖     ${summary.overall.toolCovered}/${summary.withFacts} = ${summary.overall.toolPct}%`);
console.log(`两面并起来     ${summary.overall.anyCovered}/${summary.withFacts} = ${summary.overall.anyPct}%`);
console.log('');
for (const group of [['按距离', summary.byInterval], ['按考点', summary.byTag.slice(0, 12)], ['按人物', summary.byPersona]]) {
  console.log(`${group[0]}：`);
  for (const one of group[1]) {
    console.log(`  ${one.name.padEnd(12)} n=${String(one.questions).padStart(3)}  块 ${String(one.blockPct).padStart(5)}%  工具 ${String(one.toolPct).padStart(5)}%  并 ${String(one.anyPct).padStart(5)}%`);
  }
}
console.log(`\n明细 ${OUT}\n汇总 ${SUMMARY}`);
