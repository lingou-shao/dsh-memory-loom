/**
 * probe-extract-batch.mjs — 一次调用多段，但一段都不能丢
 *
 * 批量的收益在提示词这一侧：规则块约 2,000 字，一段几十字，逐段调用时它
 * 每段都要重写一遍。省下来的钱不买可靠性，可靠性是另外三件机械事：
 *
 *   1. 一行一段（截断只损失尾行）
 *   2. 段号对账（模型少回一段时，看得出少了哪段）
 *   3. 段号不在册的行整行丢弃（不猜它属于谁）
 *
 * 这三条各自对应一种「不报错的失败」：
 *
 *   - 少回一段：返回的 JSON 完全合法，调用成功，只是少东西。外部实测过
 *     3,031 个 prompt、批 25，一整批 25 个 id 静默消失，9.1%，零报错。
 *   - 截断：一个大数组缺右括号时整份失效，一行对象只丢尾巴。
 *   - 串段：模型把第 3 段的内容写成了 seg 2，条数对得上，对账也看不出来。
 *
 * 还有一条本产品独有的：**批量模式下 quote 变成硬判据**。一般任务里大批量
 * 的代价是漏检，这里编造的事实会永久写进长期库；而大批量下模型的失败模式
 * 恰恰是编造而不是弃答（单文档 50% → 小批 60% → 大批 2.8%）。
 *
 * 全部在临时库里跑。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createLoomWithTimers } from './harness.mjs';
import { mockLlm } from './harness.mjs';

const MIN = 60000;

/** 四段：间隔 40 分钟（> 分段阈值 30 分钟），所以是四段而不是一段。 */
const DIALOGUES = [
  '我不吃香菜，闻着就难受，每次点餐都要特意说一遍不要放。',
  '下周三要去医院复查，我妈非让我早点去挂号，说人多。',
  '今天把同步任务的报错定位到 WAL 锁冲突了，改了重试间隔就好了。',
  '最近在学做红烧肉，糖色总是炒糊，锅一热就控制不住。',
];

/**
 * v0.2.77 那版单段提示词的「规则 + 输出形状」部分的 sha256（到「对话：」之前，
 * 2,177 字）。这一版不改单段提示词，所以它必须原样保持——四套读数「零差异」
 * 这句话有一半建立在它上面。
 *
 * 将来要改规则，就更新这个常量；但更新之前先确认批量侧同步改了，否则
 * 「批量与单段只差指代」这条就不成立了，而下面那组断言只会看见条数对、看不见
 * 内容对不上。
 */
const RULES_SHA_0277 = '59bc39feef72cfdabf6b2aac0671e7bb8381bfe7913731f20588cf313aded7bb';

let pass = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

/**
 * 一行的形状。title 带上段号，用来验证「结果回到正确的段」。
 * @param seg - 段号。
 * @param facts - 该行的事实。
 */
const line = (seg, facts = []) =>
  JSON.stringify({
    seg,
    title: `第${seg}段的事`,
    summary: `第${seg}段的摘要`,
    emotion: { valence: 0, arousal: 0.2, salience: 0.3 },
    impression: null,
    diary: null,
    facts,
  });

/** 单段回复（回落时被调用），形状与 `extractPrompt` 要的 JSON 一致。 */
const singleReply = JSON.stringify({
  title: '单独抽的一段',
  summary: '单独抽的摘要',
  aliases: [],
  emotion: { valence: 0, arousal: 0.2, salience: 0.3 },
  impression: null,
  diary: null,
  facts: [],
});

/**
 * 跑一次整合，拿回提示词、事件与事实。
 * @param options.batchSize - 批量上限，1 = 关闭。
 * @param options.replyOf - 按请求返回回复文本的函数。
 * @param options.dialogues - 对话轮次，默认四段。
 */
