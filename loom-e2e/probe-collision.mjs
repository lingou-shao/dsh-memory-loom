/**
 * 两个记忆插件同装时会不会互相废掉。
 *
 * 宿主把工具放进 NamedEntries，重名是硬失败。但「硬失败」有三种可能，后果差很远：
 *
 *   a) 只挡住那一件工具，两个插件其余部分照常
 *   b) 后装的那个插件整体加载失败（工具全无、提示词也不挂）
 *   c) 整个宿主起不来
 *
 * 这三条决定了对外该说「可以共存」还是「必须先卸」。所以不用推断，用真实的
 * cordis 上下文 + 真实的 ToolRuntime / SystemPrompt 跑一遍。
 *
 * 跑法：node loom-e2e/probe-collision.mjs
 */

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime from '@deepseek-ai/dsh-tools';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { createLoom } from './harness.mjs';
import { apply, Config } from '../lib/index.js';

let pass = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/** 一个最小的工具定义，形状与插件里 buildTools() 产出的一致。 */
const tool = (name, body) => ({
  name,
  description: `probe tool ${name}`,
  parameters: {},
  output: {
    schema: { type: 'string' },
    render: () => [{ type: 'text', text: body }],
  },
  run: () => body,
});

/** 一个最小的「记忆插件」：注册工具 + 一个 prompt section，并记录自己的状态。 */
function memoryPlugin(label, toolNames) {
  const state = { label, applied: false, registered: [], sections: [], error: null };
  const plugin = {
    name: `probe-${label}`,
    inject: ['tools', 'systemPrompt'],
    apply(ctx) {
      state.applied = true;
      ctx.systemPrompt.section({
        name: `probe-${label}:protocol`,
        order: 100,
        text: () => `${label} protocol`,
        interpolate: false,
      });
      state.sections.push(`probe-${label}:protocol`);
      for (const name of toolNames) {
        ctx.tools.register(tool(name, label));
        state.registered.push(name);
      }
    },
  };
  return { plugin, state };
}

const has = (ctx, name) => ctx.tools.get(name) !== undefined;
const owner = (ctx, name) => {
  const found = ctx.tools.get(name);
  return found === undefined ? '(无)' : found.run();
};
/** 全局层的 prompt section 名（不经过 scoped 覆盖，直接看这一层的登记）。 */
const sections = (ctx) => [...ctx.systemPrompt.layers.merge(undefined, (layer) => layer.sections).keys()];

// ---- 1. 工具名完全不相交 -------------------------------------------------
{
  console.log('\n[1] 两个记忆插件，工具名不重叠');
  const app = new Context();
  await app.plugin(ToolRuntime, {});
  await app.plugin(SystemPrompt, {});
  const a = memoryPlugin('loom', ['loom_search', 'loom_write']);
  const b = memoryPlugin('other', ['memory_search', 'memory_write']);
  await app.plugin(a.plugin);
  await app.plugin(b.plugin);
  check('两个插件都执行了 apply', a.state.applied && b.state.applied);
  check('四个工具都在', ['loom_search', 'loom_write', 'memory_search', 'memory_write'].every((n) => has(app, n)));
  check('两个 prompt section 都在', app.systemPrompt.sections?.has?.('probe-loom:protocol') !== false);
  await app.stop?.();
}

