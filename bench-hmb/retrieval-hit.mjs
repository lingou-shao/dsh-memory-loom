/**
 * 证据轮能不能被找到——检索与「原文可达性」的空缺有多大。
 *
 * 量的是三件事，从松到紧：
 *   1. 定位   搜索 top-k 里有没有任何一条，它的来源区间（facts.source_ids /
 *             events.l0_from..l0_to）覆盖这道题的证据轮。这是「模型能不能知道
 *             这件事在哪」。
 *   2. 读回   对定位到的那些，`memory_expand` 能不能把证据原话逐字吐出来。
 *             这是「找到之后能不能只读那一小段」。
 *   3. 块      自动注入的块里有没有同样覆盖证据轮的行——块是零成本那一路，
 *             它覆盖不到时才需要工具往返。
 *
 * 判据全部来自题库自带的 `grading/evidence.jsonl`（每题的证据轮号 + 原话），
 * 不用模型判分，所以结论可复现。代价是它只测「找得到」，不测「答得对」：
 * 找得到是答得对的必要条件，不是充分条件。
 *
 * 时钟要换。语料是 2026 年 4 月起的对话，而插件内部读 `Date.now()`；照真实
 * 时间跑，整条时间线落到今天，衰减与计划到期全错，块不是这份语料该有的块。
 *
 *   node retrieval-hit.mjs                 # 默认 3 个人物 × 最多 3 个时点
 *   node retrieval-hit.mjs --quick         # 只跑 P01 一个时点
 *   node retrieval-hit.mjs --limit 20      # 每次搜索取多少条（默认 10）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from '../loom-e2e/harness.mjs';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const DS = path.join(BENCH, 'datasets', 'natural-timegrid-20261101-v2');
const OUT = path.join(BENCH, `loom-retrieval-hit${process.argv.includes('--no-raw') ? '-noraw' : ''}.json`);

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const LIMIT = argOf('limit', 10);
/**
 * 原话通道一次给几条，以及它什么时候启动。
 *
 * 这两个旋钮是这次改造唯一的可调量，所以留在这里按参数跑，用来测「多给一条指针
 * 换多少定位率」——指针本身很便宜，贵的是模型读了之后展开的那一段。
 */
const RAW_HITS = argOf('rawhits', 2);
const RAW_BELOW = argOf('rawbelow', 3);

/** 传给 `createLoom` 的检索覆盖。 */
const RETRIEVAL = {
  ...(process.argv.includes('--no-raw') ? { rawSearch: false } : {}),
  rawHits: RAW_HITS,
  // 让原话通道在派生层给足 3 条时也照跑，用来分辨「没跑」和「跑了但排错」。
  ...(RAW_BELOW > 0 ? { relaxBelow: RAW_BELOW } : {}),
  // 闸门的第三条旁路（§71）：共享 N 个内容词就放行，不按问句比例算。
  ...(process.argv.includes('--solid') ? { solidOverlap: argOf('solid', 3) } : {}),
  // 话题链的入口判据（§79）：`--topic always` 让每次检索都跑，不只在问进度时。
  // 注意 `argOf` 会转数字，字符串选项要自己取。
  ...(process.argv.includes('--topic') ? { topicTrigger: String(process.argv[process.argv.indexOf('--topic') + 1] ?? 'always') } : {})
};

for (const need of [path.join(DS, 'exam-inputs.jsonl'), path.join(BENCH, 'grading', 'evidence.jsonl')]) {
  if (!fs.existsSync(need)) {
    console.error(`找不到题库：${need}`);
    console.error('设 HMB_DIR 指向 chat-memory-bench 根目录。');
    process.exit(1);
  }
}

const exams = JSON.parse(`[${fs.readFileSync(path.join(DS, 'exam-inputs.jsonl'), 'utf8').trim().split('\n').join(',')}]`);
const evidence = new Map(
  fs.readFileSync(path.join(BENCH, 'grading', 'evidence.jsonl'), 'utf8').trim().split('\n')
    .map((line) => JSON.parse(line))
    .map((row) => [row.id, row])
);