async function run({ batchSize = 8, replyOf, dialogues = DIALOGUES } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loom-batch-'));
  const llm = mockLlm(replyOf);
  const { loom, timers } = createLoomWithTimers({
    dbPath: join(root, 'loom.db'),
    llm,
    config: {
      timezone: 'Asia/Shanghai',
      consolidation: { triggerTokens: 1e9, idleMinutes: 0, batchSize },
    },
  });
  for (const dialogue of dialogues) await loom.turn('s1', dialogue, '好。', { gapMs: 40 * MIN });
  await loom.settle(4);
  /*
   * 手动跑一次维护。`triggerTokens` 拉满是为了「攒够四段再一次性整合」：
   * 逐轮触发的话每轮只有一段，批量路径根本不会出现。
   */
  timers.find((timer) => timer.ms === 60000).callback();
  await loom.settle(10);
  loom.dispose();
  const prompts = llm.calls
    .map((call) => String(call.messages?.[0]?.content?.[0]?.text ?? ''))
    .filter((text) => text.length > 0);
  const db = new DatabaseSync(join(root, 'loom.db'), { readOnly: true });
  const events = db.prepare('SELECT id, title FROM events ORDER BY id').all().map((row) => String(row.title));
  const facts = db
    .prepare("SELECT text, evidence FROM facts WHERE status IN ('active','disputed')")
    .all()
    .map((row) => ({ text: String(row.text), evidence: JSON.parse(String(row.evidence || '{}')) }));
  db.close();
  rmSync(root, { recursive: true, force: true });
  return { prompts, events, facts, calls: llm.calls.length };
}

const isBatch = (text) => text.includes('<S1>');
const batchOf = (prompts) => prompts.filter(isBatch);
const singles = (prompts) => prompts.filter((text) => !isBatch(text) && text.includes('抽取值得长期记住'));

