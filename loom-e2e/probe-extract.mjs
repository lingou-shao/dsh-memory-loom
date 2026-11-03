/**
 * probe-extract.mjs — 一段对话能抽出几条东西
 *
 * v0.2.26 之前，真实库是 13 个事件、9 条事实，10 个事件一条也没挂上。那不是
 * 检索问题：这段对话里的内容根本没进事实层，所以问起来只剩标题能命中。
 *
 * 这个探针守两半，因为那一版改的也是两半：
 *   1. 模型路径 —— 提示词的收录口径。口径写在字符串里，改了代码却没改口径
 *      时模型不会知道，而这种回归在任何行为断言里都看不见，只能比对提示词
 *      本身（和 probe-alias-prompt 同一个办法）。
 *   2. 规则路径 —— 没有模型时的兜底词表。这一半是完全确定的，可以正面测。
 *
 * 规则路径的难点不是「认出来」，是「别认错」：「我不吃香菜」是口味，「今天
 * 不吃早饭」是一顿饭。写错一次的代价是往后每次点菜都替用户否决一道菜，而
 * 他没法解释那不是他的口味。所以每个正例都配一个形状相同的反例。
 *
 * 全部在临时库里跑，不接触真实库。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, mockLlm } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-extract-'));
let pass = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) pass++;
  else failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};
const looms = [];

/** 提示词里那些句子是这一版加的，改回去就等于把口径改窄了。 */
const RUBRIC = [
  ['要求抽两类，不是只抽稳定特征', /抽两类，都要/u],
  ['说清了只抽①的代价', /上次那个迁移怎么样了/u],
  ['给了可照抄的正例', /WAL 锁冲突/u],
  ['给了要拒的反例', /用户在讨论代码/u],
  ['允许交白卷', /交白卷比编一条强/u],
  ['条数上限还在', /最多 8 条/u],
];

/**
 * 正例与反例。成对写，因为这一版真正难的地方是边界：
 * 「我不吃香菜」和「今天不吃早饭」在词表上看是同一件事。
 */
const CASES = [
  ['我不吃香菜，闻着就难受。', '香菜', true, '否定式偏好'],
  ['我对花生过敏，严重的那种。', '花生', true, '过敏也是长期限制'],
  ['我戒了酒，两年了。', '戒了酒', true, '戒掉的东西不能再端上来'],
  ['今天把迁移脚本改完了，卡了三天的 WAL 锁终于弄明白。', '迁移脚本', true, '省主语的完成句'],
  ['我遇到一个问题，同步任务老是报错。', '同步任务', true, '遇到的事也算经历'],
  ['今天不吃早饭，赶时间。', '早饭', false, '一次性的一顿，不是口味'],
  ['我中午不吃，晚上再说。', '中午不吃', false, '同上，只是主语还在'],
  ['嗯，好的。', '嗯', false, '寒暄'],
  ['帮我看看这段代码。', '代码', false, '让助手干活，不是关于他自己的事'],
];

