/**
 * Probe: what happens when the plugin is loaded into a process whose session
 * already exists — i.e. DSH's live reconcile (`dsh plugin add` on a running
 * host) rather than a fresh boot.
 *
 * The host creates agents before the plugin is composed, so `agent/created`
 * fires while nobody is listening. Question: do the three per-agent blocks
 * (persona / hook index / memory) still get attached to that live session?
 *
 * Run: node loom-e2e/probe-hotload.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { apply, Config } = await import('../lib/index.js');

const SESSION = 'session-existing';

function makeSurface() {
  const sections = new Map();
  const contexts = new Map();
  const handlers = new Map();
  const tools = new Map();
  const disposers = [];
  const prompt = {
    section(spec) {
      sections.set(spec.name, spec);
      return () => sections.delete(spec.name);
    },
    context(spec) {
      contexts.set(spec.name, spec);
      return () => contexts.delete(spec.name);
    },
  };
  return { sections, contexts, handlers, tools, prompt, disposers };
}

function makeCtx(surface, liveAgents) {
  return {
    systemPrompt: surface.prompt,
    on(event, handler) {
      const list = surface.handlers.get(event) ?? [];
      list.push(handler);
      surface.handlers.set(event, list);
    },
    effect(factory) {
      const disposer = factory();
      surface.disposers.push(() => {
        if (typeof disposer === 'function') disposer();
      });
    },
    tools: { register(tool) { surface.tools.set(tool.name, tool); } },
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    // The host exposes the agent registry as a cordis service named `agents`.
    get(name, strict = true) {
      if (name === 'agents') return { list: () => [...liveAgents] };
      if (strict) throw new Error(`service "${name}" is not available`);
      return undefined;
    },
  };
}

const root = mkdtempSync(join(tmpdir(), 'loom-hotload-'));
const dbPath = join(root, 'loom.db');
const surface = makeSurface();

try {
  // 1. Host is already running; this session exists before the plugin arrives.
  const agent = { id: SESSION, ctx: { systemPrompt: surface.prompt } };
  const liveAgents = [agent];

  // 2. Plugin is composed into the live process.
  apply(makeCtx(surface, liveAgents), Config({ path: dbPath, timezone: 'Asia/Shanghai' }));

  const has = (name) => surface.sections.has(name) || surface.contexts.has(name);
  const rows = [
    ['protocol（全局 section）', surface.sections.has('memory-loom:protocol')],
    ['index-protocol（全局 section）', surface.sections.has('memory-loom:index-protocol')],
    [`persona:${SESSION}（按会话）`, surface.sections.has(`memory-loom:persona:${SESSION}`)],
    [`hooks:${SESSION}（按会话）`, surface.contexts.has(`memory-loom:hooks:${SESSION}`)],
    [`memory:${SESSION}（按会话）`, surface.contexts.has(`memory-loom:memory:${SESSION}`)],
    ['14 个 memory_* 工具', surface.tools.size === 14],
    ['新工具 memory_episodes 已注册', surface.tools.has('memory_episodes')],
    ['新工具 memory_settle 已注册', surface.tools.has('memory_settle')],
    ['新工具 memory_resolve 已注册', surface.tools.has('memory_resolve')],
  ];

  console.log('热加载到已运行会话（agent 先存在，插件后组合）\n');
  for (const [label, ok] of rows) console.log(`  ${ok ? '✓' : '✗'} ${label}`);

  const missing = rows.filter(([, ok]) => !ok).length;
  console.log(`\n结论：${missing === 0 ? '全部挂上' : `${missing} 项没挂上——已有会话拿不到这些 prompt 块`}`);

  // 3. A brand-new session afterwards should be complete.
  const fresh = { id: 'session-fresh', ctx: { systemPrompt: surface.prompt } };
  liveAgents.push(fresh);
  for (const handler of surface.handlers.get('agent/created') ?? []) handler({ agent: fresh });
  const freshOk = surface.contexts.has('memory-loom:memory:session-fresh');
  console.log(`新会话（装完之后才创建）：${freshOk ? '✓ 正常挂上' : '✗ 也没挂上'}`);

  void has;
  process.exitCode = missing === 0 && freshOk ? 0 : 1;
} finally {
  // Close the engine before deleting the file (Windows keeps it locked open).
  for (const dispose of surface.disposers.splice(0)) {
    try {
      dispose();
    } catch {
      // best effort
    }
  }
  rmSync(root, { recursive: true, force: true });
}