/** 摘掉空白与标点：原话里常见的全角引号、省略号不该决定能不能对上。 */
function key(text) {
  return String(text ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

function history(persona) {
  return fs.readFileSync(path.join(DS, 'histories', `${persona}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

function refsOf(text) {
  return [...new Set([...String(text).matchAll(/#([FEPL]\d+(?:-\d+)?)/gu)].map((m) => m[1]))];
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** 把 ref 解析成 l0 区间。偏好没有区间（正文就是它自己），返回 null。 */
function resolver(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const facts = new Map();
  for (const row of db.prepare('SELECT id, source_ids, text FROM facts').all()) {
    let range = [];
    try {
      range = JSON.parse(row.source_ids ?? '[]');
    } catch {
      range = [];
    }
    const from = Number(range[0]);
    const to = Number(range[range.length - 1]);
    facts.set(`F${row.id}`, Number.isFinite(from) && Number.isFinite(to) ? [from, to, row.text] : null);
  }
  const events = new Map();
  for (const row of db.prepare('SELECT id, l0_from, l0_to, title, summary FROM events').all()) {
    events.set(`E${row.id}`, [row.l0_from, row.l0_to, `${row.title} ${row.summary}`]);
  }
  return {
    /** ref → [from, to, body]；偏好与找不到的 ref 返回 null。 */
    of(ref) {
      if (ref.startsWith('F')) return facts.get(ref) ?? null;
      if (ref.startsWith('E')) return events.get(ref) ?? null;
      // 原话通道：ref 自己就是区间，不需要查表——这也正是它可靠的原因。
      if (ref.startsWith('L')) {
        const [from, to] = ref.slice(1).split('-').map(Number);
        return [from, to ?? from, ''];
      }
      return null;
    },
    close() {
      db.close();
    }
  };
}

const covers = (range, ids) => range !== null && ids.some((id) => id >= range[0] && id <= range[1]);

/**
 * 这组 ref 落到了哪些轮上。
 *
 * 「有一轮被覆盖」太松：一道题的证据往往横跨「当初的约定」和「后来的结果」，
 * 命中前者也算 located，可答案恰恰在后者。所以要按轮结算，才能问出「几个要点
 * 拿到了」——那才是判分员会扣分的地方。
 */
function turnsTouched(refs, lookup, turnToL0) {
  const touched = new Set();
  const ranges = refs.map((ref) => lookup.of(ref)).filter((range) => range !== null);
  for (const [turn, ids] of turnToL0) {
    if (ranges.some((range) => ids.some((id) => id >= range[0] && id <= range[1]))) touched.add(turn);
  }
  return touched;
}

/** 证据轮号 → l0 id 集合，以及证据原话（用来判断读回是否逐字）。 */
function anchorsOf(evidenceRow, turnToL0) {
  const turns = new Set();
  const perFact = [];
  for (const fact of evidenceRow.facts ?? []) {
    const own = [];
    for (const turn of fact.evidence_turns ?? []) {
      turns.add(turn);
      own.push(turn);
    }
    if (own.length > 0) perFact.push(own);
  }
  for (const source of evidenceRow.sources ?? []) if (Number.isFinite(source.turn)) turns.add(source.turn);
  const ids = [];
  for (const turn of turns) for (const id of turnToL0.get(turn) ?? []) ids.push(id);
  const quotes = (evidenceRow.sources ?? []).map((s) => key(s.quote)).filter((q) => q.length >= 6);
  return { turns: [...turns], ids, quotes, perFact };
}

/** 每个人物取「证据在截止前、题数最多」的几个时点，按时间升序增量灌库。 */
function planCutoffs(persona, maxCutoffs) {
  const mine = exams.filter((exam) => exam.persona === persona);
  const byCutoff = new Map();
  for (const exam of mine) {
    const row = evidence.get(exam.id);
    if (row === undefined) continue;
    const turns = [];
    for (const fact of row.facts ?? []) for (const turn of fact.evidence_turns ?? []) turns.push(turn);
    for (const source of row.sources ?? []) if (Number.isFinite(source.turn)) turns.push(source.turn);
    // 证据必须全部落在截止之前，否则这题在此时点本来就无解，算进分母是作弊。
    if (turns.length === 0 || Math.max(...turns) > exam.cutoff_turn) continue;
    byCutoff.set(exam.cutoff_turn, (byCutoff.get(exam.cutoff_turn) ?? 0) + 1);
  }
  return [...byCutoff.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxCutoffs).map(([cutoff]) => cutoff).sort((a, b) => a - b);
}

async function runPersona(persona, cutoffs) {
  const rows = history(persona);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hit-${persona}-`));
  const dbPath = path.join(dir, 'loom.db');

  const realNow = Date.now;
  let clock = Date.parse(rows[0]['逻辑时间']);
  Date.now = () => clock;

  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 }, retrieval: RETRIEVAL } });
  const SID = `hit-${persona}`;
  const cases = [];
  let previous = null;
  let cursor = 0;
  try {
    for (const cutoff of cutoffs) {
      for (; cursor < rows.length && rows[cursor]['轮次'] <= cutoff; cursor++) {
        const row = rows[cursor];
        const at = Date.parse(row['逻辑时间']);
        clock = at;
        const gap = previous === null ? 2 * MIN : Math.max(MIN / 2, at - previous);
        await loom.turn(SID, row['用户消息'], row['助手回复'], { gapMs: gap });
        previous = at;
      }
      clock = previous ?? clock;

      const db = new DatabaseSync(dbPath, { readOnly: true });
      const turnToL0 = new Map();
      /*
       * 不按 identity 过滤：harness 不声明平台身份，插件把所有人归到 `master`
       * 一个身份上，按 persona 过滤会一律空集——而空集会让整段结论变成 0/0。
       */
      for (const row of db.prepare('SELECT id, turn FROM l0').all()) {
        const list = turnToL0.get(row.turn) ?? [];
        list.push(row.id);
        turnToL0.set(row.turn, list);
      }
      db.close();

      const lookup = resolver(dbPath);
      const block = String(loom.memoryBlock(SID));
      const blockRefs = refsOf(block);
      const blockHits = blockRefs.filter((ref) => lookup.of(ref) !== null);

      const questions = exams.filter((exam) => exam.persona === persona && exam.cutoff_turn === cutoff);
      const items = [];
      for (const exam of questions) {
        const row = evidence.get(exam.id);
        if (row === undefined) continue;
        const anchors = anchorsOf(row, turnToL0);
        if (anchors.ids.length === 0) continue;

        const text = String(await loom.call('memory_search', { query: exam.question, limit: LIMIT }, SID));
        const refs = refsOf(text);
        const locating = refs.filter((ref) => covers(lookup.of(ref), anchors.ids));
        const blockLocating = blockHits.filter((ref) => covers(lookup.of(ref), anchors.ids));
        /*
         * 排第几，而不只是「在不在」。
         *
         * 10 条里有一条覆盖证据轮，和模型打开第一屏就能看见，是两件事：模型只展开
         * 前两条，所以 rank 大于 1 的定位在实际对话里等于没定位。这个数才对应
         * 「结构化该赢的地方」——材料在库里，但没排在模型会去看的位置。
         */
        const rank = refs.findIndex((ref) => covers(lookup.of(ref), anchors.ids));
        /*
         * 前 k 条里，几个要点（题库的每个 fact）被落到了。模型只看前两条，
         * 所以 k=2 才是「它手上真有的东西」。
         */
        const factsAt = (k) => {
          const touched = turnsTouched(refs.slice(0, k), lookup, turnToL0);
          const hits = anchors.perFact.filter((own) => own.some((turn) => touched.has(turn))).length;
          return { hits, all: anchors.perFact.length > 0 && hits === anchors.perFact.length };
        };
        const at1 = factsAt(1);
        const at2 = factsAt(2);
        const at3 = factsAt(3);

        // 读回：拿第一条定位到的 ref 去展开，看证据原话是否逐字在里面。
        let verbatim = false;
        if (locating.length > 0) {
          const expanded = String(await loom.call('memory_expand', { ref: `#${locating[0]}` }, SID));
          const body = key(expanded);
          verbatim = anchors.quotes.some((quote) => body.includes(quote));
        }

        items.push({
          id: exam.id,
          kind: exam.kind ?? exam.type ?? null,
          question: exam.question,
          evidenceTurns: anchors.turns,
          refs: refs.length,
          located: locating.length > 0,
          locatingRefs: locating,
          rank,
          factCount: anchors.perFact.length,
          factHits1: at1.hits,
          factHits2: at2.hits,
          allFacts1: at1.all,
          allFacts2: at2.all,
          factHits3: at3.hits,
          allFacts3: at3.all,
          // 原话通道的产量与命中量：多给一条指针换来多少定位率，代价是多少噪声。
          rawReturned: refs.filter((r) => r.startsWith('L')).length,
          rawUseful: locating.filter((r) => r.startsWith('L')).length,
          // 是不是靠原话通道定位到的——用来分辨「新通道在起作用」还是「只是没变差」。
          viaRaw: locating.some((ref) => ref.startsWith('L')),
          blockLocated: blockLocating.length > 0,
          blockLines: block.split('\n').filter((line) => line.startsWith('- ')).length,
          verbatim
        });
      }
      lookup.close();
      cases.push({ cutoff, at: new Date(clock).toISOString(), items });
    }
  } finally {
    loom.dispose();
    Date.now = realNow;
  }
  return { persona, cutoffs, dir, cases };
}