try {
  // ---- 1. 提示词口径（走模型路径，只为了拿到那次请求）-------------------
  const promptLlm = mockLlm(JSON.stringify({
    title: '随便一段',
    summary: '用户说了一句话。',
    aliases: [],
    emotion: { valence: 0, arousal: 0.2, salience: 0.3 },
    impression: null,
    diary: null,
    facts: [{ text: '用户不吃香菜', kind: 'fact', ttl: null, confidence: 0.9, aliases: ['香菜'] }],
  }));
  const promptLoom = createLoom({
    dbPath: join(mkdtempSync(join(root, 'db-prompt-')), 'loom.db'),
    llm: promptLlm,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  looms.push(promptLoom);
  await promptLoom.turn('s-prompt', '我不吃香菜，闻着就难受。', '记下了。');
  await promptLoom.settle(8);
  const request = promptLlm.calls.find((call) => String(call.system ?? '').includes('记忆整理器'));
  const prompt = request === undefined ? '' : String(request.messages?.[0]?.content?.[0]?.text ?? '');
  console.log('[1] 抽取提示词的收录口径');
  check('模型路径确实被调用', request !== undefined, request === undefined ? '没有发出抽取请求' : '');
  for (const [label, pattern] of RUBRIC) check(label, pattern.test(prompt));
  check('旧的窄口径不再出现', !/只抽取稳定信息/u.test(prompt), '「只抽取稳定信息」已经换成分两类');

  // ---- 2. 规则路径的取舍（不传 llm，走兜底）----------------------------
  const dbPath = join(mkdtempSync(join(root, 'db-rules-')), 'loom.db');
  const rulesLoom = createLoom({
    dbPath,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  looms.push(rulesLoom);
  for (const [text] of CASES) {
    await rulesLoom.turn('s-rules', text, '嗯。');
    await rulesLoom.settle(8);
  }
  rulesLoom.dispose();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stored = db.prepare("SELECT text FROM facts WHERE status IN ('active','disputed')").all().map((row) => String(row.text));
  console.log(`\n[2] 规则路径抽了 ${stored.length} 条：`);
  for (const [text, word, want] of CASES) {
    const hit = stored.some((row) => row.includes(word));
    check(
      `${want ? '抽' : '不抽'}「${text}」`,
      hit === want,
      hit === want ? '' : `库里${hit ? '有' : '没有'}含「${word}」的事实`,
    );
  }

  // ---- 3. 医生把这个数报出来 -------------------------------------------
  console.log('\n[3] memory_doctor 报抽取产出');
  const doctorLoom = createLoom({
    dbPath: join(mkdtempSync(join(root, 'db-doc-')), 'loom.db'),
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  looms.push(doctorLoom);
  for (const turn of ['我不吃香菜，闻着就难受。', '嗯，好的。', '帮我看看这段代码。', '今天把迁移脚本改完了。']) {
    await doctorLoom.turn('s-doc', turn, '嗯。');
    await doctorLoom.settle(8);
  }
  const doctor = String(await doctorLoom.call('memory_doctor', {}, 's-doc'));
  const line = doctor.split('\n').find((row) => row.includes('个事件')) ?? '';
  check('报告事件数 / 事实数 / 挂上事实的事件数', /· 抽取\s+\d+ 个事件 · \d+ 条事实 · \d+ 个事件挂着事实/u.test(doctor), line.trim());
  /*
   * 挂了一半不是异常：这段里有两句本来就没什么可记的。只有当一条都没挂上时
   * 才该多说一句，否则真正的异常会沉在噪音里。
   */
  check('挂了一半不报警', !/一条都没挂上/u.test(doctor), line.trim());

  const barePath = join(mkdtempSync(join(root, 'db-bare-')), 'loom.db');
  const bareLoom = createLoom({
    dbPath: barePath,
    config: { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } },
  });
  looms.push(bareLoom);
  await bareLoom.turn('s-bare', '嗯，好的。', '那就这样。');
  await bareLoom.settle(8);
  const bareDoctor = String(await bareLoom.call('memory_doctor', {}, 's-bare'));
  check('一条都没挂上时才提示', /一条都没挂上/u.test(bareDoctor), (bareDoctor.split('\n').find((row) => row.includes('个事件')) ?? '').trim());

  // ---- 4. 交白卷也不编 --------------------------------------------------
  console.log('\n[4] 只有寒暄的一段');
  const quiet = new DatabaseSync(barePath, { readOnly: true });
  const quietFacts = Number(quiet.prepare("SELECT COUNT(*) AS n FROM facts WHERE status IN ('active','disputed')").get()['n']);
  const quietEvents = Number(quiet.prepare('SELECT COUNT(*) AS n FROM events').get()['n']);
  quiet.close();
  check('抽不出事实时不硬凑', quietFacts === 0, `${quietFacts} 条`);
  check('但事件仍然建了（那段对话还在）', quietEvents > 0, `${quietEvents} 个`);

  db.close();
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
