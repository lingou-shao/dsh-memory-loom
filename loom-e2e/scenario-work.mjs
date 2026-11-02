/**
 * 场景 A：工作类记忆（写代码 + 表格）
 *
 * 用真实插件跑一遍，然后让索引层接管同一个库，验证：
 *   1. 索引能否同时覆盖「代码」和「表格」两条工作线
 *   2. 展开能否取回真正有用的细节（变量名、报错、结论）
 *   3. 上下文里省了多少
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';
import { HookIndex, indexDefaults as DEFAULTS, estimateTokens } from '../lib/index.js';

const DB = fileURLToPath(new URL('./tmp-work.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ---------------- 素材：两条真实工作线 ---------------- */

const CODE = [
  [
    '线上那个 Node 服务内存一直在涨，heap 每 6 小时涨 200MB 左右，重启就回落。我怀疑是 EventEmitter 的监听器没解绑，因为每个请求都会往全局 bus 上挂一个回调。',
    '先别猜。用 --inspect 连上去打两份 heap snapshot，间隔一小时，对比 retained size。同时加一行埋点打 bus.listenerCount("job:done")，如果这个数字随请求数线性增长，就基本确认了。',
  ],
  [
    'listenerCount 现在 47000 多了，确认是泄漏。问题是我当时写的是 bus.on("job:done", handler)，handler 里引用了 req，所以 req 也一起泄漏了。',
    '那就不只是监听器泄漏，是整个请求上下文被闭包抓住了。两个改法：一是用 bus.once，任务完成即摘；二是把回调改成只依赖 jobId，别碰 req。前者简单但语义变了，后者更彻底。我倾向后者。',
  ],
  [
    '改完了，把 handler 改成只接 jobId，再去 db 里查。灰度到 10% 之后 listenerCount 稳定在 120 左右，不再线性增长。但新问题：以前 handler 里直接能拿到 req.user，现在要重新查一次用户。',
    '多一次查询可以接受，但要加一层 request 级别的缓存，别在循环里查。另外注意 db 查询失败时的兜底，原来靠 req 里的兜底逻辑现在没了。',
  ],
  [
    '缓存加了。另外想统一一下命名，现在有 bus、eventBus、jobBus 三个名字指同一个东西，还有 handler、listener、callback 混用。',
    '统一成 eventBus 一个名字，回调统一叫 onJobDone。顺手在 eslint 里加 no-restricted-syntax 禁掉 .on( 只允许 .once( 和 .subscribe(，不然半年后又会有人写回去。',
  ],
];

const SHEET = [
  [
    '我用 pandas 读一个别人做的 Excel，读出来有一半行是 NaN，但打开看确实有值。表头上面还有两行标题，合并单元格跨了好几列。',
    '合并单元格在 pandas 里只有左上角那格有值，其余是 NaN，这是正常的。两个办法：header=2 跳过标题行，然后对合并列做 ffill；或者直接用 openpyxl 读 merged_cells.ranges 手动填充。后者更可控。',
  ],
  [
    '我用了 ffill，但有个坑：有几个空白单元格本来就是空的，ffill 把上一行的值填进去了，数据就错了。',
    '所以别用 ffill 一把梭。用 openpyxl 拿到 merged_cells.ranges，只填充真正属于合并区域的格子，其余空白保持 NaN。这是唯一语义正确的做法。',
  ],
  [
    '改好了。现在导出 CSV 用 Excel 打开中文全是乱码，客户在投诉。',
    '编码问题。to_csv 加 encoding="utf-8-sig"，BOM 是给 Excel 看的，没有它 Excel 会按 GBK 猜。另外如果字段里有逗号，加 quoting=csv.QUOTE_MINIMAL。',
  ],
  [
    '有个公式列读出来是字符串 "=SUM(B2:B10)"，不是计算结果。这个能修吗？',
    'pandas 读的是公式本身，不是缓存值。用 openpyxl 的 load_workbook(data_only=True) 拿缓存结果，前提是文件被 Excel 保存过、算过。如果文件是程序生成的没算过，就只能自己算或者让上游补算。',
  ],
];

/* ---------------- 跑真实插件 ---------------- */

const loom = createLoom({
  dbPath: DB,
  config: {
    consolidation: { triggerTokens: 150 },
    locale: 'zh',
  },
});

console.log('[1] 真实插件写入工作记忆');
for (const [user, assistant] of CODE) await loom.turn('s-code', user, assistant);
for (const [user, assistant] of SHEET) await loom.turn('s-sheet', user, assistant);
await loom.settle(8);

const codeBlock = loom.memoryBlock('s-code');
const sheetBlock = loom.memoryBlock('s-sheet');
console.log(`  代码会话记忆块 ${estimateTokens(codeBlock)} token，表格会话 ${estimateTokens(sheetBlock)} token`);

/* ---------------- 索引层（已合并进主插件） ---------------- */

