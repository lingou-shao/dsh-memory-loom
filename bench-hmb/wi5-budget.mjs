/**
 * WI-5：记忆块到底压不压制第二次工具调用。
 *
 * 假设是「块够用，模型就不调工具」。没有模型可测行为，所以这里测它的前提：
 * **块里的信息相对「一次搜索能拿到的信息」已经饱和到什么程度**。
 *
 * 三个量：
 *   替代率   —— 这题搜索结果 top-10 里，有多少条已经出现在块里。替代率高说明
 *               模型确实没有理由再搜；低说明块和搜索互补，缩块只会丢信息。
 *   条目覆盖 —— 块装下库里多少条候选。
 *   块用量   —— 实际用掉的 token（配置是上限，不是实际值）。
 *
 * 之所以用「一次召回 + 多次渲染」而不是每题重灌，是因为预算只影响渲染层：
 * 同一个库、同一时点、同一批候选，只换 `budgetTokens`，差异就只剩预算。
 *
 * 语料用 chat-memory-bench 的真实 histories（每人约 390 轮、有逻辑时间），
 * 题面用同一份题库里该 cutoff 之下的真实问题——自己编问题等于自己出卷自己判。
 *
 * 时钟要换。语料是 2026 年 4 月起的对话，而 harness 不注入 `now`，插件内部
 * 一律读 `Date.now()`：照真实时间跑，整条时间线会落在今天，「明天」「下周」
 * 全部锚错，衰减和计划到期跟着一起错，测出来的块不是这份语料该有的块。
 * 换全局 `Date.now` 是本仓库已有的手法（`createLoomWithTimers` 拦 `setInterval`），
 * 不改产品代码。
 *
 *   node probe-wi5-budget.mjs            # 默认 6 个时点
 *   node probe-wi5-budget.mjs --quick    # 只跑 1 个时点，用于确认链路
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';
import { estimateTokens } from '../lib/index.js';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const OUT = path.join(BENCH, 'loom-wi5.json');
const BUDGETS = [2000, 1500, 1000, 800, 600, 400];

/** 取每个人物题数最多的那个时点——样本太小的话替代率就是在测噪声。 */
const CASES = process.argv.includes('--quick')
  ? [['P01', 268]]
  : [
      ['P01', 268],
      ['P01', 235],
      ['P17', 333],
      ['P17', 202],
      ['P16', 205],
      ['P12', 220],
      ['P20', 232]
    ];

const HISTORY = (persona) => path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2', 'histories', `${persona}.jsonl`);
const EXAMS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2', 'exam-inputs.jsonl');

if (!fs.existsSync(EXAMS)) {
  console.error(`找不到题库：${EXAMS}`);
  console.error('设 HMB_DIR 指向 chat-memory-bench 根目录。');
  process.exit(1);
}

