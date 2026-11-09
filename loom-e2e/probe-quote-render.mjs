/**
 * 第一跳到底把什么交给了模型——同一个库、同一条 fact，三种 evidence 状态。
 *
 * 这个探针不测分数，只把 `memory_search` 的原始输出印出来，并对三件事断言：
 *
 *   A 无 quote（v0.2.29 之前的存量行、规则路径写入的行）
 *       → 只印摘要，行尾 `· 要点，非原话`
 *   B 有 quote 且 quoteVerified=true
 *       → `「原话」｜摘要`，**不再**带行尾标记
 *   C 有 quote 但 quoteVerified=false
 *       → 当它是普通摘要行：不印原话，带标记
 *
 * 第四件事是开关：`quoteInSearch: false` 时三种状态的输出都要和 0.2.33
 * 逐字一致（无引号、无标记）。这一条是回滚和 A/B 的前提，所以探针自己跑
 * 两遍——开着的库和关着的库——而不是靠调用者记得设环境变量。
 *
 * B 那一项曾经写错过：标记是无条件加的，于是同一行同时出现
 * `「…」｜摘要` 和 `· 要点，非原话`，读起来像"引号里那句也是摘要"。
 * 断言写在这里，就是为了让那个错误无法悄悄回来。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const QUOTE = '我同事老陈说按摩椅都是智商税，他家买了一个月就闲置了，我本来想给妈买一个';
const SUMMARY = '按摩椅被同事评价为智商税';
const MARK = '要点，非原话';

let failed = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failed += 1;
    console.log(`✗ ${label}${detail === void 0 ? '' : ` — ${detail}`}`);
  }
}

function factLine(text) {
  return String(text).split('\n').find((line) => /^\s*\d+\.\s*\[/u.test(line) && /\bfact\b/u.test(line)) ?? '';
}

/**
 * 在独立库里把三种 evidence 状态各跑一遍，返回每次的第一条 fact 行。
 *
 * @param {boolean} quoteInSearch - 开关状态，决定这是实验组还是对照组。
 */
async function render(quoteInSearch) {
  const dir = mkdtempSync(join(tmpdir(), 'quote-render-'));
  const dbPath = join(dir, 'loom.db');
  const loom = createLoom({ dbPath, config: { retrieval: { quoteInSearch } } });
  const S = `probe-quote-${quoteInSearch ? 'on' : 'off'}`;

  try {
    await loom.turn(S, QUOTE, '记下了，先不急着买。');
    await loom.call('memory_write', { text: SUMMARY, kind: 'fact' }, S);

    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT id FROM facts ORDER BY id DESC LIMIT 1').get();

    /*
     * 真实抽取会给 fact 写 source_ids（指向 l0 的那几轮），memory_expand 靠它
     * 调 rangeText 取原文。memory_write 手写的 fact 没有来源，所以这里按抽取器
     * 的做法把它补上——否则测的是一条根本走不到 rangeText 的路。
     */
    const turns = db.prepare('SELECT id FROM l0 WHERE session_id = ? ORDER BY id').all(S);
    const sourceIds = turns.length > 0 ? [turns[0].id, turns[turns.length - 1].id] : [];
    db.prepare('UPDATE facts SET source_ids = ? WHERE id = ?').run(JSON.stringify(sourceIds), row.id);

    const setEvidence = (evidence) => db.prepare('UPDATE facts SET evidence = ? WHERE id = ?').run(JSON.stringify(evidence), row.id);
    const search = () => loom.call('memory_search', { query: '按摩椅' }, S);

    setEvidence({});
    const lineA = factLine(await search());
    setEvidence({ quote: QUOTE, quoteVerified: true });
    const lineB = factLine(await search());
    setEvidence({ quote: QUOTE, quoteVerified: false });
    const lineC = factLine(await search());

    // 两跳：模型照着 (#F...) 去要原文，拿回来的是不是逐字对话。
    setEvidence({ quote: QUOTE, quoteVerified: true });
    const expanded = String(await loom.call('memory_expand', { ref: `#F${row.id}` }, S));

    db.close();
    return { id: row.id, lineA, lineB, lineC, expanded };
  } finally {
    loom.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const on = await render(true);
const off = await render(false);

console.log(`fact #${on.id} · quoteInSearch=true\n`);
console.log(`  A 无 quote      ${on.lineA}`);
console.log(`  B 校验通过      ${on.lineB}`);
console.log(`  C 校验没过      ${on.lineC}`);
console.log('\nquoteInSearch=false（对照组，应与 0.2.33 逐字一致）\n');
console.log(`  A 无 quote      ${off.lineA}`);
console.log(`  B 校验通过      ${off.lineB}`);
console.log(`  C 校验没过      ${off.lineC}`);
console.log(`\nmemory_expand 取回：\n${on.expanded.split('\n').map((l) => '  ' + l).join('\n')}\n`);

// A：存量行只有摘要，并且明确告诉模型这不是原话。
check('A 只印摘要', on.lineA.includes(SUMMARY) && !on.lineA.includes('「'), on.lineA);
check('A 带「要点，非原话」', on.lineA.includes(MARK), on.lineA);

// B：原话在前、摘要随后；标记必须消失——这一行本身就是原话。
check('B 印出逐字原话', on.lineB.includes(`「${QUOTE}」`), on.lineB);
check('B 原话在摘要之前', on.lineB.indexOf(`「${QUOTE}」`) < on.lineB.indexOf(SUMMARY), on.lineB);
check('B 不再带「要点，非原话」', !on.lineB.includes(MARK), on.lineB);

// C：校验没过的摘抄是健康报告的信号，不是给模型看的东西。
check('C 不印未校验的摘抄', !on.lineC.includes(QUOTE), on.lineC);
check('C 与 A 输出一致', on.lineC === on.lineA, `${on.lineC} vs ${on.lineA}`);

// 开关：三条都要回到 0.2.33 的样子。
check('关掉后 A 无标记', !off.lineA.includes(MARK) && off.lineA.includes(SUMMARY), off.lineA);
check('关掉后 B 无原话无标记', !off.lineB.includes('「') && !off.lineB.includes(MARK), off.lineB);
check('关掉后三态输出一致', off.lineA === off.lineB && off.lineB === off.lineC, `${off.lineA} | ${off.lineB} | ${off.lineC}`);

// 数字只出现一次：下游按 #F 计数，多印一次就翻倍。
check('B 行只有一个编号', (on.lineB.match(/#F\d+/gu) ?? []).length === 1, on.lineB);

// 两跳：原话真的取回来了，而且带说话人。
check('memory_expand 含逐字原句', on.expanded.includes(QUOTE), on.expanded.slice(0, 120));

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
