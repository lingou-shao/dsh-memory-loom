/**
 * Probe: does the memory prompt say anything when it goes blind, and can the
 * model find out why?
 *
 * Two behaviours under test (v0.2.14):
 *
 * 1. Degrade notice. guardPrompt() alone returned "" — the turn survived, but
 *    the model had no way to know it had lost its memory, so it answered with
 *    the same confidence as always. After PROMPT_NOTICE_AFTER (3) consecutive
 *    failures the memory block now carries one short status line.
 * 2. memory_doctor. A read-only report that pinpoints which probe failed
 *    (connection / file / WAL / journal / integrity / counts / last recall /
 *    prompt blocks). It must never throw — a dead DB is exactly when the model
 *    will call it.
 *
 * Run: node loom-e2e/probe-degrade-notice.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { apply, Config } = await import('../lib/index.js');

const SESSION = 'session-notice';
const NOTICE = '【记忆状态】';

function makeSurface() {
  const sections = new Map();
  const contexts = new Map();
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
  return { sections, contexts, tools, prompt, disposers };
}

function makeCtx(surface, liveAgents) {
  return {
    systemPrompt: surface.prompt,
    on() {},
    effect(factory) {
      const disposer = factory();
      surface.disposers.push(() => {
        if (typeof disposer === 'function') disposer();
      });
    },
    tools: { register(tool) { surface.tools.set(tool.name, tool); } },
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    get(name, strict = true) {
      if (name === 'agents') return { list: () => [...liveAgents] };
      if (strict) throw new Error(`service "${name}" is not available`);
      return undefined;
    },
  };
}

function read(spec) {
  try {
    const text = typeof spec.text === 'function' ? spec.text({}) : spec.text;
    return { threw: false, text };
  } catch (error) {
    return { threw: true, text: '', error: String(error) };
  }
}

/** Tool objects expose `execute(args, exec)`; it may return a string or a promise. */
async function callTool(tool, exec) {
  try {
    const out = await tool.execute({}, exec);
    return { threw: false, text: typeof out === 'string' ? out : String(out?.content?.[0]?.text ?? out?.text ?? out) };
  } catch (error) {
    return { threw: true, text: '', error: String(error) };
  }
}

const root = mkdtempSync(join(tmpdir(), 'loom-notice-'));
const dbPath = join(root, 'loom.db');
const surface = makeSurface();
const results = [];

try {
  const agent = { id: SESSION, ctx: { systemPrompt: surface.prompt } };
  apply(makeCtx(surface, [agent]), Config({ path: dbPath, timezone: 'Asia/Shanghai' }));

  const memory = () => surface.contexts.get(`memory-loom:memory:${SESSION}`);
  const persona = () => surface.sections.get(`memory-loom:persona:${SESSION}`);
  const hooks = () => surface.contexts.get(`memory-loom:hooks:${SESSION}`);

  const healthy = read(memory());
  const healthyClean = !healthy.threw && !healthy.text.includes(NOTICE);
  results.push(['健康时不出状态行', healthyClean, healthyClean ? `${healthy.text.length} 字符，无提示` : '健康时就带了状态行']);

  const doctor = surface.tools.get('memory_doctor');
  results.push(['memory_doctor 已注册', doctor !== undefined, doctor === undefined ? '未注册' : '已注册']);

  if (doctor !== undefined) {
    const report = (await callTool(doctor, { agent })).text;
    const sound = report.includes('✓ 库连接') && report.includes('未发现故障');
    results.push(['健康时自检报「未发现故障」', sound, `${report.split('\n').length} 行`]);
    if (!sound) console.log(report);
  }

  // 关掉引擎会连带撤掉每个会话挂的三块 prompt，spec 必须先抓在手里
  const memorySpec = memory();
  const personaSpec = persona();
  const hooksSpec = hooks();

  // 关掉引擎：等效于库被删 / 损坏 / 磁盘满
  for (const dispose of surface.disposers.splice(0)) {
    try { dispose(); } catch { /* best effort */ }
  }

  const first = read(memorySpec);
  const second = read(memorySpec);
  const third = read(memorySpec);
  const silent = !first.threw && first.text === '' && !second.threw && second.text === '';
  results.push(['前两次失败保持静默', silent, silent ? '第 1、2 次均为空块' : `第1次=${first.text.length} 第2次=${second.text.length}`]);
  const noticed = !third.threw && third.text.includes(NOTICE);
  results.push(['第三次失败插入状态行', noticed, noticed ? `「${third.text.slice(0, 28)}…」` : `实际：${third.text.slice(0, 40)}`]);
  const actioned = noticed && third.text.includes('memory_doctor') && third.text.includes('不要凭印象编造');
  results.push(['状态行要求别硬编 + 指向自检', actioned, actioned ? '含两条指令' : '缺少指令']);

  const others = [read(personaSpec), read(hooksSpec)];
  const onlyMemory = others.every((r) => !r.threw && r.text === '');
  results.push(['状态行只出现一次（persona/hooks 仍为空）', onlyMemory, onlyMemory ? '未重复注入' : '有块吐了内容']);

  const broken = doctor === undefined ? { threw: true, text: '工具未注册' } : await callTool(doctor, { agent });
  const threw = broken.threw;
  const brokenReport = broken.text;
  const pinpoint = !threw && brokenReport.includes('✗ 库连接') && brokenReport.includes('下一步');
  results.push(['坏库时自检不抛错且定位到连接', pinpoint, threw ? '抛错' : pinpoint ? '含 ✗ 库连接 + 下一步' : '报告不完整']);
  if (threw || !pinpoint) console.log(brokenReport);

  console.log('结论（v0.2.14 降级提示 + 自检）');
  for (const [name, pass, detail] of results) console.log(`  ${pass ? '✓' : '✗'} ${name} —— ${detail}`);
  const allPass = results.every(([, pass]) => pass);
  console.log(`\n${allPass ? '全部通过：失忆可感知、原因可查、对话不中断' : '有未通过的项'}`);
  console.log('注：库恢复正常后的计数清零走 notePromptSuccess()，未做故障注入验证。');
  process.exitCode = allPass ? 0 : 1;
} finally {
  for (const dispose of surface.disposers.splice(0)) {
    try { dispose(); } catch { /* best effort */ }
  }
  rmSync(root, { recursive: true, force: true });
}
