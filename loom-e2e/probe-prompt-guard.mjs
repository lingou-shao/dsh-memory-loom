/**
 * Probe: does a failing prompt block kill the turn?
 *
 * The host does NOT wrap `systemPrompt.section()/context()` text providers in a
 * try/catch (see @deepseek-ai/dsh-system-prompt: assemble() calls
 * `section.text(context)` / resolveContext() bare, and agent-loop's preStep
 * awaits assemble() inside turn()'s try — a throw becomes `turn/end: error` and
 * the next assembly throws again). So a dead DB would make every turn fail.
 *
 * The fix under test: guardPrompt() degrades each block to "" instead of
 * throwing. "" is dropped by both renderPrompt() and renderContextSections()
 * (they filter text.length > 0), so no empty heading is left behind.
 *
 * Run: node loom-e2e/probe-prompt-guard.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply, Config } = await import('../lib/index.js');

const SESSION = 'session-guard';

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
    // `get` is what the collision guard reads before registering anything the
    // host would reject; a fake without it only exercises the happy path.
    tools: {
      register(tool) { surface.tools.set(tool.name, tool); },
      get(name) { return surface.tools.get(name); },
    },
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    get(name, strict = true) {
      if (name === 'agents') return { list: () => [...liveAgents] };
      if (strict) throw new Error(`service "${name}" is not available`);
      return undefined;
    },
  };
}

/** Call a text provider and report whether it threw. */
function callText(spec) {
  try {
    const text = typeof spec.text === 'function' ? spec.text({}) : spec.text;
    return { threw: false, length: typeof text === "string" ? text.length : -1 };
  } catch (error) {
    return { threw: true, length: -1, error: String(error) };
  }
}

const root = mkdtempSync(join(tmpdir(), 'loom-guard-'));
const dbPath = join(root, 'loom.db');
const surface = makeSurface();

try {
  const agent = { id: SESSION, ctx: { systemPrompt: surface.prompt } };
  apply(makeCtx(surface, [agent]), Config({ path: dbPath, timezone: 'Asia/Shanghai' }));

  const specs = [
    ['persona（section）', surface.sections.get(`memory-loom:persona:${SESSION}`)],
    ['hooks（context）', surface.contexts.get(`memory-loom:hooks:${SESSION}`)],
    ['memory（context）', surface.contexts.get(`memory-loom:memory:${SESSION}`)],
  ];

  console.log('健康状态（数据库可用）');
  const healthy = specs.map(([label, spec]) => {
    const r = callText(spec);
    console.log(`  ${r.threw ? '✗ 抛错' : `✓ 正常（${r.length} 字符）`}  ${label}`);
    return r;
  });

  // 关掉引擎：模拟库被删/损坏/磁盘满——所有 SQL 调用都会抛
  for (const dispose of surface.disposers.splice(0)) {
    try {
      dispose();
    } catch {
      // best effort
    }
  }

  console.log('\n数据库不可用（引擎已关闭，等效于库被删 / 损坏）');
  const degraded = specs.map(([label, spec]) => {
    const r = callText(spec);
    const ok = !r.threw && r.length === 0;
    console.log(`  ${ok ? '✓ 降级为空块' : r.threw ? '✗ 仍然抛错 —— 整轮会失败' : '✗ 返回了内容'}  ${label}`);
    return ok;
  });

  const allHealthy = healthy.every((r) => !r.threw);
  const allDegraded = degraded.every(Boolean);
  console.log(`\n结论：${allHealthy && allDegraded ? '坏库时降级为空块，对话不会被打断' : '存在未兜底的路径'}`);
  process.exitCode = allHealthy && allDegraded ? 0 : 1;
} finally {
  for (const dispose of surface.disposers.splice(0)) {
    try {
      dispose();
    } catch {
      // best effort
    }
  }
  rmSync(root, { recursive: true, force: true });
}
