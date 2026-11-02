/**
 * probe-alias-prompt.mjs — 别名走不走模型那条路
 *
 * probe-aliases.mjs 用 `memory_write` 手工写别名，证明「有别名就能召回」。
 * 但生产里绝大多数事实是整合时由模型抽出来的，那条路上真正要回答的是另外
 * 三个问题：
 *   1. 抽取提示词有没有把 aliases 写进去（改了代码但提示词没提，模型不会给）；
 *   2. 模型给回来的 aliases 有没有被解析、清洗、落进索引；
 *   3. aliasCount=0 时提示词不能还挂着这个字段（关了就该干净）。
 *
 * 只用一个假 `llm` 服务，不接触真实库。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom, mockLlm } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-alias-prompt-'));
const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);
const promptOf = (request) => String(request.messages?.[0]?.content?.[0]?.text ?? '');
const isExtract = (request) => String(request.system ?? '').includes('记忆整理器');
const JUDGE_REPLY = '{"results":[{"index":0,"relation":"unrelated","target":null,"salience":0.2,"ttl":null}]}';

const FACT_TEXT = '用户辞职后一直没跟家里说，怕父母担心';
const GOOD = JSON.stringify({
  title: '辞职没敢跟家里说',
  summary: '用户辞了职，一直瞒着父母，怕他们担心。',
  aliases: ['辞职', '瞒着家里'],
  emotion: { valence: -0.3, arousal: 0.3, salience: 0.6 },
  impression: null,
  diary: null,
  facts: [{ text: FACT_TEXT, kind: 'fact', ttl: null, confidence: 0.9, aliases: ['辞职', '没告诉爸妈', '瞒着我妈'] }]
});

/** 四个别名里两个该被丢：泛词「工作」、超过 6 字的整句。 */
const DIRTY = JSON.stringify({
  title: '辞职没敢跟家里说',
  summary: '用户辞了职，一直瞒着父母。',
  aliases: [],
  emotion: { valence: -0.3, arousal: 0.3, salience: 0.6 },
  impression: null,
  diary: null,
  facts: [
    {
      text: FACT_TEXT,
      kind: 'fact',
      ttl: null,
      confidence: 0.9,
      aliases: ['工作', '这是一句明显超过六个字的长别名', '没告诉爸妈', '没告诉爸妈']
    }
  ]
});

const looms = [];

function boot(reply, config = {}) {
  const dir = mkdtempSync(join(root, 'db-'));
  const llm = mockLlm(reply);
  const loom = createLoom({
    dbPath: join(dir, 'loom.db'),
    llm,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0, ...config } }
  });
  looms.push(loom);
  return { loom, llm };
}

/** 记一轮对话并等整合跑完。 */
async function talk(loom, user) {
  await loom.turn('s-alias', user, '嗯，先别急，你想怎么跟他们说？');
}

try {
  const good = boot((request) => (isExtract(request) ? GOOD : JUDGE_REPLY));
  await talk(good.loom, '我辞职了，一直没敢跟家里说，怕我爸妈担心');
  await good.loom.settle(8);

  const extractCall = good.llm.calls.find((request) => isExtract(request));
  const prompt = extractPromptOf(extractCall);
  check('抽取提示词要求 aliases', /aliases/u.test(prompt), '提示词里出现了 aliases 字段');
  check('提示词给了条数上限', /2–3 个/u.test(prompt), '要求 2–3 个');
  check('提示词挡了泛词', /「工作」「心情」/u.test(prompt), '明确点出不要写泛词');
  check('提示词给了 JSON 结构', /"aliases":\[\]/u.test(prompt), 'JSON 模板里有 aliases');
  check('模型路径真的被调用', extractCall !== undefined, `模型被调用 ${good.llm.calls.length} 次`);

  const byAlias = await good.loom.call('memory_search', { query: '没告诉爸妈' }, 's-alias');
  check('别名让换说法搜得到', byAlias.includes('辞职'), byAlias.split('\n')[0]);
  const byAlias2 = await good.loom.call('memory_search', { query: '瞒着我妈' }, 's-alias');
  check('第二个别名也生效', byAlias2.includes('辞职'), byAlias2.split('\n')[0]);
  const byOriginal = await good.loom.call('memory_search', { query: '辞职' }, 's-alias');
  check('原文仍然搜得到', byOriginal.includes('辞职'), byOriginal.split('\n')[0]);

  // ---- 关掉之后不能还挂着字段 -------------------------------------------
  const off = boot((request) => (isExtract(request) ? GOOD : JUDGE_REPLY), { aliasCount: 0 });
  await talk(off.loom, '我辞职了，一直没敢跟家里说，怕我爸妈担心');
  await off.loom.settle(8);
  const offPrompt = extractPromptOf(off.llm.calls.find((request) => isExtract(request)));
  check('aliasCount=0 时提示词不提 aliases', !/aliases/u.test(offPrompt), '关闭后提示词干净');
  const offSearch = await off.loom.call('memory_search', { query: '没告诉爸妈' }, 's-alias');
  check('关闭后别名不生效（A 臂对照）', !offSearch.includes('辞职'), offSearch.split('\n')[0]);

  // ---- 脏别名 -----------------------------------------------------------
  const dirty = boot((request) => (isExtract(request) ? DIRTY : JUDGE_REPLY));
  await talk(dirty.loom, '我辞职了，一直没敢跟家里说，怕我爸妈担心');
  await dirty.loom.settle(8);
  const generic = await dirty.loom.call('memory_search', { query: '工作上的事' }, 's-alias');
  check('泛词别名被丢弃', !generic.includes('辞职'), generic.split('\n')[0]);
  const clean = await dirty.loom.call('memory_search', { query: '没告诉爸妈' }, 's-alias');
  check('干净的别名仍生效', clean.includes('辞职'), clean.split('\n')[0]);
  const doctor = await dirty.loom.call('memory_doctor', {}, 's-alias');
  check('memory_doctor 报告别名覆盖', /检索别名/u.test(doctor), (doctor.split('\n').find((line) => line.includes('检索别名')) ?? '').trim());
} catch (error) {
  check('探针本身没崩', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' / '));
} finally {
  // Windows keeps the sqlite file locked until every handle is closed.
  for (const loom of looms) {
    try {
      loom.dispose();
    } catch {}
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

/** `mockLlm` records the raw request; the plugin sends the prompt as one text part. */
function extractPromptOf(request) {
  return request === undefined ? '' : promptOf(request);
}

let failed = 0;
for (const [label, ok, detail] of results) {
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
}
console.log('');
process.exit(failed === 0 ? 0 : 1);
