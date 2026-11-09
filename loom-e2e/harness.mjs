/**
 * Minimal harness that runs the *real* dsh-memory-loom bundle against a fake
 * cordis context.
 *
 * Only four host surfaces are faked, which are exactly the ones the plugin
 * declares in its coupling table (design.md §2): systemPrompt.section/context,
 * session events, agent events, and the tool registry. `defineTool` and the
 * Config schema are the genuine @deepseek-ai packages from the local dsh
 * install, so argument validation and defaults are real.
 *
 * The `llm` service is optional: pass `options.llm` (see `mockLlm`) to exercise
 * the model path, omit it to run the rule-only path every other probe uses.
 */

import { apply, Config } from '../lib/index.js';

export const DAY = 86400000;
export const MIN = 60000;

function createShared(shared) {
  return {
    section(spec) {
      shared.sections.set(spec.name, spec);
      return () => shared.sections.delete(spec.name);
    },
    context(spec) {
      shared.contexts.set(spec.name, spec);
      return () => shared.contexts.delete(spec.name);
    },
  };
}

/**
 * A stand-in for the host `llm` service.
 *
 * The plugin only needs four members: `listProviders`, `listModels`, `stream`.
 * `stream` is called once per model request and yields a text delta followed by
 * a `finish` chunk, which is exactly the shape `createLlmBridge` consumes.
 *
 * @param reply - fixed text, or a function of the request returning text.
 * @returns the fake service, with `calls` holding every request it received.
 */
