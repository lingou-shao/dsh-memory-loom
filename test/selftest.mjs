/**
 * Self-test for the hook-index layer inside dsh-memory-loom.
 *
 * Builds a throwaway database using the *upstream* schema, taken verbatim from
 * the bundle, fills it with a realistic episode, then exercises every code
 * path and prints the token accounting.
 *
 *   node test/selftest.mjs
 */

import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The bundle imports `@deepseek-ai/dsh-tools`; DSH resolves that from its own
// runtime, but a plain `node test/selftest.mjs` inside an installed package has
// no node_modules and would die with a bare ERR_MODULE_NOT_FOUND. Say what is
// actually wrong instead of dumping a stack trace at someone who just wanted to
// poke at the package.
let HookIndex, DEFAULTS, estimateTokens, parseRef, sliceByTokens;
try {
  ({ HookIndex, indexDefaults: DEFAULTS, estimateTokens, parseRef, sliceByTokens } = await import('../lib/index.js'));
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  console.error([
    '',
    '这个自测要在 clone 下来的仓库里跑，安装包里没有 node_modules：',
    '',
    '  git clone https://github.com/lingou-shao/dsh-memory-loom',
    '  cd dsh-memory-loom && npm install && npm test',
    '',
    `缺少的模块：${String(error.message).split('\n')[0]}`,
    ''
  ].join('\n'));
  process.exit(1);
}

// `URL.pathname` is percent-encoded and keeps a leading slash on Windows, so a
// repo path with a space or a Chinese folder name turns into `%20`/`%E4%..` and
// readFileSync fails. `fileURLToPath` is the only correct way to get a real path.
const BUNDLE = process.env.LOOM_BUNDLE ?? fileURLToPath(new URL('../lib/index.js', import.meta.url));

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---- 1. original schema, verbatim ---------------------------------------- */

const source = readFileSync(BUNDLE, 'utf8');
const match = /const SCHEMA = `([\s\S]*?)`;/.exec(source);
if (match === null) throw new Error('could not extract SCHEMA from the bundle');
const ORIGINAL_SCHEMA = match[1];

