/**
 * probe-extract-quote.mjs — 抽出来的那条事实，原文里到底有没有
 *
 * 模型抽一条「用户对芒果过敏」，此前没有任何东西能判断这话是不是它编的：
 * `evidence` 里只存了 `ttlPhrase` 和 `duePrecision`，没有出处。所以幻觉进库
 * 之后是**无声的**——行在、能搜到、读起来还通顺。
 *
 * 这一版加的是一个校验位，不是一次重传：抽取时多问一句「支撑这句话的原文
 * 是哪些字」，写入前在本地做一次子串比对（`quoteMatches`）。不调第二次模型，
 * 不加表、不加索引。三个结局要分清，混成一个就等于没做：
 *
 *   true   原文里找到了
 *   false  没找到——可能是编的，也可能是改写主语造成的（见第 3 组）
 *   null   没给 quote，或短到没法判。**不是失败**，不能算进误报率
 *
 * 第一版只记录、不拦截。因为提取提示词要求把主语写成「用户」，模型很容易把
 * 这个改写带进 quote：「原文是我，我照抄成了用户」。这类误报和真编造在字符串
 * 层面长得一模一样，先攒数据才分得开。
 *
 * 全部在临时库里跑，不接触真实库。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, mockLlm } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-quote-'));
let pass = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const looms = [];

/**
 * 跑一段对话，抽出指定的 facts，把库里的 evidence 读回来。
 * @param dialogue 用户那一句。
 * @param facts 假模型给的 facts 数组（原样塞进 JSON）。
 * @returns 事实行与 doctor 输出。
 */