const slice = process.argv.includes('--quick')
  ? [['P01', [268]]]
  : [['P01', null], ['P17', null], ['P16', null]];

const report = { limit: LIMIT, retrieval: RETRIEVAL, generatedAt: new Date().toISOString(), personas: [] };
for (const [persona, fixed] of slice) {
  const cutoffs = fixed ?? planCutoffs(persona, 3);
  if (cutoffs.length === 0) continue;
  process.stdout.write(`${persona} 时点 ${cutoffs.join('/')} …\n`);
  const result = await runPersona(persona, cutoffs);
  report.personas.push(result);
}

const all = report.personas.flatMap((p) => p.cases.flatMap((c) => c.items));
const rate = (n, d) => (d === 0 ? 0 : (n / d) * 100);
const located = all.filter((item) => item.located).length;
const inBlock = all.filter((item) => item.blockLocated).length;
const verbatim = all.filter((item) => item.verbatim).length;
/** 前 k 条里就有材料——模型真的会读到的那个窗口。 */
const topAt = (k) => all.filter((item) => item.rank >= 0 && item.rank < k).length;
const ranks = all.map((item) => item.rank).filter((rank) => rank >= 0);
/** 全部要点都落到——判分员那边就是「答全了」的必要条件。 */
const allAt = (k) => all.filter((item) => (k === 1 ? item.allFacts1 : k === 3 ? item.allFacts3 : item.allFacts2)).length;
const factHits = (k) => all.reduce((sum, item) => sum + (k === 1 ? item.factHits1 : k === 3 ? item.factHits3 : item.factHits2), 0);
const factTotal = all.reduce((sum, item) => sum + item.factCount, 0);

