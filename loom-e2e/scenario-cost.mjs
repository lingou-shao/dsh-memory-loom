/**
 * 取回成本测算：expandBudgetTokens 三档对比
 *
 * 分开量两件事：
 *   1. 本地开销（切片 + SQL）—— 可以精确测
 *   2. 上下文成本（累积 token）与往返次数 —— 这是"慢"的真正来源
 *
 * 正文固定 5 万字，分别用中文叙事与英文日志两种文本形态，
 * 因为 estimateTokens 对两者的换算率差 1.6 倍，页数会明显不同。
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLoom } from './harness.mjs';
import { estimateTokens } from '../lib/index.js';

const BUDGETS = [2600, 4000, 8000, 12000];
const TARGET = 50000;

/* ---------------- 两种 5 万字正文 ---------------- */

const ZH_PARAS = [
  '她那天说的是不想再证明给谁看了，这句话我记了很久。',
  '辞职这件事她提过三次，前两次都是因为累，这次是因为看不到意义。',
  '房贷还剩十八年，孩子明年上小学，这些数字她算过很多遍。',
  '她说最怕的不是没钱，是走了以后发现自己什么都不会。',
  '我问她如果钱不是问题会怎么选，她想了很久没回答。',
  '后来她说想去做点手艺活，能看见成品的那种。',
  '这个念头她没跟任何人提过，包括她丈夫。',
  '我们聊到凌晨一点，她中间哭了一次，但很快收住了。',
  '她说哭完感觉轻了一点，至少知道自己要什么了。',
  '早上她发消息说昨晚想通了，决定先不动，用一年时间做准备。',
];
const LA_LOG = 'ERROR TS2307 cannot find module src/app/module.ts at build step; retry exhausted after 3 attempts; ';

const buildZH = () => {
  let out = '';
  for (let i = 0; out.length < TARGET; i++) out += `${ZH_PARAS[i % ZH_PARAS.length]}\n`;
  return out.slice(0, TARGET);
};
const buildLA = () => {
  let out = '';
  for (let i = 0; out.length < TARGET;) out += `${i++} ${LA_LOG}\n`;
  return out.slice(0, TARGET);
};

/** 走真实工具调用把一篇正文读完，记录每页开销。 */
async function readAll(body, budget, tag) {
  const DB = fileURLToPath(new URL(`./tmp-cost-${tag}.db`, import.meta.url));
  for (const s of ['', '-wal', '-shm']) rmSync(`${DB}${s}`, { force: true });

  const loom = createLoom({
    dbPath: DB,
    config: { consolidation: { triggerTokens: 1e9 }, index: { expandBudgetTokens: budget } },
  });
  await loom.turn('s1', body, '收到。');
  await loom.call('memory_index', { action: 'view' }, 's1');

  const pages = [];
  let offset = 0;
  const started = performance.now();
  for (let i = 0; i < 200; i++) {
    const page = await loom.call('memory_expand', { ref: 'T', offset }, 's1');
    pages.push({ chars: page.length, tokens: estimateTokens(page) });
    if (/已返回完|end of body/u.test(page)) break;
    const next = /offset=(\d+)/u.exec(page)?.[1];
    if (next === undefined) break;
    offset = Number(next);
  }
  const localMs = performance.now() - started;
  loom.dispose();
  for (const s of ['', '-wal', '-shm']) rmSync(`${DB}${s}`, { force: true });

  // 第 k 次调用时，上下文里已含前 k-1 页；输入 token 求和才是真实成本
  let cumulative = 0;
  pages.forEach((page, index) => { cumulative += page.tokens * (index + 1); });

  return {
    pages: pages.length,
    localMs,
    perPage: pages.map((p) => p.tokens),
    cumulative,
    firstPage: pages[0]?.tokens ?? 0,
    bodyTokens: estimateTokens(body),
  };
}

/* ---------------- 主流程 ---------------- */

const cases = [
  { name: '中文叙事', body: buildZH(), budgetBasis: '0.65 token/字' },
  { name: '英文日志', body: buildLA(), budgetBasis: '约 1 token/字' },
];

const results = [];
for (const item of cases) {
  console.log(`\n=== ${item.name} · ${item.body.length} 字 · ${estimateTokens(item.body)} token ===`);
  for (const budget of BUDGETS) {
    const tag = `${item.name === '中文叙事' ? 'zh' : 'la'}-${budget}`;
    const r = await readAll(item.body, budget, tag);
    results.push({ ...item, budget, ...r });
    console.log(`  预算 ${String(budget).padStart(5)} token → ${String(r.pages).padStart(2)} 页 | 首屏 ${String(r.firstPage).padStart(5)} token | 本地总耗时 ${r.localMs.toFixed(1)} ms | 累积输入 ${r.cumulative.toLocaleString()} token`);
  }
}

/* ---------------- 结论表 ---------------- */

console.log('\n\n================ 读完整篇的代价 ================');
console.log('（往返延迟按每次 2 秒估算：首 token 0.3-0.8s + 输出 50-150 token，这是估算不是实测）');
for (const item of cases) {
  console.log(`\n【${item.name}】正文 ${estimateTokens(item.body)} token`);
  console.log('  预算    页数   往返耗时   累积输入 token   相对 4000 档');
  const base = results.find((r) => r.name === item.name && r.budget === 4000);
  for (const r of results.filter((x) => x.name === item.name)) {
    const roundTrip = r.pages * 2;
    const ratio = r.cumulative / base.cumulative;
    console.log(`  ${String(r.budget).padStart(5)}  ${String(r.pages).padStart(4)}  ${String(roundTrip + 's').padStart(7)}  ${String(r.cumulative.toLocaleString()).padStart(14)}   ${(ratio * 100).toFixed(0).padStart(4)}%`);
  }
}

console.log('\n\n================ 只读开头（模型常有的情况）================');
console.log('  预算    第 1 页 token   读 2 页累计   读 3 页累计');
for (const item of cases) {
  console.log(`\n【${item.name}】`);
  for (const r of results.filter((x) => x.name === item.name)) {
    const firstTwo = r.perPage.slice(0, 2).reduce((sum, tokens, i) => sum + tokens * (i + 1), 0);
    const firstThree = r.perPage.slice(0, 3).reduce((sum, tokens, i) => sum + tokens * (i + 1), 0);
    console.log(`  ${String(r.budget).padStart(5)}  ${String(r.firstPage).padStart(13)}  ${String(firstTwo).padStart(12)}  ${String(firstThree).padStart(12)}   ${r.pages < 3 ? '(不足 3 页)' : ''}`);
  }
}
