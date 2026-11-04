/**
 * loom 的「真实用法」桥：回合 → L0 原文 → 抽取成索引 → 检索命中 → 调回原文。
 *
 * 与 loom_bridge.mjs（直存版）的区别就在这一层：
 *   · 直存版把语料段当 fact 写进去，检索吐的就是那段原文；
 *   · 这一版按插件设计跑：`turn()` 写 L0，整合把一段折成一条事件/事实（索引），
 *     检索只命中索引条目，正文一律 `memory_expand()` 取回。
 *
 * 这正是「索引是压缩的、正文按需取」的设计，也是作者在基准结论二里说的
 * 「自家材料内可定位」那一面——评测要看的本来就是这条路径。
 *
 * 协议与 loom_bridge.mjs 相同。环境变量另加：
 *   HMB_LOOM_SETTLE_MS  每段整合的等待上限（默认 3000）
 */
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const HOME = process.env.HMB_LOOM_HOME ?? 'C:/Users/shaoz/Documents/GitHub/dsh-memory-loom';
const DB = process.env.HMB_LOOM_DB;
const SETTLE_MS = Number(process.env.HMB_LOOM_SETTLE_MS ?? 3000);
if (!DB) { console.error('HMB_LOOM_DB 未设置'); process.exit(2); }

const { apply, Config } = await import(`file://${HOME}/lib/index.js`);
const { DatabaseSync } = await import('node:sqlite');

const shared = { sections: new Map(), contexts: new Map(), handlers: new Map(), tools: new Map(), disposers: [] };
const ctx = {
  systemPrompt: {
    section(spec) { shared.sections.set(spec.name, spec); return () => shared.sections.delete(spec.name); },
    context(spec) { shared.contexts.set(spec.name, spec); return () => shared.contexts.delete(spec.name); },
  },
  on(event, handler) {
    const list = shared.handlers.get(event) ?? [];
    list.push(handler);
    shared.handlers.set(event, list);
  },
  effect(factory) {
    const d = factory();
    if (typeof d === 'function') shared.disposers.push(d);
  },
  tools: { register(t) { shared.tools.set(t.name, t); }, get(n) { return shared.tools.get(n); } },
  logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
  get(name, strict = true) {
    if (strict) throw new Error(`service "${name}" is not available`);
    return undefined;
  },
};

/*
 * 两个非默认配置，都是评测场景逼出来的：
 *   triggerTokens=0     批量灌入没有「聊满两万 token 才整合」的余地，不压到 0 就一条索引都没有；
 *   includeAssistant=false  调回正文时不该掺进助手那句占位回复。
 */
apply(ctx, Config({
  path: DB,
  consolidation: { triggerTokens: 0 },
  index: { includeAssistant: false },
}));

const SESSION = 'bench';
const agents = new Map();
const agentOf = (id) => {
  let a = agents.get(id);
  if (a === undefined) { a = { id, ctx: { systemPrompt: ctx.systemPrompt } }; agents.set(id, a); }
  return a;
};
const emit = (event, ...args) => {
  for (const h of shared.handlers.get(event) ?? []) h(...args);
};
const call = async (name, args) => {
  const tool = shared.tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.execute(args, { agent: agentOf(SESSION) });
};

const db = new DatabaseSync(DB);
const maxL0 = () => Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM l0').get().m);
const consolidatedThrough = () => Number(
  db.prepare('SELECT COALESCE(consolidated_through, 0) AS c FROM sessions WHERE session_id = ?').get(SESSION)?.c ?? 0,
);

/* cid ↔ l0 区间的映射：adapter 自己的账本，不改插件的表 */
const MAP_FILE = `${DB}.cidmap.json`;
let cidMap = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8')) : [];
const saveMap = () => writeFileSync(MAP_FILE, JSON.stringify(cidMap), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一段语料＝一个回合；等整合把这段折成索引条目再进下一段。 */
async function ingestEpisode({ chapters }) {
  let n = 0;
  let settledSlow = 0;
  for (const ch of chapters) {
    agentOf(SESSION);
    const from = maxL0() + 1;
    emit('session/event', { id: SESSION }, { type: 'turn/start', data: { turn: n + 1 }, time: Date.now() });
    emit('session/event', { id: SESSION }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: ch.text }] },
      time: Date.now(),
    });
    emit('agent/turn-stopping', { agent: agentOf(SESSION) });
    n++;

    // 整合是异步的（tick 不 await）。等这一段被标记已整合，超时也放行并计数。
    const deadline = Date.now() + SETTLE_MS;
    let ok = false;
    while (Date.now() < deadline) {
      await sleep(15);
      if (consolidatedThrough() >= from) { ok = true; break; }
    }
    if (!ok) settledSlow++;
    cidMap.push({ cid: ch.cid, from, to: Math.max(from, maxL0()) });
  }
  cidMap = cidMap.filter((e, i, arr) => arr.findIndex((x) => x.cid === e.cid) === i);
  saveMap();
  return { ok: true, n, settled_slow: settledSlow };
}

/** 这个索引条目指的是哪一段原文。 */
function cidOfRef(ref) {
  const m = /^([EF])(\d+)$/.exec(ref);
  if (m === null) return null;
  let l0 = null;
  if (m[1] === 'E') {
    const row = db.prepare('SELECT l0_from FROM events WHERE id = ?').get(Number(m[2]));
    l0 = row === undefined ? null : Number(row.l0_from);
  } else {
    const row = db.prepare('SELECT source_ids FROM facts WHERE id = ?').get(Number(m[2]));
    try { const ids = JSON.parse(row?.source_ids ?? '[]'); l0 = ids.length > 0 ? Number(ids[0]) : null; } catch { l0 = null; }
  }
  if (l0 === null) return null;
  const hit = cidMap.find((e) => e.from <= l0 && l0 <= e.to);
  return hit?.cid ?? null;
}

/** 把 expand 的排版剥成正文：去掉首行标题、末尾横线与字数脚注。 */
function stripExpand(text) {
  const s = String(text);
  const firstNl = s.indexOf('\n');
  let body = firstNl === -1 ? s : s.slice(firstNl + 1);
  const foot = body.lastIndexOf('\n—\n');
  if (foot !== -1) body = body.slice(0, foot);
  return body.trim();
}

const handlers = {
  async ingest(req) {
    return req.mode === 'episode' ? ingestEpisode(req) : null;
  },

  async retrieve({ query, k = 6 }) {
    const listed = await call('memory_search', { query, limit: Math.max(1, Math.min(50, k)) });
    const refs = [...String(listed).matchAll(/#([EFP]\d+)/g)].map((m) => m[1]);
    const hits = [];
    for (const ref of refs) {
      const body = await call('memory_expand', { ref });
      if (String(body).startsWith('没有取到')) continue;      // 已被删/过期
      hits.push({ text: stripExpand(body), cid: cidOfRef(ref), score: null, ref });
    }
    return { ok: true, hits };
  },

  count() {
    return { ok: true, n: Number(db.prepare('SELECT count(*) AS c FROM events').get().c) };
  },

  close() {
    try { db.close(); } catch { /* 已关 */ }
    for (const d of shared.disposers.splice(0)) { try { d(); } catch { /* best effort */ } }
    return { ok: true };
  },
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (line.trim() === '') return;
  try {
    const req = JSON.parse(line);
    const fn = handlers[req.op];
    if (fn === undefined) throw new Error(`unknown op ${req.op}`);
    const out = await fn(req);
    if (out === null) throw new Error(`ingest mode 不支持：${req.mode}`);
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: `${error.name}: ${error.message}` })}\n`);
  }
});