report.summary = {
  questions: all.length,
  located,
  locatedPct: Number(rate(located, all.length).toFixed(1)),
  top1: topAt(1),
  top1Pct: Number(rate(topAt(1), all.length).toFixed(1)),
  top2: topAt(2),
  top2Pct: Number(rate(topAt(2), all.length).toFixed(1)),
  top3: topAt(3),
  top3Pct: Number(rate(topAt(3), all.length).toFixed(1)),
  rankMedian: median(ranks),
  /** 要点级：前 k 条覆盖了几个 evidence fact（分母是全部 fact）。 */
  factHits1: factHits(1),
  factHits2: factHits(2),
  factTotal,
  factPct1: Number(rate(factHits(1), factTotal).toFixed(1)),
  factPct2: Number(rate(factHits(2), factTotal).toFixed(1)),
  allFacts1: allAt(1),
  allFacts1Pct: Number(rate(allAt(1), all.length).toFixed(1)),
  allFacts2: allAt(2),
  allFacts2Pct: Number(rate(allAt(2), all.length).toFixed(1)),
  factHits3: factHits(3),
  factPct3: Number(rate(factHits(3), all.reduce((sum, item) => sum + item.factCount, 0)).toFixed(1)),
  allFacts3: allAt(3),
  allFacts3Pct: Number(rate(allAt(3), all.length).toFixed(1)),
  rawPrecisionPct: Number(rate(all.reduce((sum, item) => sum + item.rawUseful, 0), all.reduce((sum, item) => sum + item.rawReturned, 0)).toFixed(1)),
  viaRaw: all.filter((item) => item.located && item.viaRaw).length,
  rawReturned: all.reduce((sum, item) => sum + item.rawReturned, 0),
  rawUseful: all.reduce((sum, item) => sum + item.rawUseful, 0),
  inBlock,
  inBlockPct: Number(rate(inBlock, all.length).toFixed(1)),
  verbatim,
  verbatimPct: Number(rate(verbatim, located).toFixed(1)),
  refsMedian: median(all.map((item) => item.refs)),
  blockLinesMedian: median(all.map((item) => item.blockLines))
};
fs.writeFileSync(OUT, JSON.stringify(report, null, 1));