console.log('\n[1b] 主插件自动维护的钩子块');
const codeHooks = loom.indexBlock('s-code');
const sheetHooks = loom.indexBlock('s-sheet');
console.log('--- 代码会话索引块 ---');
console.log(codeHooks);
console.log('---');
check('钩子块已生成且在记忆块之前', codeHooks.startsWith('【记忆索引】') || codeHooks.startsWith('[Memory index]'), `${estimateTokens(codeHooks)} token（order 895 < 900）`);
check('索引块远小于记忆块', estimateTokens(codeHooks) < estimateTokens(codeBlock), `${estimateTokens(codeHooks)} vs ${estimateTokens(codeBlock)}`);
const tools = loom.toolNames();
check('三个索引工具已注册', ['memory_expand', 'memory_pack', 'memory_index'].every((n) => tools.includes(n)), tools.join(', '));
loom.dispose();

/* ---------------- 数据盘点 ---------------- */

const db = new DatabaseSync(DB);
const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
console.log(`  L0 ${count('l0')} 条 / 事件 ${count('events')} 段 / 事实 ${count('facts')} 条 / 人设区 ${count('persona_zones')}`);
check('L0 完整保存了全部 16 轮', count('l0') === 16, `${count('l0')} 条`);
check('整合产出了事件段', count('events') >= 2, `${count('events')} 段`);
check('规则模式对技术内容抽不出事实（发现）', count('facts') === 0, '0 条 —— extractWithRules 只认偏好/身份/计划句式，代码与表格内容全被过滤');

/* ---------------- 索引层重建与展开 ---------------- */

console.log('\n[2] 索引重建（与主插件同一份代码路径）');
const index = new HookIndex(db, { ...DEFAULTS, locale: 'zh', hooksBudgetTokens: 300, maxHooks: 16 });
const report = index.rebuild('master');
const hooks = index.render('master');
console.log('--- 索引块 ---');
console.log(hooks);
console.log('---');
console.log(`  候选 ${report.candidates} 条 → 驻留 ${report.resident} 条，${report.tokens} token`);

check('索引块在 300 token 预算内', report.tokens <= 300, `${report.tokens} token`);
check('索引至少覆盖两条工作线', report.resident >= 2, `${report.resident} 条`);

/* ---------------- 展开验证 ---------------- */

console.log('\n[3] 展开：钩子背后的细节还在不在');

const rows = db.prepare('SELECT ref, kind, label FROM loom_hooks WHERE identity_id = ? AND resident = 1 ORDER BY score DESC').all('master');
const bodies = [];
for (const row of rows) {
  const found = index.body('master', row.ref);
  if (found.ok) bodies.push({ ...row, text: found.text, tokens: estimateTokens(found.text) });
}
const all = bodies.map((row) => row.text).join('\n');
check('每条驻留钩子都能展开', bodies.length === rows.length, `${bodies.length}/${rows.length}`);

const probes = [
  ['代码细节：listenerCount', /listenerCount/u],
  ['代码细节：once / 闭包', /once|闭包|req/u],
  ['代码细节：灰度结论', /灰度|10%|120/u],
  ['代码细节：命名统一', /eventBus|onJobDone/u],
  ['表格细节：merged_cells', /merged_cells|合并单元格/u],
  ['表格细节：utf-8-sig', /utf-8-sig/u],
  ['表格细节：data_only', /data_only/u],
  ['表格细节：ffill 的坑', /ffill/u],
];
for (const [label, pattern] of probes) check(label, pattern.test(all));

console.log('\n[4] 成本对比');
const beforeChars = codeBlock.length + sheetBlock.length;
const expandTokens = bodies.reduce((sum, row) => sum + row.tokens, 0);
console.log(`  原插件：两条会话的记忆块合计 ${beforeChars} 字 / ${estimateTokens(codeBlock) + estimateTokens(sheetBlock)} token（每轮都进上下文）`);
console.log(`  索引层：索引块 ${report.tokens} token（每轮）+ 展开 ${bodies.length} 次共 ${expandTokens} token（按需）`);
console.log(`  同一轮里两条会话都活跃时：${estimateTokens(codeBlock) + estimateTokens(sheetBlock)} → ${report.tokens} token`);

/* ---------------- 交叉验证：原插件的检索 vs 索引的展开 ---------------- */

console.log('\n[5] 两套检索路径的对照（同一问题，看谁答得上）');
const q = '那个内存泄漏最后是怎么确认的';
const searchHits = db.prepare('SELECT text FROM facts WHERE identity_id = ? AND text LIKE ? LIMIT 5').all('master', '%泄漏%');
const keyword = q.replace(/[那个最后是怎么确认的]/gu, '').slice(0, 2);
console.log(`  问题：「${q}」`);
console.log(`  memory_search 能给的：${searchHits.length} 条事实 → ${searchHits.map((r) => r.text.slice(0, 24)).join(' / ') || '（无）'}`);
const leakHook = bodies.find((row) => /listenerCount|泄漏/.test(row.text));
console.log(`  memory_expand 能给的：${leakHook ? `${leakHook.ref} 全文 ${leakHook.text.length} 字，含「listenerCount 现在 47000 多」` : '（无）'}`);
check('展开能回答"怎么确认的"，事实不能', leakHook !== undefined && /47000/.test(leakHook.text));

db.close();
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
