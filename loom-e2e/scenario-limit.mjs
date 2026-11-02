/**
 * 场景 B：极限测试
 *
 * 目标：把记忆拉到「原上下文窗口已装不下」的量级，看两件事——
 *   1. 原插件的记忆块在压力下变成什么样（是否被硬截断、结构是否破坏）
 *   2. 索引层是否保持一致的开销，老内容是否还能取回
 *
 * 量级设计：60 轮对话 + 40 条事实 + 单条 12000 字的超长输入。
 */

import { rmSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';
import { HookIndex, indexDefaults as DEFAULTS, estimateTokens } from '../lib/index.js';

const DB = fileURLToPath(new URL('./tmp-limit.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const SESSION = 's-long';

/* ---------------- 语料：混合工作对话 ---------------- */

const TOPICS = [
  ['代码', '把 UserService 里的重试逻辑抽成装饰器，现在三个方法里各写了一遍，改一处要改三处。', '抽出来可以，但注意装饰器拿不到 this 的类型，TS 里要用 ThisType 或者干脆写高阶函数包一层。'],
  ['代码', 'CI 上偶发失败，本地永远复现不了，怀疑是时区相关，因为有个测试断言了具体的日期字符串。', '先把测试跑在 TZ=UTC 和 TZ=Asia/Shanghai 两遍，如果只有一边挂就确认了。断言日期就别比字符串，比时间戳。'],
  ['表格', '销售报表要按区域和月份双维度汇总，现在是两个透视表手工拼的，每月要花两个小时。', '用 SUMIFS 一次算完，或者直接上 Power Query。两小时的活值得自动化，但先确认口径稳定再自动化，不然每月都在改公式。'],
  ['表格', '客户给的 CSV 是分号分隔的，还有个字段里带换行，pandas 读出来整张表错位。', 'sep=";" 加 quoting=3 会好一点，但带换行的字段必须靠 quotechar。先 head -5 看一眼原文，别猜。'],
  ['会议', '下周要跟客户对需求，他们上次说的三个优先级这次又变了，我得准备一版对照表。', '对照表要写清「什么时候说的、当时理由是什么、现在改成什么」，只列变更不列理由，客户会觉得你在挑刺。'],
  ['邮件', '给上游发了个 bug report，两天没回，要不要升级。', '看影响面。如果影响线上收入就升级到对方 TL，如果只是体验问题就等等。邮件里补一句「如需我提供复现脚本请告知」，比催进度有效。'],
  ['代码', '数据库连接池偶尔打满，日志里全是 wait timeout，但 QPS 并没有明显上涨。', '看是不是慢查询占着连接不放。先按 pg_stat_activity 拉一份按 state 分组的快照，再看有没有 idle in transaction。'],
  ['表格', '这版报表领导要求加同比环比，但去年同期的数据口径不一样，直接算会很难看。', '口径不一样就不能直接算，要么按新口径回算去年，要么在表头标注「口径已调整，同比仅供参考」。别偷偷算，数字对不上会被问。'],
];
const pick = (i) => TOPICS[i % TOPICS.length];
const ROUNDS = 60;

const loom = createLoom({
  dbPath: DB,
  config: { consolidation: { triggerTokens: 150, dailyLlmCalls: 0 }, locale: 'zh' },
});

const db = new DatabaseSync(DB);
db.exec('PRAGMA busy_timeout = 5000');
const q = (sql, ...args) => db.prepare(sql).get(...args);

console.log(`[1] 灌入 ${ROUNDS} 轮工作对话`);
const personaBefore = loom.persona(SESSION);
const started = Date.now();
let charsSent = 0;
for (let i = 0; i < ROUNDS; i++) {
  const [, user, assistant] = pick(i);
  charsSent += user.length + assistant.length;
  await loom.turn(SESSION, user, assistant);
}
await loom.settle(10);
const elapsed = (Date.now() - started) / 1000;

const l0 = q('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars FROM l0 WHERE session_id = ?', SESSION);
console.log(`  ${elapsed.toFixed(1)}s 写入完成：L0 ${l0.n} 条 / ${l0.chars} 字，事件 ${q('SELECT COUNT(*) AS n FROM events').n} 段`);

check('L0 一条不丢', l0.n === ROUNDS * 2, `${l0.n} / ${ROUNDS * 2}`);
check('L0 一字不丢', l0.chars === charsSent, `${l0.chars} / ${charsSent}`);

/* ---------------- 压力二：大量事实 ---------------- */

console.log('\n[2] 再压 40 条事实（走真实 memory_write 工具）');
for (let i = 0; i < 40; i++) {
  const [domain, user] = pick(i);
  await loom.call('memory_write', { text: `[${domain}] 第 ${i} 条：${user.slice(0, 34)}`, kind: 'fact', pinned: i < 3 }, SESSION);
}
const facts = q('SELECT COUNT(*) AS n FROM facts').n;
const events = q('SELECT COUNT(*) AS n FROM events').n;
console.log(`  事实 ${facts} 条，事件 ${events} 段`);

const block = loom.memoryBlock(SESSION);
const blockTokens = estimateTokens(block);
const shownLines = (block.match(/^- /gmu) ?? []).length;
console.log(`  原插件记忆块：${block.length} 字 / ${blockTokens} token / ${shownLines} 行（软目标 2000 / 硬顶 3000，条目上限 20）`);

check('记忆块被限制在硬顶以内', blockTokens <= 3000, `${blockTokens} token`);
check('事实有 41 条，记忆块只呈现其中一部分', shownLines < facts, `池子 ${facts} 条，呈现 ${shownLines} 行`);
check('丢弃是静默的，没有任何提示', !/还有 \d+ 条/u.test(block), 'SECTION.more 文案定义了但全文件零引用');

const personaAfter = loom.persona(SESSION);
check('人设块在压力下逐字未变', personaBefore === personaAfter, `${estimateTokens(personaAfter)} token`);

/* ---------------- 索引层接管（同一个库，并发连接） ---------------- */

console.log('\n[3] 索引层在同样压力下的开销（合并进主插件，随对话自动维护）');
const index = new HookIndex(db, { ...DEFAULTS, locale: 'zh' });
const t0 = performance.now();
const report = index.rebuild('master');
const rebuildMs = performance.now() - t0;
const hooks = index.render('master');
const hookTokens = estimateTokens(hooks);
console.log('--- 索引块 ---');
console.log(hooks);
console.log('---');
console.log(`  候选 ${report.candidates} 条 → 驻留 ${report.resident} 条 / ${hookTokens} token，重建 ${rebuildMs.toFixed(1)}ms`);

check('事件涨到几十段后索引仍是固定条数', report.resident <= DEFAULTS.maxHooks, `${report.resident} 条 / 上限 ${DEFAULTS.maxHooks}`);
check('索引块比原记忆块更省', hookTokens < blockTokens, `${hookTokens} vs ${blockTokens}`);
check('重建耗时可控', rebuildMs < 200, `${rebuildMs.toFixed(1)}ms`);
const distinctLabels = new Set(hooks.split('\n').slice(1).map((line) => line.replace(/^- \S+ /u, '').replace(/\s+\d+(\.\d+)?k?字$/u, ''))).size;
check('每条驻留钩子都是不同主题（近重复被折叠）', distinctLabels === report.resident, `${report.resident} 条 → ${distinctLabels} 种主题；规则模式的 41 段里有 31 段是同名近似重复`);

/* ---------------- 老内容还能不能取回 ---------------- */

console.log('\n[4] 不在 prompt 里的记忆，是否还能取回');
const first = db.prepare("SELECT id, title FROM events WHERE identity_id='master' ORDER BY id LIMIT 1").get();
const early = index.body('master', `E${first.id}`);
check('最早那段事件可展开', early.ok && early.chars > 100, `E${first.id}「${first.title.slice(0, 14)}」${early.chars} 字`);

const resident = new Set(db.prepare("SELECT ref FROM loom_hooks WHERE identity_id='master' AND resident=1").all().map((r) => r.ref));
const hiddenRow = db.prepare(`
  SELECT e.id, e.title, LENGTH(e.summary) AS n FROM events e
  JOIN loom_hooks h ON h.ref = ('E' || e.id)
  WHERE h.identity_id = 'master' AND h.resident = 0
  ORDER BY e.id LIMIT 1
`).get();
check('存在被挤出 prompt 的事件', hiddenRow !== undefined, hiddenRow === undefined ? '全部驻留' : `E${hiddenRow.id} 不在驻留集`);
if (hiddenRow !== undefined) {
  const hiddenBody = index.body('master', `E${hiddenRow.id}`);
  check('它仍能取回完整正文', hiddenBody.ok && hiddenBody.chars > 50, `E${hiddenRow.id} ${hiddenBody.chars} 字`);
}
const coldCount = q("SELECT COUNT(*) AS n FROM loom_hooks WHERE identity_id='master' AND resident=0").n;
console.log(`  驻留 ${resident.size} 条，冷区 ${coldCount} 条（memory_index search / memory_expand 仍可命中）`);

/* ---------------- 模拟上下文被压缩 ---------------- */

console.log('\n[5] 模拟宿主 compaction（原上下文窗口到极限）');
loom.emit('session/event', { id: SESSION }, { type: 'compaction/start', data: {}, time: Date.now() });
await loom.settle(2);
const afterCompact = q('SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(text)),0) AS chars FROM l0 WHERE session_id = ?', SESSION);
check('压缩事件不碰 L0', afterCompact.n === l0.n && afterCompact.chars === l0.chars, `${afterCompact.n} 条 / ${afterCompact.chars} 字`);
const afterBody = index.body('master', `E${first.id}`);
check('压缩之后正文仍可取回', afterBody.ok && afterBody.chars === early.chars, `${afterBody.chars} 字`);

/* ---------------- 单条超长输入 ---------------- */

console.log('\n[6] 单条 12000 字的超长输入（贴日志）');
const huge = `线上日志如下：${'ERROR connection pool exhausted at UserService.retry line 412; '.repeat(180)}`;
console.log(`  发送 ${huge.length} 字`);
await loom.turn(SESSION, huge, '收到，我先看 pool exhaustion 的调用栈，再看 retry 有没有放大请求。');
await loom.settle(6);
const stored = q('SELECT LENGTH(text) AS len FROM l0 WHERE session_id = ? ORDER BY id DESC LIMIT 2', SESSION);
const hugeLen = q('SELECT MAX(LENGTH(text)) AS len FROM l0 WHERE session_id = ?', SESSION).len;
check('超长消息完整落库（0.2.1 起默认不截断）', hugeLen === huge.trim().length, `发送 ${huge.trim().length} 字 → 存入 ${hugeLen} 字`);

/* ---------------- 抖动与体积 ---------------- */

console.log('\n[7] 抖动检查：连续 20 次重建，驻留集合是否稳定');
const snapshots = new Set();
for (let i = 0; i < 20; i++) {
  index.rebuild('master');
  snapshots.add(index.render('master'));
}
check('20 次重建结果完全一致', snapshots.size === 1, `${snapshots.size} 种结果`);

const size = statSync(DB).size + (statSync(`${DB}-wal`).size ?? 0);
console.log(`  数据库体积 ${(size / 1024).toFixed(0)} KB（60 轮 + 40 事实 + 1 条 12000 字）`);

loom.dispose();
db.close();
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