// ---- 2. 撞一个名字：先装别人，后装我们 -----------------------------------
{
  console.log('\n[2] 撞一个名字（memory_search）—— 别人先装，我们后装');
  const app = new Context();
  await app.plugin(ToolRuntime, {});
  await app.plugin(SystemPrompt, {});
  const other = memoryPlugin('other', ['memory_search', 'memory_write']);
  const loom = memoryPlugin('loom', ['memory_search', 'loom_expand', 'loom_doctor']);
  await app.plugin(other.plugin);
  let threw = null;
  try {
    await app.plugin(loom.plugin);
  } catch (error) {
    threw = error;
  }
  check('先装的那个插件完整存活', other.state.applied && has(app, 'memory_search') && has(app, 'memory_write'));
  check('memory_search 仍是先装的那个', owner(app, 'memory_search') === 'other', owner(app, 'memory_search'));
  check('我们没撞的工具也没进表 → 说明是整体回滚，不是单件跳过',
    !has(app, 'loom_expand') && !has(app, 'loom_doctor'),
    `loom_expand=${has(app, 'loom_expand')} loom_doctor=${has(app, 'loom_doctor')}`);
  check('我们的 apply 一开始跑过（说明错误发生在中途）', loom.state.applied === true, `已注册到 ${loom.state.registered.join(',') || '(无)'}`);
  check('我们挂的 prompt section 也一起被撤销（没有留下「教模型用别人的工具」的僵尸提示）',
    !sections(app).includes('probe-loom:protocol'), sections(app).join(','));
  check('宿主没被拖死（进程还能继续）', typeof app.get === 'function');
  console.log(`     apply 抛错：${threw === null ? '（没有抛到调用点）' : `"${String(threw.message).slice(0, 140)}"`}`);
  await app.stop?.();
}

// ---- 3. 顺序反过来：我们先装 ---------------------------------------------
{
  console.log('\n[3] 顺序反过来（我们先装）');
  const app = new Context();
  await app.plugin(ToolRuntime, {});
  await app.plugin(SystemPrompt, {});
  const loom = memoryPlugin('loom', ['memory_search', 'loom_expand']);
  const other = memoryPlugin('other', ['memory_search', 'memory_write']);
  await app.plugin(loom.plugin);
  let threw = null;
  try {
    await app.plugin(other.plugin);
  } catch (error) {
    threw = error;
  }
  check('我们完整存活', has(app, 'memory_search') && has(app, 'loom_expand'));
  check('memory_search 仍是我们', owner(app, 'memory_search') === 'loom', owner(app, 'memory_search'));
  check('后来者的 memory_write 也没进表', !has(app, 'memory_write'), `memory_write=${has(app, 'memory_write')}`);
  console.log(`     apply 抛错：${threw === null ? '（没有抛到调用点）' : `"${String(threw.message).slice(0, 140)}"`}`);
  await app.stop?.();
}

// ---- 4. 真实插件：撞名时说的话 -------------------------------------------
/*
 * 上面三组证明的是宿主行为——重名就整体回滚。这一组证明的是我们自己的
 * 那一层：撞名时不把宿主的 `already registered` 原文丢给用户，而是在打开
 * 数据库之前就停下，说清楚「谁占了、怎么办」。
 */
{
  console.log('\n[4] 真实插件撞上别人的 memory_search');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'collide-')), 'loom.db');
  let threw = null;
  let loom = null;
  try {
    loom = createLoom({ dbPath, presetTools: ['memory_search'], config: { timezone: 'Asia/Shanghai' } });
  } catch (error) {
    threw = error;
  }
  const message = threw === null ? '' : String(threw.message);
  const first = message.split('\n')[0] ?? '';
  check('加载失败，不是半残运行', threw !== null, first.slice(0, 120));
  check('说的是中文，不是宿主的 already registered', /已被另一个插件占用/u.test(message) && !/already registered/u.test(message), first.slice(0, 120));
  check('点出了被占用的具体名字', /memory_search/u.test(message), first.slice(0, 120));
  check('给了「卸载」这条路', /remove/u.test(message));
  check('给了「共存」这条路（toolPrefix）', /toolPrefix/u.test(message));
  check('提到卸载不删记忆', /记忆文件不会被删除/u.test(message));
  check('在打开数据库之前就停下了（没留下半个库）', !existsSync(dbPath), existsSync(dbPath) ? '库被创建了' : '库里没有文件');
  loom?.dispose();
}

