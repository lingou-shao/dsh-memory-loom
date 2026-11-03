/**
 * Probe: 别人留下的记忆能不能搬进来，且搬得像个样子。
 *
 * 这一项要回答的是「换插件要不要从头开始」。至少四个记忆插件共用
 * `memory_search/write/forget`，撞名之后用户要么卸掉对方、要么给我们改名共存，
 * 两条路都在盘上留下同一堆文件。如果这些文件读不进来，那「记忆」这件事就没有连续性
 * 可言 —— 换一次插件丢一次过去，比没有记忆更糟。
 *
 * 盯八件事，每一件都能单独坏掉：
 *   1. 装好就扫，扫到别人的文件、不把自己的库算进去
 *   2. 提示词里问一句，但只问有限几次（每轮都问的插件会被卸载）
 *   3. 不带参数只是清单，预览只是预览，都不写库
 *   4. confirm 之后真的落库：类型、领域、原始日期、来源标记都对
 *   5. 重复的不重复导（同一个文件导两次，第二次什么都没进来）
 *   6. 用户说不要就不再提，且源文件一个字节都没动
 *   7. 拖进来的单文件也能导（JSON / Markdown），不依赖路径规律
 *   8. 补别名要调模型、要花预算，且补完真的能被另一种说法搜到
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, mockLlm } from './harness.mjs';

const DAY = 86400000;
const SESSION = 'probe-intake';
const root = mkdtempSync(join(tmpdir(), 'loom-intake-'));
let pass = 0;
let fail = 0;
function check(label, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  ok   ${label}${detail === '' ? '' : ` — ${detail}`}`);
  } else {
    fail++;
    console.log(`  FAIL ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}

/** 一份 dsh-memory 形状的库：`memories(id, text, tags, pinned, created_at, updated_at)`。 */
function writeDshMemoryDb(path, rows) {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '',
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE memories_fts USING fts5(text, tags, content='memories', content_rowid='id');
    `);
    const insert = db.prepare('INSERT INTO memories (text, tags, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(row.text, row.tags ?? '', row.pinned === true ? 1 : 0, row.at, row.at);
  } finally {
    db.close();
  }
}

/** 医生报告里的某一行。 */
function lineOf(report, label) {
  return String(report).split('\n').find((line) => line.includes(label)) ?? '';
}

/** 医生「数据」行里的事实数。 */
function factsOf(report) {
  const match = /事实 (\d+)/u.exec(lineOf(report, '数据'));
  return match === null ? -1 : Number(match[1]);
}

/** 清单里某一行的编号（`1. dsh-memory（memory.db） · …`）。 */
function indexOf(list, needle) {
  for (const line of String(list).split('\n')) {
    const match = /^(\d+)\.\s/u.exec(line);
    if (match !== null && line.includes(needle)) return Number(match[1]);
  }
  return 0;
}

/**
 * mock `llm` 收到的是真实的 stream 请求（provider/model/messages），不是插件内部
 * 那个 `{ system, prompt }`。从 messages 里取提示词，否则拿到的永远是 undefined，
 * 假模型会给出一份空清单 —— 而空清单会让「补了 0 条」看起来像代码没跑。
 */
function promptOf(request) {
  const part = request?.messages?.[0]?.content?.[0]?.text;
  return String(part ?? '');
}

try {
  // ── 现场：一个 home，里面有自己的库、别人的库、别人的 JSON ──────────────
  const home = join(root, 'home');
  const dbPath = join(home, 'memory', 'loom.db');
  const foreignDb = join(home, 'memory', 'memory.db');
  const foreignJson = join(home, 'storages', 'memory.json');
  const old = Date.now() - 200 * DAY;
  writeDshMemoryDb(foreignDb, [
    { text: '用户不吃香菜，点外卖时不要放', tags: 'diet', at: Date.now() - 3 * DAY },
    { text: '以后都用 pnpm，不要用 npm', tags: 'tools', at: Date.now() - 4 * DAY },
    { text: '用户把同步任务的报错定位到数据库的 WAL 锁冲突，最后改成单写者队列', tags: 'sync', at: old },
    { text: '用户打算下周三去体检', tags: 'health', at: Date.now() - 2 * DAY },
    { text: '用户把同步任务的报错定位到数据库的 WAL 锁冲突，最后改成单写者队列', tags: 'sync', at: Date.now() - 2 * DAY },
    { text: 'sk-abcdef1234567890ABCDEF', tags: '', at: Date.now() - 2 * DAY },
    { text: '明天', tags: '', at: Date.now() - 2 * DAY }
  ]);
  mkdirSync(join(home, 'storages'), { recursive: true });
  writeFileSync(foreignJson, JSON.stringify({
    blocks: [
      { content: '用户偏好用 Obsidian 记日记，每周日整理一次', keywords: ['obsidian', '日记'], createdAt: Date.now() - 5 * DAY, kind: 'fact' },
      { content: '用户说以后提交前先跑一遍 lint', keywords: ['lint'], createdAt: Date.now() - 6 * DAY, kind: 'prompt' }
    ]
  }), 'utf8');
  const foreignBytes = statSync(foreignDb).size;

  // ── 1. 装好就扫 ──────────────────────────────────────────────────────
  console.log('\n[1] 装好之后先检查一遍');
  const loom = createLoom({ dbPath });
  const tools = loom.toolNames();
  check('多了第 16 个工具 memory_import', tools.length === 16 && tools.includes('memory_import'), `${tools.length} 个`);
  const list = String(await loom.call('memory_import', {}, SESSION));
  check('扫到别人的库', list.includes('memory.db') && list.includes('dsh-memory'), list.split('\n')[1] ?? '');
  check('扫到别人的 JSON 存储', list.includes('memory.json'), '');
  check('没把自己的 loom.db 当成待导入', !list.includes('loom.db'), '');
  check('清单里说了下一步怎么调', list.includes('memory_import(source=1)'), '');

  // ── 2. 提示词里问一次，但只问有限次 ─────────────────────────────────
  console.log('\n[2] 提示词里问，且不会一直问');
  const notice = loom.memoryBlock(SESSION);
  check('记忆块里出现了可导入提示', notice.includes('可导入的记忆'), notice.slice(-160));
  check('提示里点名了是哪份', notice.includes('dsh-memory'), '');
  check('提示里给了「不要」的调法', notice.includes('dismiss=true'), '');
  check('两份文件时不让模型猜编号', notice.includes('清单里的编号'), '');
  for (let i = 0; i < 3; i++) {
    await loom.turn(SESSION, `第 ${i} 句闲聊，没什么内容`, '嗯。');
    // 真机上每轮都会渲染一次记忆块，这里也每轮渲染：提示的次数是按「渲染」
    // 而不是「过了一天」算的，不渲染就永远停在自己设的上限之前。
    loom.memoryBlock(SESSION);
  }
  check('问了几轮之后自己闭嘴', !loom.memoryBlock(SESSION).includes('可导入的记忆'), '');

  // ── 3. 预览不写库 ───────────────────────────────────────────────────
  console.log('\n[3] 预览只读');
  const dbIndex = indexOf(await loom.call('memory_import', {}, SESSION), 'memory.db');
  check('清单编号可以定位到那份库', dbIndex >= 1, `source=${dbIndex}`);
  const before = factsOf(await loom.call('memory_doctor', {}, SESSION));
  const preview = String(await loom.call('memory_import', { source: dbIndex }, SESSION));
  const after = factsOf(await loom.call('memory_doctor', {}, SESSION));
  check('预览说了会导入几条', preview.includes('会导入 4 条'), preview.split('\n')[3] ?? '');
  check('预览说了重复的会被跳过', preview.includes('重复 1 条'), '');
  check('预览说了密钥不搬', preview.includes('疑似密钥 1 条'), '');
  check('预览说了旧计划按事实存放', preview.includes('旧计划 1 条'), '');
  check('预览给出补别名的调用次数', /补别名要调模型 \d+ 次/.test(preview), '');
  check('预览前后库里的事实数没变', before === after, `${before} → ${after}`);

  // ── 4. 确认之后真的落库 ─────────────────────────────────────────────
  console.log('\n[4] confirm 之后落库');
  const done = String(await loom.call('memory_import', { source: dbIndex, confirm: true }, SESSION));
  check('回话说已导入', done.includes('已导入') && done.includes('→ 4 条'), done.split('\n')[0] ?? '');
  check('回话说源文件没动', done.includes('源文件没动'), '');
  const grown = factsOf(await loom.call('memory_doctor', {}, SESSION));
  check('事实表多了 3 条（那条要求进常驻区，不算事实）', grown === before + 3, `${before} → ${grown}`);

  // ── 5. 同一个文件导两次 ─────────────────────────────────────────────
  console.log('\n[5] 重复导入是空操作');
  const again = String(await loom.call('memory_import', { path: foreignDb, confirm: true }, SESSION));
  check('第二次说没有新东西', again.includes('没有新东西可导'), again.split('\n')[0] ?? '');
  const data2 = factsOf(await loom.call('memory_doctor', {}, SESSION));
  check('事实数没变', data2 === grown, `${grown} → ${data2}`);

  // ── 6. 用户说不要 ───────────────────────────────────────────────────
  console.log('\n[6] 说不要就不导入');
  const jsonIndex = indexOf(await loom.call('memory_import', {}, SESSION), 'memory.json');
  check('待办里只剩 JSON 那一份', jsonIndex === 1, `source=${jsonIndex}`);
  const dismissed = String(await loom.call('memory_import', { source: jsonIndex, dismiss: true }, SESSION));
  check('回话记下了', dismissed.includes('不再提'), dismissed.split('\n')[0] ?? '');
  const relist = String(await loom.call('memory_import', {}, SESSION));
  check('之后的清单里没有它了', !relist.includes('memory.json'), relist.slice(0, 120));
  check('文件还在，一个字节没动', existsSync(foreignDb) && statSync(foreignDb).size === foreignBytes, '');
  check('医生里也不再报它', !lineOf(await loom.call('memory_doctor', {}, SESSION), '可导入').includes('memory.json'), '');

  // ── 7. 拖进来的单文件 ───────────────────────────────────────────────
  console.log('\n[7] 用户把文件拖进来');
  const dragged = join(root, '我的记忆导出.md');
  writeFileSync(dragged, ['# 宠物', '- 用户养了一只叫年糕的猫，是 2023 年冬天捡的', '- 年糕怕生，来客人的时候会躲到床底下'].join('\n'), 'utf8');
  const dragPreview = String(await loom.call('memory_import', { path: dragged }, SESSION));
  check('认出了 Markdown', dragPreview.includes('纯文本'), dragPreview.split('\n')[0] ?? '');
  check('预览了两条', dragPreview.includes('会导入 2 条'), '');
  const dragDone = String(await loom.call('memory_import', { path: dragged, confirm: true }, SESSION));
  check('导入成功', dragDone.includes('→ 2 条'), dragDone.split('\n')[0] ?? '');
  const cat = String(await loom.call('memory_search', { query: '年糕' }, SESSION));
  check('导进来之后搜得到', cat.includes('年糕'), cat.split('\n')[0] ?? '');
  // 没有 schema 的导出按钮经常只写一个字符串数组，这不是配置，是记忆
  const plainJson = join(root, '记忆导出.json');
  writeFileSync(plainJson, JSON.stringify(['用户的高铁会员积分明年三月过期', '用户喜欢把会议纪要放进 Notion 的周会库里']), 'utf8');
  const plainPreview = String(await loom.call('memory_import', { path: plainJson }, SESSION));
  check('纯字符串数组也认得出是记忆', plainPreview.includes('会导入 2 条'), plainPreview.split('\n')[3] ?? '');
  const plainDone = String(await loom.call('memory_import', { path: plainJson, confirm: true }, SESSION));
  check('字符串数组也能落库', plainDone.includes('→ 2 条'), plainDone.split('\n')[0] ?? '');
  // 规则被收回之后（`active = 0`）就不该再被搬进来。少了这条判据，从另一个
  // 安装里导入、或者把自己 `memory_export` 的产物拖回来，都会把用户明确说过
  // 「以后别管那条」的要求复活成常驻规则——而这正是收回这条路存在的理由。
  // 两条路都要堵：源文件自己标了 `active: 0` 的（A），和源文件没标、但本地
  // 已经收回过的（B，靠去重集合认）。
  const retiredRule = '用户要求每周五下班前把周报发到组里';
  await loom.call('memory_write', { text: retiredRule, kind: 'instruction' }, SESSION);
  // 编号按搜索结果取，不写死：前面几组已经往偏好表里塞过东西了。
  const foundRule = String(await loom.call('memory_search', { query: '周报' }, SESSION));
  const ruleRef = /\(#(P\d+)\)/u.exec(foundRule)?.[1];
  check('新规矩能被搜到并拿到编号', ruleRef !== undefined, foundRule.split('\n')[0] ?? '');
  const retireDone = String(await loom.call('memory_forget', { ref: ruleRef }, SESSION));
  check('先把那条规矩收回', retireDone.includes('已移出') && retireDone.includes('周报'), retireDone);

  const noFlag = join(root, '旧导出.json');
  writeFileSync(noFlag, JSON.stringify([{ text: retiredRule }, { text: '用户的健身卡 2027 年 4 月到期，到期前一个月要记得续' }]), 'utf8');
  const noFlagPreview = String(await loom.call('memory_import', { path: noFlag }, SESSION));
  check('没标状态的文件也搬不回已收回的规矩（去重认得出）', noFlagPreview.includes('会导入 1 条') && noFlagPreview.includes('重复 1 条'), noFlagPreview.split('\n')[3] ?? '');
  const noFlagDone = String(await loom.call('memory_import', { path: noFlag, confirm: true }, SESSION));
  check('只落了新那条', noFlagDone.includes('→ 1 条'), noFlagDone.split('\n')[0] ?? '');

  const retiredJson = join(root, '规矩导出.json');
  writeFileSync(retiredJson, JSON.stringify([
    { text: '用户以前要求每天早晚各汇报一次进度，这条已经作废', active: 0 },
    { text: '用户把家里那台旧打印机送给了楼下的邻居，型号是 LaserJet 1020' }
  ]), 'utf8');
  const retiredPreview = String(await loom.call('memory_import', { path: retiredJson }, SESSION));
  check('收回的规矩不搬（预览只认一条）', retiredPreview.includes('会导入 1 条'), retiredPreview.split('\n')[3] ?? '');
  check('预览说清了为什么少一条', retiredPreview.includes('已收回的 1 条'), retiredPreview.split('\n').find((line) => line.includes('跳过')) ?? '');
  const retiredDone = String(await loom.call('memory_import', { path: retiredJson, confirm: true }, SESSION));
  check('落库也只落那一条', retiredDone.includes('→ 1 条'), retiredDone.split('\n')[0] ?? '');
  const revivedRule = String(await loom.call('memory_search', { query: '汇报进度' }, SESSION));
  check('作废的规矩没有复活', !revivedRule.includes('汇报'), revivedRule);
  const stillRule = String(await loom.call('memory_search', { query: '周报' }, SESSION));
  check('收回的那条也没有借去重复活', !stillRule.includes('周报'), stillRule);
  loom.dispose();

  // ── 8. 落库的细节（要关掉库才好在 Windows 上直连） ──────────────────
  console.log('\n[8] 落库的细节');
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare('SELECT text, kind, domain, source, created_at, aliases FROM facts ORDER BY id').all();
    const byText = (needle) => rows.find((row) => row.text.includes(needle));
    const pref = byText('香菜');
    check('饮食偏好记成 preference 而不是 instruction', pref?.kind === 'preference', String(pref?.kind));
    check('来源标成 import:dsh-memory', pref?.source === 'import:dsh-memory', String(pref?.source));
    const sync = byText('WAL 锁冲突');
    check('技术事实归到 tech 领域', sync?.domain === 'tech', String(sync?.domain));
    check('保留了原始日期（200 天前，不是今天）', Math.abs(Number(sync?.created_at) - old) < DAY, new Date(Number(sync?.created_at)).toISOString().slice(0, 10));
    const plan = byText('体检');
    check('旧计划按事实存放', plan?.kind === 'fact', String(plan?.kind));
    const evidence = db.prepare("SELECT evidence FROM facts WHERE text LIKE '%体检%'").get();
    check('原文里留了「它本来是计划」的痕迹', String(evidence?.evidence).includes('"wasPlan":true'), String(evidence?.evidence).slice(0, 80));
    const secret = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE text LIKE '%sk-%'").get();
    check('密钥没有进库', Number(secret.n) === 0, '');
    const instr = db.prepare("SELECT text FROM preferences WHERE text LIKE '%pnpm%'").get();
    check('要求进了常驻偏好表', instr !== undefined, String(instr?.text ?? '(无)'));
    const audit = db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'intake.import'").get();
    check('审计里有导入记录', Number(audit.n) >= 2, `${audit.n} 条`);
  } finally {
    db.close();
  }

  // ── 9. 补别名：要调模型、吃预算、补完能换说法搜到 ────────────────────
  console.log('\n[9] 补别名');
  const aliasRoot = join(root, 'alias');
  const aliasDb = join(aliasRoot, 'memory', 'loom.db');
  writeDshMemoryDb(join(aliasRoot, 'memory', 'memory.db'), Array.from({ length: 8 }, (_, index) => ({
    text: `用户第 ${index + 1} 次提到家里那台旧打印机会卡纸，最后都是自己拆开清理`,
    tags: 'printer',
    at: Date.now() - (index + 10) * DAY
  })));
  const llm = mockLlm((request) => {
    const count = (promptOf(request).match(/^\d+\. /gmu) ?? []).length;
    return JSON.stringify({ items: Array.from({ length: count }, (_, index) => ({ i: index, a: ['打印机', '卡纸'] })) });
  });
  const second = createLoom({ dbPath: aliasDb, llm, config: { consolidation: { enabled: true, provider: 'probe', model: 'probe-1' } } });
  String(await second.call('memory_import', { source: 1, confirm: true }, SESSION));
  const aliasDoctor = String(await second.call('memory_doctor', {}, SESSION));
  check('导入的事实一开始没有别名', lineOf(aliasDoctor, '检索别名').includes('0/8'), lineOf(aliasDoctor, '检索别名'));
  check('医生指出了补的办法', lineOf(aliasDoctor, '检索别名').includes('aliases=true'), lineOf(aliasDoctor, '检索别名'));
  const aliasReport = String(await second.call('memory_import', { aliases: true }, SESSION));
  check('补别名的回话给了条数和调用次数', /补了 8 条 · 模型调用 1 次/.test(aliasReport), aliasReport.split('\n')[0] ?? '');
  const afterAlias = String(await second.call('memory_doctor', {}, SESSION));
  check('医生里别名覆盖变满', lineOf(afterAlias, '检索别名').includes('8/8'), lineOf(afterAlias, '检索别名'));
  const paraphrase = String(await second.call('memory_search', { query: '卡纸' }, SESSION));
  check('换一种说法也搜得到', paraphrase.includes('打印机'), paraphrase.split('\n')[0] ?? '');
  second.dispose();

  // ── 10. 预算用完之后停下，不偷偷超支 ────────────────────────────────
  console.log('\n[10] 预算用完了就停');
  const budgetRoot = join(root, 'budget');
  const budgetDb = join(budgetRoot, 'memory', 'loom.db');
  writeDshMemoryDb(join(budgetRoot, 'memory', 'memory.db'), Array.from({ length: 30 }, (_, index) => ({
    text: `用户第 ${index + 1} 次说要给厨房换一个更大的水槽，尺寸还没量`,
    tags: 'home',
    at: Date.now() - (index + 3) * DAY
  })));
  const llm2 = mockLlm((request) => {
    const count = (promptOf(request).match(/^\d+\. /gmu) ?? []).length;
    return JSON.stringify({ items: Array.from({ length: count }, (_, index) => ({ i: index, a: ['水槽', '厨房'] })) });
  });
  const third = createLoom({
    dbPath: budgetDb,
    llm: llm2,
    config: { consolidation: { enabled: true, provider: 'probe', model: 'probe-1', dailyLlmCalls: 2 } }
  });
  String(await third.call('memory_import', { source: 1, confirm: true }, SESSION));
  const capped = String(await third.call('memory_import', { aliases: true, limit: 30 }, SESSION));
  check('停在预算上，没有超支', capped.includes('预算用完了'), capped.split('\n')[0] ?? '');
  check('说明了还剩多少没补', /还剩 6 条/.test(capped), capped.split('\n').find((line) => line.includes('还剩')) ?? '');
  check('只调了两次模型', /模型调用 2 次/.test(capped), '');
  third.dispose();

  // ── 11. 拖进来的是本插件自己的旧库：只搬记忆，不搬对话 ────────────────
  console.log('\n[11] 指向自己的旧库');
  const oldRoot = join(root, 'oldstore');
  const oldDbPath = join(oldRoot, 'memory', 'loom.db');
  writeDshMemoryDb(join(oldRoot, 'memory', 'memory.db'), [
    { text: '用户不吃香菜，点外卖时不要放', tags: 'diet', at: Date.now() - 3 * DAY },
    { text: '以后都用 pnpm，不要用 npm', tags: 'tools', at: Date.now() - 4 * DAY }
  ]);
  const oldStore = createLoom({ dbPath: oldDbPath });
  await oldStore.turn('old', '我住在杭州，养了一只叫豆豆的猫', '记住了，豆豆。');
  String(await oldStore.call('memory_import', { source: 1, confirm: true }, SESSION));
  oldStore.dispose();
  // 用户把自己以前那份库拖进来 / 换了台机器找回旧文件
  const oldCopy = join(oldRoot, 'memory', 'loom-2026-10-01.db');
  copyFileSync(oldDbPath, oldCopy);
  const revived = createLoom({ dbPath: oldDbPath });
  const oldList = String(await revived.call('memory_import', {}, SESSION));
  check('认得出这是自己的旧库', oldList.includes('memory-loom'), oldList.split('\n')[1] ?? '');
  const oldPreview = String(await revived.call('memory_import', { path: oldCopy }, SESSION));
  check('只读出 1 条事实 + 1 条要求', oldPreview.includes('读出来 2 条'), oldPreview.split('\n')[3] ?? '');
  const oldDone = String(await revived.call('memory_import', { path: oldCopy, confirm: true }, SESSION));
  check('老库里的东西本来就在库里，一条不重复', oldDone.includes('没有新东西可导'), oldDone.split('\n')[0] ?? '');
  revived.dispose();
  const revivedDb = new DatabaseSync(oldDbPath);
  try {
    const turns = revivedDb.prepare("SELECT COUNT(*) AS n FROM facts WHERE text LIKE '%豆豆%'").get();
    check('对话原话没有当成记忆导进来', Number(turns.n) === 0, `${turns.n} 条`);
    const all = revivedDb.prepare('SELECT COUNT(*) AS n FROM facts').get();
    check('事实数还是原来那 1 条', Number(all.n) === 1, `${all.n} 条`);
    const imported = revivedDb.prepare("SELECT COUNT(*) AS n FROM facts WHERE source LIKE 'import:memory-loom%'").get();
    check('没有一条来源标成自己的旧库', Number(imported.n) === 0, `${imported.n} 条`);
  } finally {
    revivedDb.close();
  }

  // ── 12. 又出现一份新文件时会重新提醒 ────────────────────────────────
  console.log('\n[12] 新的一份会重新问一次');
  const againRoot = join(root, 'again');
  const againDb = join(againRoot, 'memory', 'loom.db');
  mkdirSync(join(againRoot, 'memory'), { recursive: true });
  writeDshMemoryDb(join(againRoot, 'memory', 'memory.db'), [{ text: '用户每周日晚上整理一次待办清单', tags: 'routine', at: Date.now() - 2 * DAY }]);
  const askAgain = createLoom({ dbPath: againDb });
  for (let i = 0; i < 4; i++) {
    await askAgain.turn(SESSION, `闲聊 ${i}`, '嗯。');
    askAgain.memoryBlock(SESSION);
  }
  check('问够三次就不问了', !askAgain.memoryBlock(SESSION).includes('可导入的记忆'), '');
  writeDshMemoryDb(join(againRoot, 'memory', 'memories.db'), [{ text: '用户把家里的路由器换成了一台新的，型号是 AX3000', tags: 'home', at: Date.now() - DAY }]);
  const newList = String(await askAgain.call('memory_import', {}, SESSION));
  check('不带参数调一次就会重新扫盘', newList.includes('memories.db'), newList.split('\n')[0] ?? '');
  check('新的一份会让提示重新出现', askAgain.memoryBlock(SESSION).includes('memories.db'), '');
  askAgain.dispose();

  // ── 13. 形状奇怪的库也能读 ──────────────────────────────────────────
  console.log('\n[13] WITHOUT ROWID 的表');
  const oddPath = join(root, 'odd.db');
  const odd = new DatabaseSync(oddPath);
  try {
    odd.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID');
    odd.prepare('INSERT INTO kv (k, value) VALUES (?, ?)').run('pet', '用户养了一只叫年糕的猫，是 2023 年冬天捡的');
    odd.prepare('INSERT INTO kv (k, value) VALUES (?, ?)').run('desk', '用户的工位靠窗，桌上有两盆多肉');
  } finally {
    odd.close();
  }
  mkdirSync(join(root, 'oddhome', 'memory'), { recursive: true });
  const oddLoom = createLoom({ dbPath: join(root, 'oddhome', 'memory', 'loom.db') });
  const oddPreview = String(await oddLoom.call('memory_import', { path: oddPath }, SESSION));
  check('没有 rowid 的表也读出来了', oddPreview.includes('会导入 2 条'), oddPreview.split('\n')[3] ?? '');
  check('回话里没报读不出来', !oddPreview.includes('读不出来'), '');
  oddLoom.dispose();
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {}
}

console.log(`\n${fail === 0 ? '✓' : '✗'} ${pass} 项通过，${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