const exams = fs.readFileSync(EXAMS, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

/** 摘掉空白与标点，只留下能对上的字——摘要和块都不会原样保留标点。 */
function key(text) {
  return String(text).replace(/[\s\p{P}\p{S}]/gu, '');
}

function rows(persona) {
  return fs.readFileSync(HISTORY(persona), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/** 把库复制成一份可独立打开的副本；WAL 里未落盘的部分也要带上。 */
function cloneDb(src, dst) {
  const db = new DatabaseSync(src, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${dst.replace(/\\/gu, '/')}'`);
  } finally {
    db.close();
  }
}

/** 库里所有可召回条目的 id → 一组归一化文本（事件同时留标题与摘要）。 */
function catalog(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const map = new Map();
  try {
    for (const row of db.prepare("SELECT id, text FROM facts WHERE status IN ('active','disputed')").all()) {
      map.set(`F${row.id}`, [key(row.text)]);
    }
    for (const row of db.prepare('SELECT id, title, summary FROM events').all()) {
      map.set(`E${row.id}`, [key(row.title), key(row.summary)].filter((t) => t.length >= 4));
    }
    for (const row of db.prepare('SELECT id, text FROM preferences WHERE active = 1').all()) {
      map.set(`P${row.id}`, [key(row.text)]);
    }
  } finally {
    db.close();
  }
  return map;
}

/** 搜索结果里带 `#F12` 这样的编号，直接读出来。 */
function refsOf(text) {
  return new Set([...String(text).matchAll(/#([FEP]\d+)/gu)].map((m) => m[1]));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runCase(persona, cutoff) {
  const turns = rows(persona).filter((row) => row['轮次'] <= cutoff);
  const questions = exams.filter((exam) => exam.persona === persona && exam.cutoff_turn === cutoff);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wi5-${persona}-${cutoff}-`));
  const base = path.join(dir, 'base.db');

  const realNow = Date.now;
  const realStarted = realNow();
  let clock = Date.parse(turns[0]['逻辑时间']);
  Date.now = () => clock;

  const loom = createLoom({ dbPath: base, config: { consolidation: { triggerTokens: 0 } } });
  const SID = `wi5-${persona}`;
  let previous = null;
  for (const row of turns) {
    const at = Date.parse(row['逻辑时间']);
    clock = at;
    const gap = previous === null ? 2 * MIN : Math.max(MIN / 2, at - previous);
    await loom.turn(SID, row['用户消息'], row['助手回复'], { gapMs: gap });
    previous = at;
  }
  loom.dispose();
  const ingestMs = realNow() - realStarted;
  const atCutoff = clock;

  const catalogNow = catalog(base);
  const ingest = (() => {
    const db = new DatabaseSync(base, { readOnly: true });
    try {
      return {
        facts: db.prepare("SELECT count(*) c FROM facts WHERE status IN ('active','disputed')").get().c,
        events: db.prepare('SELECT count(*) c FROM events').get().c,
        preferences: db.prepare('SELECT count(*) c FROM preferences WHERE active = 1').get().c,
        l0: db.prepare('SELECT count(*) c FROM l0').get().c
      };
    } finally {
      db.close();
    }
  })();

  const result = { persona, cutoff, at: new Date(atCutoff).toISOString(), turns: turns.length, questions: questions.length, ingest, ingestMs, budgets: [] };

  for (const budget of BUDGETS) {
    const copy = path.join(dir, `b${budget}.db`);
    cloneDb(base, copy);
    const probe = createLoom({ dbPath: copy, config: { retrieval: { budgetTokens: budget } } });

    const ratios = [];
    const tokens = [];
    const counts = [];
    const covers = [];
    const hitCounts = [];

    for (const question of questions) {
      /*
       * 每道题有自己的「现在」。d00/d03/d15/d45 是同一条时间线的四个观察点，
       * 用同一个时钟渲染四次块，等于把三/十五/四十五天的衰减抹掉。
       */
      clock = Date.parse(question.now);
      const block = probe.memoryBlock(SID);
      const blockKey = key(block);

      const inBlock = new Set();
      for (const [id, variants] of catalogNow) {
        if (variants.some((text) => text.length >= 6 && blockKey.includes(text))) inBlock.add(id);
      }

      const hits = await probe.call('memory_search', { query: question.question, limit: 10 }, SID);
      const refs = refsOf(hits);
      tokens.push(estimateTokens(block));
      counts.push(block.split('\n').filter((line) => line.startsWith('- ')).length);
      covers.push(inBlock.size);
      if (refs.size === 0) continue;
      let overlap = 0;
      for (const ref of refs) if (inBlock.has(ref)) overlap += 1;
      ratios.push(overlap / refs.size);
      hitCounts.push(refs.size);
    }

    result.budgets.push({
      budget,
      tokensMedian: median(tokens),
      tokensMax: tokens.length === 0 ? 0 : Math.max(...tokens),
      linesMedian: median(counts),
      coveredMedian: median(covers),
      ratioMedian: Number(median(ratios).toFixed(3)),
      ratioMean: Number((ratios.reduce((a, b) => a + b, 0) / Math.max(1, ratios.length)).toFixed(3)),
      searched: ratios.length,
      hitsMedian: median(hitCounts)
    });

    probe.dispose();
  }

  Date.now = realNow;
  fs.rmSync(dir, { recursive: true, force: true });

  console.log(`\n${persona} @ 第 ${cutoff} 轮 · 灌库 ${turns.length} 轮 / ${ingestMs} ms · ` +
    `库内 ${ingest.facts} 事实 / ${ingest.events} 事件 / ${ingest.preferences} 规矩 · ${questions.length} 题`);
  console.log('  预算  块tok(中位/最大)  行数  收录  替代率(中位/均值)  搜索命中');
  for (const entry of result.budgets) {
    console.log(
      `  ${String(entry.budget).padStart(5)}  ${String(entry.tokensMedian).padStart(5)} / ${String(entry.tokensMax).padStart(5)}  ` +
      `${String(entry.linesMedian).padStart(4)}  ${String(entry.coveredMedian).padStart(4)}/${catalogNow.size}  ` +
      `${entry.ratioMedian.toFixed(2)} / ${entry.ratioMean.toFixed(2)}  ${entry.searched} 题 · 中位 ${entry.hitsMedian} 条`
    );
  }

  return result;
}

const all = [];
for (const [persona, cutoff] of CASES) all.push(await runCase(persona, cutoff));

fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), all }, null, 2), 'utf8');
console.log(`\n明细写入 ${OUT}`);