console.log('');
console.log(`题数 ${all.length} · 搜索取 ${LIMIT} 条 · 每条中位命中 ${report.summary.refsMedian} 条 · 块中位 ${report.summary.blockLinesMedian} 行`);
console.log(`定位（搜索里有一条覆盖证据轮）  ${located}/${all.length} = ${report.summary.locatedPct}%  其中原话通道 ${report.summary.viaRaw}`);
console.log(`前 1/2/3 条内定位              ${topAt(1)} / ${topAt(2)} / ${topAt(3)}  = ${report.summary.top1Pct}% / ${report.summary.top2Pct}% / ${report.summary.top3Pct}%  （定位题里排位中位 ${report.summary.rankMedian}）`);
console.log(`要点（前 2 条覆盖的 evidence fact） ${report.summary.factHits2}/${report.summary.factTotal} = ${report.summary.factPct2}%  · 前 1 条 ${report.summary.factPct1}%`);
console.log(`要点全中（前 2 条就够答全）      ${report.summary.allFacts2}/${all.length} = ${report.summary.allFacts2Pct}%  · 前 1 条 ${report.summary.allFacts1Pct}%`);
console.log(`要点（前 3 条） ${report.summary.factHits3}/${all.reduce((sum, item) => sum + item.factCount, 0)} = ${report.summary.factPct3}%  · 全中 ${report.summary.allFacts3}/${all.length} = ${report.summary.allFacts3Pct}%`);
console.log(`块内覆盖                      ${inBlock}/${all.length} = ${report.summary.inBlockPct}%`);
console.log(`读回原话（定位到的里面逐字）    ${verbatim}/${located} = ${report.summary.verbatimPct}%`);
console.log(`原话指针产量 ${report.summary.rawReturned} 条，其中指向证据轮 ${report.summary.rawUseful} 条 = ${report.summary.rawPrecisionPct}%`);
console.log('');
for (const persona of report.personas) {
  for (const oneCase of persona.cases) {
    const n = oneCase.items.length;
    const hit = oneCase.items.filter((item) => item.located).length;
    console.log(`  ${persona.persona} @${oneCase.cutoff}  题 ${n}  定位 ${hit}`);
  }
}
console.log(`\n明细 ${OUT}`);