async function run(dialogue, facts) {
  const dbPath = join(mkdtempSync(join(root, 'db-')), 'loom.db');
  const llm = mockLlm(JSON.stringify({
    title: '随便一段',
    summary: '用户说了一句话。',
    aliases: [],
    emotion: { valence: 0, arousal: 0.2, salience: 0.3 },
    impression: null,
    diary: null,
    facts,
  }));
  const loom = createLoom({
    dbPath,
    llm,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  looms.push(loom);
  const session = `s-${Math.random().toString(36).slice(2, 8)}`;
  await loom.turn(session, dialogue, '嗯。');
  await loom.settle(8);
  const doctor = String(await loom.call('memory_doctor', {}, session));
  loom.dispose();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db
    .prepare("SELECT text, evidence FROM facts WHERE status IN ('active','disputed')")
    .all()
    .map((row) => ({ text: String(row.text), evidence: JSON.parse(String(row.evidence || '{}')) }));
  db.close();
  return { rows, doctor, prompt: llm.calls.find((call) => String(call.system ?? '').includes('记忆整理器')) };
}

const ev = (rows, needle) => rows.find((row) => row.text.includes(needle))?.evidence;

try {
  // ---- 1. 提示词里的那一条 -----------------------------------------------
  console.log('[1] 抽取提示词要求带出处');
  const first = await run('我不吃香菜，闻着就难受。', [
    { text: '用户不吃香菜', kind: 'fact', ttl: null, confidence: 0.9, quote: '我不吃香菜' },
    { text: '用户闻到香菜就难受', kind: 'fact', ttl: null, confidence: 0.9, quote: '我不吃香菜 闻着就难受' },
  ]);
  const prompt = String(first.prompt?.messages?.[0]?.content?.[0]?.text ?? '');
  check('要求每条事实给 quote', /每条事实再给 quote/u.test(prompt));
  check('说清是逐字复制、不是改写', /逐字复制/u.test(prompt));
  check('点名了主语改写这个坑', /原文说「我」就写「我」/u.test(prompt));
  check('说清不连续片段用省略号', /「……」隔开/u.test(prompt));
  check('说清写不出 quote 就删掉这条', /写不出 quote 的事实/u.test(prompt));
  check('输出的 JSON 模板里有 quote 字段', /"confidence":0\.8,"quote":""/u.test(prompt));

  // ---- 2. 逐字摘抄：对得上 -----------------------------------------------
  console.log('\n[2] 逐字摘抄');
  check('quoteVerified 为 true', ev(first.rows, '不吃香菜')?.quoteVerified === true, JSON.stringify(ev(first.rows, '不吃香菜')));
  check('摘抄原文留下了（能回头查）', String(ev(first.rows, '不吃香菜')?.quote ?? '').includes('我不吃香菜'));
  check('标点不同不算改写', ev(first.rows, '闻到香菜')?.quoteVerified === true, JSON.stringify(ev(first.rows, '闻到香菜')));

  // ---- 3. 编造的摘抄：对不上，但事实照样进库 -----------------------------
  /*
   * 两条都要在库里。第二版如果开始拦截，先看这一组——「用户不吃香菜」这条
   * 事实本身是对的，错的只是它的 quote 被改写了主语。按 quote 决定要不要这
   * 条事实，就会把一条真事扔掉。所以第一版只标不拦。
   */
  console.log('\n[3] 编造与改写：都标出来，都不拦');
  const third = await run('我不吃香菜，闻着就难受。', [
    { text: '用户对芒果过敏', kind: 'fact', ttl: null, confidence: 0.9, quote: '用户对芒果过敏，碰都不能碰' },
    { text: '用户不吃香菜', kind: 'fact', ttl: null, confidence: 0.9, quote: '用户不吃香菜' },
  ]);
  check('原文里没有的摘抄 → false', ev(third.rows, '芒果')?.quoteVerified === false, JSON.stringify(ev(third.rows, '芒果')));
  check('主语被改写的摘抄 → false（已知误报）', ev(third.rows, '香菜')?.quoteVerified === false, JSON.stringify(ev(third.rows, '香菜')));
  check('对不上的两条事实仍然在库里', third.rows.length === 2, `${third.rows.length} 条`);

  // ---- 4. 没给 quote / 太短：不算失败 ------------------------------------
  console.log('\n[4] 没有可校验的摘抄');
  const fourth = await run('我不吃香菜，闻着就难受。', [
    { text: '用户不吃香菜', kind: 'fact', ttl: null, confidence: 0.9 },
    { text: '用户闻不得香菜味', kind: 'fact', ttl: null, confidence: 0.9, quote: '好' },
  ]);
  const noQuote = ev(fourth.rows, '不吃香菜');
  const shortQuote = ev(fourth.rows, '闻不得');
  check('没给 quote 时不写这个键', noQuote !== undefined && !('quoteVerified' in noQuote), JSON.stringify(noQuote));
  check('短到没法判的 quote 也当没给', shortQuote !== undefined && !('quoteVerified' in shortQuote), JSON.stringify(shortQuote));
  check('两条都照常进库', fourth.rows.length === 2, `${fourth.rows.length} 条`);

  // ---- 5. 省略号跨段：每段都要在 -----------------------------------------
  console.log('\n[5] 省略号隔开的两段');
  const fifth = await run('下周三去北京，挂的是上午的号，别安排在下午。', [
    { text: '用户下周三去北京，挂的是上午的号', kind: 'plan', ttl: '下周三', confidence: 0.9, quote: '下周三去北京……挂的是上午的号' },
    { text: '用户下周三去北京的安排要避开下午', kind: 'plan', ttl: '下周三', confidence: 0.9, quote: '下周三去北京……下午的号' },
  ]);
  check('两段都在原文里 → true', ev(fifth.rows, '上午的号')?.quoteVerified === true, JSON.stringify(ev(fifth.rows, '上午的号')));
  check('有一段不在原文里 → false', ev(fifth.rows, '避开下午')?.quoteVerified === false, JSON.stringify(ev(fifth.rows, '避开下午')));

  // ---- 6. 医生把这件事报出来 ---------------------------------------------
  console.log('\n[6] memory_doctor');
  check('全对得上时报「全部对得上」', /引用核对\s+\d+ 条带出处，全部对得上/u.test(first.doctor), (first.doctor.split('\n').find((row) => row.includes('引用核对')) ?? '').trim());
  check('有对不上的先报问题', /✗ 引用核对\s+2 条带出处，2 条对不上原文/u.test(third.doctor), (third.doctor.split('\n').find((row) => row.includes('引用核对')) ?? '').trim());
  check('没有可校验的行时这行不出现', !/引用核对/u.test(fourth.doctor), (fourth.doctor.split('\n').find((row) => row.includes('引用核对')) ?? '（没有这一行）').trim());

  // ---- 7. 按它自己的建议删掉之后，那一行要消失 ---------------------------
  /*
   * 这一行的建议是「确实是编的就 memory_forget」。而软删除只是把状态改成
   * pending_delete——如果医生还照旧统计它，用户照着做完 ✗ 还在屏幕上，那条
   * 建议就等于没用；下一次他会学会跳过医生的输出。所以只能数活着的行。
   */
  console.log('\n[7] 删掉之后不再算');
  const dbPath7 = join(mkdtempSync(join(root, 'db-')), 'loom.db');
  const llm7 = mockLlm(JSON.stringify({
    title: '随便一段',
    summary: '用户说了一句话。',
    aliases: [],
    emotion: { valence: 0, arousal: 0.2, salience: 0.3 },
    impression: null,
    diary: null,
    facts: [{ text: '用户对芒果过敏', kind: 'fact', ttl: null, confidence: 0.9, quote: '用户对芒果过敏，碰都不能碰' }],
  }));
  const loom7 = createLoom({
    dbPath: dbPath7,
    llm: llm7,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  looms.push(loom7);
  const session7 = 's-quote-forget';
  await loom7.turn(session7, '我不吃香菜，闻着就难受。', '嗯。');
  await loom7.settle(8);
  const before = String(await loom7.call('memory_doctor', {}, session7));
  const quoteLine = (text) => (text.split('\n').find((row) => row.includes('引用核对')) ?? '（没有这一行）').trim();
  check('先报出问题，并点名是哪条', /✗ 引用核对/u.test(before) && before.includes('芒果'), quoteLine(before));
  const probeDb = new DatabaseSync(dbPath7, { readOnly: true });
  const factId = Number(probeDb.prepare("SELECT id FROM facts WHERE text LIKE '%芒果%'").get()?.id ?? 0);
  probeDb.close();
  const forget = String(await loom7.call('memory_forget', { id: factId }, session7));
  check('软删除那条', forget.includes('已标记删除') && forget.includes('芒果'), forget);
  const after = String(await loom7.call('memory_doctor', {}, session7));
  check('删完 ✗ 不再出现（只数活着的行）', !/✗ 引用核对/u.test(after), quoteLine(after));
} catch (error) {
  check('探针本身没崩', false, String(error?.stack ?? error).split('\n').slice(0, 3).join(' / '));
} finally {
  for (const loom of looms) {
    try {
      loom.dispose();
    } catch {}
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${failed === 0 ? `全部通过（${pass} 项断言）` : `${failed} 项失败（${pass} 项通过）`}`);
process.exit(failed === 0 ? 0 : 1);