export function mockLlm(reply) {
  const calls = [];
  return {
    calls,
    listProviders: () => [{ id: 'probe' }],
    listModels: async () => [{ id: 'probe-1' }],
    async *stream(request) {
      calls.push(request);
      yield { type: 'text-delta', text: typeof reply === 'function' ? reply(request) : reply };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
  };
}

/**
 * Boot the plugin on a store.
 * @param options.dbPath - SQLite file to use.
 * @param options.config - overrides merged into the real defaults.
 * @param options.llm - fake `llm` service; omitting it runs the rule-only mode.
 */
export function createLoom({ dbPath, config = {}, llm, presetTools = [] }) {
  const shared = { sections: new Map(), contexts: new Map(), handlers: new Map(), tools: new Map(), disposers: [] };
  const systemPrompt = createShared(shared);
  /*
   * Names another plugin already took. The real registry refuses a duplicate,
   * so seeding them here is how a probe reproduces "someone installed a second
   * memory plugin first" without installing one.
   */
  for (const name of presetTools) shared.tools.set(name, { name, description: 'occupied by another plugin' });

  const ctx = {
    systemPrompt,
    on(event, handler) {
      const list = shared.handlers.get(event) ?? [];
      list.push(handler);
      shared.handlers.set(event, list);
    },
    effect(factory) {
      const disposer = factory();
      if (typeof disposer === 'function') shared.disposers.push(disposer);
    },
    tools: {
      register(tool) {
        shared.tools.set(tool.name, tool);
      },
      /**
       * The real registry keys tools by name and exposes `get`. The plugin uses
       * it to refuse a load that would collide with another memory plugin, so a
       * harness without it would only ever exercise the happy path.
       */
      get(name) {
        return shared.tools.get(name);
      },
    },
    logger: () => ({ warn: () => {}, info: () => {}, debug: () => {}, error: () => {} }),
    // Without `options.llm` no service is provided on purpose: that exercises
    // the rule-only mode and the "host has no `agents` registry" fallback.
    get(name, strict = true) {
      if (name === 'llm' && llm !== undefined) return llm;
      if (strict) throw new Error(`service "${name}" is not available`);
      return undefined;
    },
  };

  const settings = Config({ path: dbPath, ...config });
  apply(ctx, settings);

  const agents = new Map();
  const clocks = new Map();
  const turns = new Map();

  const agentOf = (sessionId) => {
    let agent = agents.get(sessionId);
    if (agent === undefined) {
      agent = { id: sessionId, ctx: { systemPrompt } };
      agents.set(sessionId, agent);
      emit('agent/created', { agent });
    }
    return agent;
  };

  const emit = (event, ...args) => {
    for (const handler of shared.handlers.get(event) ?? []) {
      try {
        handler(...args);
      } catch (error) {
        console.error(`handler for ${event} threw:`, error);
        throw error;
      }
    }
  };

  const settle = async (rounds = 4) => {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 15));
  };

  /**
   * Send one user turn and its assistant reply.
   * @param sessionId - the session.
   * @param user - user text.
   * @param assistant - assistant text.
   * @param options.gapMs - virtual gap before this turn.
   * @param options.at - absolute virtual time for this turn, in epoch ms.
   *
   * `at` 是为「时间题」加的。默认起点是 `Date.now() - 3 * DAY`（模拟一个开了三天的
   * 会话），这对「几小时前」这类断言够用，但把语料按真实时间轴灌进来时，整条时间线
   * 会整体错位三天——而 chat-memory-bench 里一半的题问的正是「那天是几号」。
   * 这时时间线本身错了三天，量出来的就不是插件的问题。给了 `at` 就跳过推算。
   */
  async function turn_(sessionId, user, assistant, options = {}) {
    agentOf(sessionId);
    const start = clocks.get(sessionId) ?? Date.now() - 3 * DAY;
    const at = options.at ?? start + (options.gapMs ?? 2 * MIN);
    clocks.set(sessionId, at);
    const turn = (turns.get(sessionId) ?? 0) + 1;
    turns.set(sessionId, turn);

    emit('session/event', { id: sessionId }, { type: 'turn/start', data: { turn }, time: at });
    emit('session/event', { id: sessionId }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: user }] },
      time: at,
    });
    emit('session/event', { id: sessionId }, {
      type: 'assistant/message',
      data: { turn, message: { content: [{ type: 'text', text: assistant }] } },
      time: at + 1000,
    });
    emit('agent/turn-stopping', { agent: agentOf(sessionId) });
    await settle();
    return { turn, at };
  }

  return {
    shared,
    settings,
    turn: turn_,
    /** The rendered memory block the model would see on this session's next step. */
    memoryBlock(sessionId) {
      agentOf(sessionId);
      const spec = shared.contexts.get(`memory-loom:memory:${sessionId}`);
      return spec === undefined ? '' : spec.text();
    },
    /** The rendered hook-index block (rendered *before* the memory block). */
    indexBlock(sessionId) {
      agentOf(sessionId);
      const spec = shared.contexts.get(`memory-loom:hooks:${sessionId}`);
      return spec === undefined ? '' : spec.text();
    },
    persona(sessionId) {
      agentOf(sessionId);
      const spec = shared.sections.get(`memory-loom:persona:${sessionId}`);
      return spec === undefined ? '' : spec.text();
    },
    protocol() {
      const spec = shared.sections.get('memory-loom:protocol');
      return spec === undefined ? '' : spec.text();
    },
    /** Invoke a registered tool the way the host would. */
    async call(name, args, sessionId) {
      const tool = shared.tools.get(name);
      if (tool === undefined) throw new Error(`no tool named ${name}`);
      return tool.execute(args, { agent: agentOf(sessionId) });
    },
    toolNames() {
      return [...shared.tools.keys()];
    },
    emit,
    settle,
    dispose() {
      for (const disposer of shared.disposers.splice(0)) {
        try {
          disposer();
        } catch {
          // best effort
        }
      }
    },
  };
}

/**
 * Boot the plugin with its interval timers captured instead of started.
 *
 * Maintenance is a 60-second timer in real use, and no probe can wait three
 * minutes to find out what it does to a row. Calling the captured callback once
 * runs exactly the code the host would run at minute three — no stub, no
 * re-implementation of the sweep, so the assertion cannot drift away from the
 * behaviour. `timers` holds `{ callback, ms }` in the order they were set.
 *
 * @param options - same shape as `createLoom`.
 * @returns the loom and the timers it would have started.
 */
export function createLoomWithTimers(options) {
  const timers = [];
  const real = globalThis.setInterval;
  globalThis.setInterval = (callback, ms) => {
    timers.push({ callback, ms });
    return 0;
  };
  try {
    return { loom: createLoom(options), timers };
  } finally {
    globalThis.setInterval = real;
  }
}