// ---- 5. 同名冲突 + 用户设了私名前缀 ---------------------------------------
{
  console.log('\n[5] 撞名，但用户设了 toolPrefix: loom_');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'collide2-')), 'loom.db');
  const loom = createLoom({
    dbPath,
    presetTools: ['memory_search', 'memory_write', 'memory_forget'],
    config: { timezone: 'Asia/Shanghai', toolPrefix: 'loom_', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  // `toolNames()` 是整张表，含预置的三个占名工具；我们自己注册的只看 loom_ 前缀。
  const names = loom.toolNames().filter((name) => name.startsWith('loom_'));
  const all = loom.toolNames();
  check('装得上了', names.length === 15, `${names.length} 个自己的工具，表里共 ${all.length} 个`);
  check('15 个名字全换了前缀', names.length === 15 && all.length === 18, names.slice(0, 3).join(','));
  check('别人占着的三个名字我们一个都没碰', ['memory_search', 'memory_write', 'memory_forget'].every((n) => !names.includes(n)));
  check('memory_search 仍然是别人的', loom.shared.tools.get('memory_search')?.description === 'occupied by another plugin');
  check('协议里教模型用的是新名字', /loom_search/u.test(loom.protocol()) && !/memory_search/u.test(loom.protocol()), '');
  await loom.turn('s1', '下周五去体检。', '记下了。');
  await loom.settle(8);
  const doctor = String(await loom.call('loom_doctor', {}, 's1'));
  check('改名后的工具真能调', /结论/u.test(doctor), doctor.split('\n').filter((row) => row.includes('结论')).join(''));
  loom.dispose();
}

// ---- 6. 非法前缀 ----------------------------------------------------------
{
  console.log('\n[6] toolPrefix 写错');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'collide3-')), 'loom.db');
  const bad = ['loom-', '1loom_', 'loom ', ''];
  const failures = bad.filter((prefix) => {
    try {
      createLoom({ dbPath, config: { timezone: 'Asia/Shanghai', toolPrefix: prefix } }).dispose();
      return false;
    } catch (error) {
      return /toolPrefix/u.test(String(error?.message));
    }
  });
  check('四个非法值都被挡下并说明格式', failures.length === bad.length, `${failures.length}/${bad.length}：${bad.join(',')}`);
}

// ---- 7. 同一进程里第二次 apply 不能误报 --------------------------------
/*
 * 误报比不报更糟：用户会因为一句话去卸一个他根本没装的插件。
 * 场景是同一个进程再 apply 一次（活体重组、patch 里写了两条），此时表里
 * 已经有我们上一次注册的工具对象——它必须被认成「自己的」，不能认成别人的。
 */
{
  console.log('\n[7] 同一个进程里 apply 两次');
  const dbPath = join(mkdtempSync(join(tmpdir(), 'twice-')), 'loom.db');
  const sections = new Map();
  const contexts = new Map();
  const tools = new Map();
  const ctx = {
    systemPrompt: {
      section(spec) {
        if (sections.has(spec.name)) throw new Error(`prompt section "${spec.name}" is already registered`);
        sections.set(spec.name, spec);
        return () => sections.delete(spec.name);
      },
      context(spec) {
        if (contexts.has(spec.name)) throw new Error(`prompt context "${spec.name}" is already registered`);
        contexts.set(spec.name, spec);
        return () => contexts.delete(spec.name);
      },
    },
    on() {},
    effect(factory) {
      factory();
    },
    tools: {
      register(tool) {
        if (tools.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered in this scope`);
        tools.set(tool.name, tool);
      },
      get(name) {
        return tools.get(name);
      },
    },
    logger: () => ({ warn() {}, info() {}, debug() {}, error() {} }),
    get(name, strict = true) {
      if (strict) throw new Error(`service "${name}" is not available`);
      return undefined;
    },
  };
  const settings = Config({ path: dbPath, timezone: 'Asia/Shanghai', consolidation: { enabled: false } });
  apply(ctx, settings);
  let second = null;
  try {
    apply(ctx, settings);
  } catch (error) {
    second = error;
  }
  const message = second === null ? '' : String(second.message);
  check('第二次确实失败（工具与 section 都还在表里）', second !== null, message.split('\n')[0].slice(0, 100));
  check('但不说「已被另一个插件占用」', !/已被另一个插件占用/u.test(message), message.split('\n')[0].slice(0, 100));
  check('失败原因指向重复注册本身', /already registered/u.test(message), message.split('\n')[0].slice(0, 100));
}

console.log(`\n${failed === 0 ? `全部通过（${pass} 项断言）` : `${failed} 项失败（${pass} 项通过）`}`);
process.exit(failed === 0 ? 0 : 1);