try {
  // ---- 1. 批量真的发生了，且编号是代码给的 -----------------------------
  console.log('[1] 四段一次调用');
  const good = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? [1, 2, 3, 4].map((seg) => line(seg)).join('\n') : singleReply) });
  check('四段只用一次批量调用', batchOf(good.prompts).length === 1, `实际 ${batchOf(good.prompts).length}`);
  check('一次调用覆盖四段（没有回落）', singles(good.prompts).length === 0, `单段调用 ${singles(good.prompts).length}`);
  const batchPrompt = batchOf(good.prompts)[0] ?? '';
  check('四个段标签', (batchPrompt.match(/<S\d>/gu) ?? []).length === 4, `实际 ${(batchPrompt.match(/<S\d>/gu) ?? []).length}`);
  check('编号 1..4 由代码写入', ['<S1>', '<S2>', '<S3>', '<S4>'].every((tag) => batchPrompt.includes(tag)));
  check('要求每行带 seg 且原样抄', /每行必须带 "seg"/u.test(batchPrompt) && /原样抄/u.test(batchPrompt));
  check('明确禁止合并/跳号', /不要自己重排、合并或跳号/u.test(batchPrompt));
  check('四段各自成段（不是并成一段）', good.events.length === 4, `事件 ${good.events.length}`);
  check('每段的结果回到自己那一段', good.events.every((title, index) => title.includes(`第${index + 1}段`)), JSON.stringify(good.events));

  // ---- 2. 规则块两边同源，只差指代 ---------------------------------------
  console.log('\n[2] 规则块与单段同源');
  const single = await run({ batchSize: 1, replyOf: () => singleReply });
  const singlePrompt = singles(single.prompts)[0] ?? '';
  /*
   * 按「以 - 开头的行」取，不用「规则：」到「对话」之间切片：规则正文里本来
   * 就有「这段对话里他自己说的具体事」，按关键词切会把规则砍掉一大半。
   */
  const rulesOf = (text) =>
    text
      .split('\n')
      .filter((row) => row.trim().startsWith('- '))
      .map((row) => row.trim());
  const batchRules = rulesOf(batchPrompt);
  const singleRules = rulesOf(singlePrompt);
  const rulesHead = singlePrompt.slice(0, singlePrompt.indexOf('\n对话：'));
  const rulesSha = createHash('sha256').update(rulesHead, 'utf8').digest('hex');
  check('单段规则块与 v0.2.77 逐字节相同', rulesSha === RULES_SHA_0277, `${rulesHead.length} 字，sha256 ${rulesSha.slice(0, 12)}…`);
  check('规则块长度仍是 2,177 字', rulesHead.length === 2177, `实际 ${rulesHead.length}`);
  check('规则条数相同', batchRules.length === singleRules.length, `批量 ${batchRules.length} / 单段 ${singleRules.length}`);
  const differing = batchRules.filter((row, index) => row !== singleRules[index]);
  /*
   * 六处，全部是「这一段 → 每一段/那一段」的指代。这个数字要钉死：多了说明
   * 批量侧改动了实质内容，少了说明新加的规则只写了一边。
   */
  check('只有指代不同，且正好六处', differing.length === 6, `差 ${differing.length} 处`);
  check('批量侧写明「每段最多 8 条」', batchPrompt.includes('每段最多 8 条（不是整批共 8 条）'));
  check('单段侧仍是「最多 8 条」', singlePrompt.includes('- 最多 8 条。') && !singlePrompt.includes('每段最多'));
  check('批量侧要求各段别名不共用', batchPrompt.includes('不要几段共用同一组'));
  check('批量侧标题按段写', batchPrompt.includes('每行的 title、summary、emotion 都是那一段自己的'));

  // ---- 3. 对账：少回一段，只补那一段 ------------------------------------
  console.log('\n[3] 少回一段');
  const missing = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? [1, 2, 4].map((seg) => line(seg)).join('\n') : singleReply) });
  check('批量一次', batchOf(missing.prompts).length === 1);
  check('只补缺失的那一段', singles(missing.prompts).length === 1, `单段调用 ${singles(missing.prompts).length}`);
  check('四段都落库（缺的那段没丢）', missing.events.length === 4, `事件 ${missing.events.length}`);
  check('缺的那段走的是单段结果', missing.events.filter((title) => title === '单独抽的一段').length === 1, JSON.stringify(missing.events));

  // ---- 4. 全部不回：四段各自回落 ----------------------------------------
  console.log('\n[4] 整批没有可用行');
  const nothing = await run({ replyOf: () => '{}\n{}' });
  check('批量一次 + 四段各回一次', batchOf(nothing.prompts).length === 1 && singles(nothing.prompts).length === 4, `批量 ${batchOf(nothing.prompts).length} / 单段 ${singles(nothing.prompts).length}`);
  check('四段都还在', nothing.events.length === 4, `事件 ${nothing.events.length}`);

  // ---- 5. 串段：段号不在册的行整行丢弃 ----------------------------------
  console.log('\n[5] 段号不在册');
  const stray = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? [1, 2, 3, 4, 9].map((seg) => line(seg)).join('\n') : singleReply) });
  check('没有凭空多出第五段', stray.events.length === 4, `事件 ${stray.events.length}`);
  check('九号那行没有冒充任何一段', !stray.events.some((title) => title.includes('第9段')), JSON.stringify(stray.events));
  check('四段正常段没有被牵连', stray.events.filter((title) => /第\d段的事/u.test(title)).length === 4);

  // ---- 6. 截断：只损失尾行 ----------------------------------------------
  console.log('\n[6] 回复被截断');
  const cutReply = [line(1), line(2), '{"seg":3,"title":"第3段的事","summ'];
  const cut = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? cutReply.join('\n') : singleReply) });
  check('前两段用批量结果（没有整批作废）', cut.events.slice(0, 2).every((title, index) => title.includes(`第${index + 1}段`)), JSON.stringify(cut.events));
  check('被截断的段回落单段', cut.events.slice(2).every((title) => title === '单独抽的一段'), JSON.stringify(cut.events));
  check('只回落两段，不是四段', singles(cut.prompts).length === 2, `单段调用 ${singles(cut.prompts).length}`);

  // ---- 7. 解析容错：数组、围栏、一行两个对象 ----------------------------
  console.log('\n[7] 不按约定但能救回来的形状');
  const asArray = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? `[\n${[1, 2, 3, 4].map((seg) => line(seg)).join(',\n')}\n]` : singleReply) });
  check('整体数组也能逐行救回', singles(asArray.prompts).length === 0, `单段调用 ${singles(asArray.prompts).length}`);
  const fenced = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? '```json\n' + [1, 2, 3, 4].map((seg) => line(seg)).join('\n') + '\n```' : singleReply) });
  check('代码围栏不影响解析', singles(fenced.prompts).length === 0, `单段调用 ${singles(fenced.prompts).length}`);
  const crowded = await run({ replyOf: (request) => (String(request.messages?.[0]?.content?.[0]?.text ?? '').includes('<S1>') ? `${line(1)} ${line(2)}\n${line(3)}\n${line(4)}` : singleReply) });
  check('一行两个对象也救得回来', singles(crowded.prompts).length === 0, `单段调用 ${singles(crowded.prompts).length}`);

  // ---- 8. 批量模式下 quote 是硬判据 ------------------------------------
  console.log('\n[8] 批量模式：写不出出处的整条丢掉');
  /*
   * 第 1 段的原文是「我不吃香菜，闻着就难受，每次点餐都要特意说一遍不要放。」
   * 三条事实，只有第一条的 quote 能在原文里找到。
   */
  const quoteCase = await run({
    replyOf: (request) => {
      const text = String(request.messages?.[0]?.content?.[0]?.text ?? '');
      if (!text.includes('<S1>')) return singleReply;
      const facts = [
        { text: '用户不吃香菜', kind: 'fact', ttl: null, confidence: 0.9, quote: '我不吃香菜' },
        { text: '用户对芒果过敏', kind: 'fact', ttl: null, confidence: 0.9, quote: '用户对芒果过敏，碰都不能碰' },
        { text: '用户每次点餐都提醒不要香菜', kind: 'fact', ttl: null, confidence: 0.9, quote: '' },
      ];
      return [1, 2, 3, 4].map((seg) => line(seg, seg === 1 ? facts : [])).join('\n');
    },
  });
  const kept = quoteCase.facts.map((row) => row.text);
  check('对得上原文的那条留下', kept.some((text) => text.includes('不吃香菜') && !text.includes('提醒')), JSON.stringify(kept));
  check('原文里没有的编造被丢掉', !kept.some((text) => text.includes('芒果')), JSON.stringify(kept));
  check('没给 quote 的被丢掉', !kept.some((text) => text.includes('提醒')), JSON.stringify(kept));
  check('只留下一条', kept.length === 1, `${kept.length} 条`);

  // ---- 9. 单段模式不受影响 ----------------------------------------------
  console.log('\n[9] 单段模式仍是「只记不拦」');
  const singleMode = await run({
    batchSize: 1,
    replyOf: () =>
      JSON.stringify({
        title: '单独一段',
        summary: '摘要',
        aliases: [],
        emotion: { valence: 0, arousal: 0.2, salience: 0.3 },
        impression: null,
        diary: null,
        facts: [{ text: '用户对芒果过敏', kind: 'fact', ttl: null, confidence: 0.9, quote: '用户对芒果过敏，碰都不能碰' }],
      }),
  });
  check('单段模式没有段标签', singles(singleMode.prompts).length === 4);
  /*
   * 四条原文一模一样的事实会被判重合并成一条，所以这里断言「进了库」而不是
   * 「进了四条」——要测的是判据有没有收紧，不是去重。
   */
  check('单段模式照样入库（判据只在批量收紧）', singleMode.facts.length >= 1, `事实 ${singleMode.facts.length}`);
  check('单段模式照旧记录 quoteVerified', singleMode.facts.every((row) => row.evidence.quoteVerified === false), JSON.stringify(singleMode.facts[0]?.evidence ?? {}));

  // ---- 10. 关闭批量 ------------------------------------------------------
  console.log('\n[10] batchSize=1 回到逐段');
  check('四段四次抽取调用', singles(singleMode.prompts).length === 4, `实际 ${singles(singleMode.prompts).length}`);
} catch (error) {
  failed++;
  console.error('探针自身出错：', error);
}

console.log(`\n${pass} 通过，${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