const file = join(tmpdir(), `loom-index-selftest-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });

const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL');
db.exec(ORIGINAL_SCHEMA);
check('原包 schema 已应用', true, `${ORIGINAL_SCHEMA.split('CREATE TABLE').length - 1} 张表`);

/* ---- 2. fixtures --------------------------------------------------------- */

const now = Date.UTC(2026, 9, 29, 5, 0, 0);

db.prepare('INSERT INTO identities (id, name, role, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
  .run('master', '主人', 'master', now, now);
db.prepare('INSERT INTO sessions (session_id, identity_id, timezone, started_at, last_active_at) VALUES (?, ?, ?, ?, ?)')
  .run('s1', 'master', 'Asia/Shanghai', now, now);

// A 40-turn episode about whether to quit a job — the kind of thing that has a
// long body behind a short hook.
const timeline = [];
for (let turn = 1; turn <= 20; turn++) {
  timeline.push(['user', `第${turn}句：我最近一直在想辞职的事，今天又加班到十点，回家路上我在想要不要干脆算了。她问我在怕什么，我说怕的不是没钱，是怕自己没本事。`]);
  timeline.push(['assistant', `第${turn}句回应：你怕的其实是「证明不了自己」这件事，不是收入。这一点比辞职本身更值得先看清楚。如果留下来的理由是怕输，那走也不会让你安心。`]);
}
const insertL0 = db.prepare(
  'INSERT INTO l0 (session_id, identity_id, turn, role, text, tokens, created_at, timezone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const l0Ids = [];
timeline.forEach(([role, text], i) => {
  const id = insertL0.run('s1', 'master', Math.floor(i / 2) + 1, role, text, '', now - (timeline.length - i) * 60000, 'Asia/Shanghai').lastInsertRowid;
  l0Ids.push(Number(id));
});
const l0From = l0Ids[0];
const l0To = l0Ids[l0Ids.length - 1];

const bodyChars = db.prepare('SELECT SUM(LENGTH(text)) AS n FROM l0 WHERE id BETWEEN ? AND ?').get(l0From, l0To).n;
check('原始对话已写入 L0', bodyChars > 2000, `${bodyChars} 字 / ${l0Ids.length} 轮`);

db.prepare(`INSERT INTO events (identity_id, session_id, title, summary, tokens, domain, started_at, ended_at, turn_from, turn_to, salience, l0_from, l0_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('master', 's1', '要不要辞职的长谈', '用户反复纠结是否辞职，真正怕的是证明不了自己，而不是收入。', '', 'relationship', now - 3600000, now - 600000, 1, 20, 0.82, l0From, l0To, now - 600000);

// A second, boring episode that should lose the residency race.
const boringFrom = insertL0.run('s1', 'master', 21, 'user', '明天天气怎么样？', '', now - 300000, 'Asia/Shanghai').lastInsertRowid;
const boringTo = insertL0.run('s1', 'master', 21, 'assistant', '明天多云，12 到 20 度。', '', now - 290000, 'Asia/Shanghai').lastInsertRowid;
db.prepare(`INSERT INTO events (identity_id, session_id, title, summary, tokens, domain, started_at, ended_at, turn_from, turn_to, salience, l0_from, l0_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  .run('master', 's1', '问天气', '问了明天的天气。', '', 'other', now - 300000, now - 290000, 21, 21, 0.05, Number(boringFrom), Number(boringTo), now - 290000);

const insertFact = db.prepare(`INSERT INTO facts (identity_id, text, tokens, tags, kind, source, domain, salience, base, stability, stability_max,
  created_at, updated_at, last_access_at, confidence, pinned, source_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
insertFact.run('master', '用户正在考虑辞职，真正怕的是证明不了自己', '', '', 'fact', 'consolidate', 'relationship', 0.8, 0.9, 30, 1500, now, now, now, 0.8, 1, JSON.stringify([l0From, l0To]));
insertFact.run('master', '用户加班频繁，常到晚上十点', '', '', 'fact', 'consolidate', 'work', 0.5, 0.7, 30, 1500, now, now, now, 0.8, 0, '[]');
insertFact.run('master', '她最怕被敷衍', '', '', 'fact', 'manual', 'relationship', 0.9, 0.95, 30, 1500, now, now, now, 0.9, 1, '[]');
check('事实已写入', true, '3 条（2 条置顶）');

/* ---- 3. index behaviour -------------------------------------------------- */

const config = { ...DEFAULTS, path: file };
const index = new HookIndex(db, config, () => now);

console.log('\n[1] 重建索引');
const report = index.rebuild('master');
check('驻留数不超过 maxHooks', report.resident <= config.maxHooks, `${report.resident} / ${config.maxHooks}`);
check('驻留区在预算内', report.tokens <= config.hooksBudgetTokens, `${report.tokens} / ${config.hooksBudgetTokens} token`);

const block = index.render('master');
console.log('\n--- 索引块 ---');
console.log(block);
console.log('---\n');

check('高显著度事件进索引', block.includes('E1'), 'E1 = 要不要辞职的长谈');
check('低显著度事件被挡在外面', !block.includes('E2'), 'E2 = 问天气，salience 0.05');
check('置顶事实带星标', block.includes('F3 ★'), 'F3 = 她最怕被敷衍');

const hookTokens = estimateTokens(block);
console.log(`索引块实占：${hookTokens} token\n`);

console.log('[2] 取回正文');
const expanded = index.body('master', 'E1');
check('E1 能解析到 L0 区间', expanded.ok && expanded.kind === 'event', `正文 ${expanded.chars} 字`);
const sliced = sliceByTokens(expanded.text, 0, config.expandBudgetTokens);
check('首屏受 expandBudgetTokens 约束', estimateTokens(sliced.piece) <= config.expandBudgetTokens, `${estimateTokens(sliced.piece)} token`);
check('2800 字正文一屏装得下', sliced.done === true, `${expanded.chars} 字 → ${estimateTokens(expanded.text)} token`);

const tight = sliceByTokens(expanded.text, 0, 400);
check('预算收紧时会分页', tight.done === false && estimateTokens(tight.piece) <= 400, `首屏 ${tight.piece.length} 字 / ${estimateTokens(tight.piece)} token`);

let pages = 1;
let cursor = tight.end;
while (cursor < expanded.text.length && pages < 40) {
  const next = sliceByTokens(expanded.text, cursor, 400);
  if (next.piece.length === 0) break;
  cursor = next.end;
  pages++;
}
check('分页可以读完全文', cursor >= expanded.text.length, `${pages} 页读完整篇`);

const factBody = index.body('master', 'F1');
check('F1 顺 source_ids 取回同一段正文', factBody.ok && factBody.chars === expanded.chars, `${factBody.chars} 字`);

const manualFact = index.body('master', 'F3');
check('无 source_ids 的手写事实回退到自身文本', manualFact.text.includes('她最怕被敷衍'));

console.log('[3] 正文缺失时的行为');
db.prepare('DELETE FROM l0 WHERE id BETWEEN ? AND ?').run(Number(boringFrom), Number(boringTo));
const gone = index.body('master', 'E2');
check('原文被清理时给明确提示而非空串', !gone.ok && gone.reason.includes('已被清理'), gone.reason.slice(0, 40));

console.log('[4] 打包整理版并挂到钩子');
const packed = index.pack({
  identityId: 'master',
  ref: 'E1',
  title: '辞职纠结的来龙去脉',
  text: '那天她加班到十点，回家路上第一次说出口。怕的不是没钱，是怕自己没本事。我指出这一点之后她沉默了很久。后来决定先不辞，用三个月证明一次。',
});
check('正文已入库', packed.chars > 0, `${packed.chars} 字 / ${packed.tokens} token`);
const repacked = index.body('master', 'E1');
check('E1 现在优先返回整理版', repacked.kind === 'doc' && repacked.text.includes('三个月证明一次'), repacked.kind);

console.log('[5] 稳定性（防人格漂移）');
const before = index.render('master');
for (let i = 0; i < 5; i++) index.render('master');
check('多次渲染结果完全一致', index.render('master') === before, '未随轮次重排');

console.log('[6] 冷区淘汰');
db.prepare('UPDATE loom_hooks SET resident = 1 WHERE ref IN (?, ?)').run('E1', 'E2');
config.maxHooks = 2;
const capped = new HookIndex(db, config, () => now);
const cappedReport = capped.rebuild('master');
const cold = db.prepare('SELECT ref, cold_until FROM loom_hooks WHERE identity_id = ? AND resident = 0 AND cold_until IS NOT NULL').all('master');
check('被挤出驻留区的钩子进入冷区', cappedReport.resident <= 2 && cold.length > 0, `${cold.map((r) => r.ref).join(', ')} 冷至 ${Math.round((cold[0].cold_until - now) / 86400000)} 天后`);

/* ---- 4. token accounting ------------------------------------------------- */

/* ---- 遗忘级联 ------------------------------------------------------------ */

console.log('[7] 遗忘级联（用户说忘掉时正文不能留下）');
db.prepare('DELETE FROM events WHERE id = 1').run();
const afterForget = index.body('master', 'E1');
check('钩子被删后拒绝返回整理版正文', !afterForget.ok && afterForget.reason.includes('已被删除'), afterForget.reason.slice(0, 46));
const orphans = index.orphanDocs('master');
check('能识别孤儿正文', orphans.length === 1, orphans.map((row) => `${row.ref}/${row.title}`).join(', '));
const removed = index.gc('master');
check('gc 清掉孤儿正文', removed.length === 1 && index.body('master', 'E1').ok === false, '正文与链接同时删除');

console.log('[8] 成本核算（100 轮对话）');
// What the current plugin would put in the prompt on an average turn.
const currentBlock = [
  '【长期记忆】',
  '【关于你（事实）】',
  ...Array.from({ length: 12 }, (_, i) => `- [10-2${i % 9} · 事实] 用户的一条具体事实，包含人物时间与结果，长度和真实抽取结果相当 #${i}`),
  '【我们一起经历过】',
  ...Array.from({ length: 3 }, (_, i) => `- [10-2${i}] 一次共同经历：标题：摘要，描述那段时间发生了什么以及结果`),
  '【我对你的印象】',
  '- 一个偏内向、在意被认真对待的人，说话时会先试探。',
  '【我的日记】',
  '- [10-28] 今天聊得比平时久，她好像终于愿意说真话。',
].join('\n');
const currentTokens = estimateTokens(currentBlock);
const pullCost = Math.round(bodyChars * 0.65);
const scenarios = [
  ['记忆稀薄（12 条事实），6% 轮次取回', currentTokens, 6],
  ['记忆成熟（填满 2000 预算），6% 轮次取回', 2000, 6],
  ['记忆成熟，取回率升到 15%', 2000, 15],
];
for (const [label, perTurn, pulls] of scenarios) {
  const before = perTurn * 100;
  const after = hookTokens * 100 + pulls * pullCost;
  console.log(`  ${label.padEnd(34, ' ')} 现状 ${String(before).padStart(6)} → 索引 ${String(after).padStart(6)}  token   省 ${String(Math.round((1 - after / before) * 100)).padStart(2)}%`);
}
console.log(`  （索引块 ${hookTokens} token/轮；单次取回 ${bodyChars} 字 ≈ ${pullCost} token）`);

/* ---- 5. unit checks ------------------------------------------------------ */

console.log('\n[9] 单元检查');
check('parseRef 大写', parseRef('E37')?.kind === 'event' && parseRef('E37').id === 37);
check('parseRef 容错', parseRef('  f12 ')?.kind === 'fact' && parseRef('#D3')?.kind === 'doc');
check('parseRef 拒绝垃圾输入', parseRef('hello') === null && parseRef('') === null);
check('estimateTokens 中文', estimateTokens('你好世界') === 3, '4 字 ≈ 2.6 → 3');
check('estimateTokens 拉丁', estimateTokens('hello world') === 3, '11 字符 ≈ 2.75 → 3');
check('sliceByTokens 越界不出错', sliceByTokens('abc', 999, 100).piece === '');
const diaryColumns = db.prepare('PRAGMA table_info(diary)').all().map((row) => row.name);
check(
  'diary 表不再有空转的列',
  !diaryColumns.includes('weight') && !diaryColumns.includes('mood'),
  diaryColumns.join(', '),
);

db.close();
for (const suffix of ['', '-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
