/**
 * loom ↔ 评测 harness 的常驻桥。
 *
 * Python 适配器不会自己实现一套"类 loom"的东西——那测的就不是它了。这里起的是
 * **真的** dsh-memory-loom：真正的 Config、真正的 SQLite 表、真正的检索排序，
 * 宿主只假了 cordis 的那几个面（与 loom-e2e/harness.mjs 同构，见 design.md §2）。
 *
 * 协议：stdin 一行一个 JSON 请求，stdout 一行一个 JSON 响应。
 *   {"op":"ingest","chapters":[{"cid","title","text"}]}  → {"ok":true,"n":270}
 *   {"op":"retrieve","query":"…","k":6}                  → {"ok":true,"hits":[…]}
 *   {"op":"count"}                                       → {"ok":true,"n":270}
 *   {"op":"close"}                                       → {"ok":true}
 *
 * 库路径由环境变量 HMB_LOOM_DB 给定；HMB_LOOM_HOME 指向插件根目录。
 */
import { createInterface } from 'node:readline';

const HOME = process.env.HMB_LOOM_HOME ?? 'C:/Users/shaoz/Documents/GitHub/dsh-memory-loom';
const DB = process.env.HMB_LOOM_DB;
if (!DB) {
  console.error('HMB_LOOM_DB 未设置');
  process.exit(2);
}

const { apply, Config } = await import(`file://${HOME}/lib/index.js`);

/* ── 最小宿主：只假插件声明过的那几个面 ─────────────────────────────── */
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
    const disposer = factory();
    if (typeof disposer === 'function') shared.disposers.push(disposer);
  },
  tools: { register(tool) { shared.tools.set(tool.name, tool); }, get(name) { return shared.tools.get(name); } },
  logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
  get(name, strict = true) {
    if (strict) throw new Error(`service "${name}" is not available`);
    return undefined;
  },
};

apply(ctx, Config({ path: DB }));

const agents = new Map();
const agentOf = (id) => {
  let a = agents.get(id);
  if (a === undefined) { a = { id, ctx: { systemPrompt: ctx.systemPrompt } }; agents.set(id, a); }
  return a;
};
const call = async (name, args, sessionId = 'bench') => {
  const tool = shared.tools.get(name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool.execute(args, { agent: agentOf(sessionId) });
};

/* ── 原文与 cid：search 只回编号，正文和来源从库里取回 ───────────────── */
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(DB);
const rowOf = db.prepare('SELECT text, tags FROM facts WHERE id = ?');

const answer = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

const handlers = {
  async ingest({ chapters }) {
    let n = 0;
    for (const ch of chapters) {
      const out = await call('memory_write', { text: ch.text, kind: 'fact', tags: [ch.cid] });
      if (String(out).startsWith('已记住')) n++;
    }
    return { ok: true, n };
  },

  async retrieve({ query, k = 6 }) {
    const text = await call('memory_search', { query, limit: Math.max(1, Math.min(50, k)) });
    const ids = [...String(text).matchAll(/\(#F(\d+)\)/g)].map((m) => Number(m[1]));
    const hits = [];
    for (const id of ids) {
      const row = rowOf.get(id);
      if (row === undefined) continue;
      // tags 是逗号分隔的原样字符串（单值时连引号都没有），第一个即 cid
      const cid = typeof row.tags === 'string' && row.tags.length > 0 ? row.tags.split(',')[0] : null;
      // score 不给：search 只回顺序，硬编一个数会让判分器误以为有可比性
      hits.push({ text: row.text, cid, score: null });
    }
    return { ok: true, hits };
  },

  count() {
    const r = db.prepare("SELECT count(*) AS c FROM facts WHERE status <> 'pending_delete'").get();
    return { ok: true, n: Number(r.c) };
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
    answer(await fn(req));
  } catch (error) {
    answer({ ok: false, error: `${error.name}: ${error.message}` });
  }
});
