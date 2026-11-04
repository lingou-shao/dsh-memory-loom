/**
 * 上界估计：假如抽取是「理想」的（每段里每一个槽位句都抽成一条事实），
 * loom 的检索 + 调回原文能拿到多少材料。
 *
 * 为什么需要这一步：无模型时 loom 走规则兜底，`looksWorthKeeping` 只留带
 * 用户画像/经历/时间标记的句子，270 段语料里只产出了 2 条事实。那不是检索
 * 能力的读数，是「兜底路径对这类文本几乎不建索引」的读数。把抽取换成理想
 * 版本，剩下的差值才是检索自己的问题。
 *
 * 这里的 llm 是假的：不联网、不花钱，只按固定规则把段落里每个
 * `X 的Y首次确立为/调整为 V` 抽成一条事实。它代表「抽取满分」这个上界，
 * 不代表任何真实模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createLoom, mockLlm } from '../loom-e2e/harness.mjs';

const BENCH = 'C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main';
const OUT = path.resolve('bench-hmb/out');
const TAG = 'loom-ideal';

const corpus = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/corpus/corpus.json'), 'utf8'));
const keys = JSON.parse(fs.readFileSync(path.join(BENCH, 'chain/keys/keys.json'), 'utf8'));

const SLOT = /([^\s，。（）]+) 的([^\s，。（）]{1,8}?)(?:首次确立为|调整为)\s([^，。]+)，?/g;

/** 理想抽取器：把提示词里那段对话的每个槽位句都抽出来。 */
function reply(request) {
  // 桥把 prompt 放进 messages[0].content[0].text，不是顶层 prompt
  const prompt = String(request.messages?.[0]?.content?.[0]?.text ?? request.prompt ?? '');
  const seg = corpus.find((c) => prompt.includes(c.text)) ?? null;
  if (seg === null) return '{"facts":[]}';
  const facts = [];
  for (const sent of seg.text.split(/(?<=[。！？])/)) {
    const s = sent.trim();
    if (s.length < 6) continue;
    if (!new RegExp(SLOT.source).test(s)) continue;
    facts.push({ text: s.slice(0, 200), kind: 'fact', confidence: 0.8 });
    if (facts.length >= 8) break;
  }
  return JSON.stringify({
    facts,
    summary: seg.text.slice(0, 180),
    emotion: { valence: 0, arousal: 0, salience: 0.4 },
  });
}

const dbPath = path.join(OUT, `${TAG}.db`);
try { fs.rmSync(dbPath, { force: true }); } catch { /* 首次 */ }
const llm = mockLlm(reply);
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0, dailyLlmCalls: 5000 }, segmentation: { gapMinutes: 0 } }, llm });
const SID = 'bench';

const t0 = Date.now();
/*
 * 一段一个会话。语料是 270 条**独立记录**，不是一场连续对话；同一个会话里
 * 连着灌，分段器会按话题相似度把它们并成几段，摘要只留首句+最长句，
 * 索引就漏了。会话是检索范围之外的东西（identity 才是），换会话不改检索面。
 */
for (const [i, seg] of corpus.entries()) {
  await loom.turn(`s${i}`, seg.text, '收到。', { gapMs: 30 * 60000 });
  await new Promise((r) => setTimeout(r, 40));
}
const ingestMs = Date.now() - t0;

console.log('llm 调用次数:', llm.calls.length, '| 首个 prompt 片段:', String(llm.calls[0]?.prompt ?? '').slice(0, 80));
const db = new DatabaseSync(dbPath, { readOnly: true });
console.log(`写入 ${corpus.length} 段 ${ingestMs}ms｜facts=${db.prepare('SELECT count(*) c FROM facts').get().c} `
  + `events=${db.prepare('SELECT count(*) c FROM events').get().c}`);
db.close();

const kOf = (q) => (q.type === '变更' ? 50 : 6);
const rows = [];
const t1 = Date.now();
for (const [i, q] of keys.entries()) {
  const k = kOf(q);
  const rec = { qid: q.qid, type: q.type, k };
  for (const [mode, query] of [['raw', q.question], ['kw', `${q.subject} ${q.slot}`]]) {
    const r = await loom.call('memory_search', { query, limit: k }, 's0');
    // 命中的是索引条目（F/E）；正文一律走 expand 取回，与真实用法一致
    const refs = [...String(r).matchAll(/#([EF]\d+)/g)].map((x) => x[1]);
    const hits = [];
    for (const ref of refs) {
      const body = await loom.call('memory_expand', { ref }, 's0');
      if (String(body).startsWith('没有取到')) continue;
      const s = String(body);
      const nl = s.indexOf('\n');
      let text = nl === -1 ? s : s.slice(nl + 1);
      const foot = text.lastIndexOf('\n—\n');
      if (foot !== -1) text = text.slice(0, foot);
      hits.push({ text: text.trim(), cid: null, ref });
    }
    rec[mode] = hits;
  }
  rows.push(rec);
  if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${keys.length}（${((Date.now() - t1) / 1000).toFixed(0)}s）`);
}
const askMs = Date.now() - t1;

/*
 * cid 不在这里推：expand 的正文就是那一段原文，与语料逐字对应。
 * 评估侧直接用「正文里是否含该 cid 的原文」来判定，避免多一层映射出错。
 */
const corpusText = Object.fromEntries(corpus.map((c) => [c.cid, c.text]));
for (const r of rows) {
  for (const mode of ['raw', 'kw']) {
    r[mode] = r[mode].map((h) => ({
      // expand 的正文是「用户：」+ 原文，个别情况下还被 clip（尾加省略号），
      // 所以按前缀包含认领，不做整串相等
      cid: Object.keys(corpusText).find((cid) => corpusText[cid].startsWith(h.text.replace(/^用户：/, '').slice(0, 60))) ?? null,
      chars: h.text.length,
      ref: h.ref,
    }));
  }
}

fs.writeFileSync(path.join(OUT, `retrieval_${TAG}.json`), JSON.stringify({
  arm: TAG, n_ingested: corpus.length, mode: 'episode-ideal-llm',
  ingest_ms: ingestMs, retrieve_ms: askMs, rows,
}, null, 1), 'utf8');

console.log(`检索 ${keys.length} 题 ${(askMs / 1000).toFixed(0)}s → ${path.join(OUT, `retrieval_${TAG}.json`)}`);
loom.dispose();
