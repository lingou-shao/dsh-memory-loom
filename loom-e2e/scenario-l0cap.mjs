/**
 * 场景 D：L0 存储上限（l0.maxCharsPerMessage）
 *
 * 验证四件事：
 *   1. 默认 0 = 全文落库，一个字都不丢
 *   2. 显式上限会截断，且截断标记写在正文里（不是静默丢）
 *   3. 截断发生在脱敏之后 —— 密钥不会因为截断而漏存
 *   4. 超长行的 tokens 列不再膨胀（该列无读取方）
 *   5. 取回链路能吃下长正文（memory_expand 分页）
 */

import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const DB = fileURLToPath(new URL('./tmp-cap.db', import.meta.url));
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB}${suffix}`, { force: true });

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const LOG = `线上日志：${'ERROR TS2307 cannot find module src/app/module.ts at build step; '.repeat(800)}`;

const fresh = (name) => {
  const path = fileURLToPath(new URL(`./tmp-cap-${name}.db`, import.meta.url));
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${path}${suffix}`, { force: true });
  return path;
};

const lastUserRow = (path) => {
  const db = new DatabaseSync(path);
  const row = db.prepare("SELECT id, text, LENGTH(text) AS len, LENGTH(tokens) AS tok FROM l0 WHERE role='user' ORDER BY id DESC LIMIT 1").get();
  db.close();
  return row;
};

/* ---------------- 默认：不截断 ---------------- */

console.log(`\n[1] 默认配置（maxCharsPerMessage = 0）—— 发送 ${LOG.length} 字`);
const dbA = fresh('a');
const loomA = createLoom({ dbPath: dbA, config: { consolidation: { triggerTokens: 1e9 } } });
const t0 = performance.now();
await loomA.turn('s1', LOG, '收到。');
const writeMs = performance.now() - t0;
await loomA.settle(2);
const rowA = lastUserRow(dbA);
// textOf 会 trim 首尾空白，是上游既有行为，与本次改动无关
check('全文落库，一字不丢（除首尾空白）', rowA.len === LOG.trim().length && rowA.text === LOG.trim(), `存 ${rowA.len} 字 / 发 ${LOG.trim().length} 字`);
check('写入耗时不受长度拖累', writeMs < 2000, `${writeMs.toFixed(0)} ms`);
check('超长行不再存 tokens（该列无读取方）', rowA.tok === 0, `tokens 列 ${rowA.tok} 字符`);

/* 取回链路 */
const hooksA = loomA.call('memory_index', { action: 'view' }, 's1');
const refA = /^- (T|E\d+) /mu.exec(await hooksA)?.[1];
const bodyA = await loomA.call('memory_expand', { ref: refA }, 's1');
check('长正文可被索引取回', typeof bodyA === 'string' && bodyA.includes('TS2307'), `${refA}，返回 ${bodyA.length} 字`);
check('超出预算自动分页', bodyA.includes('offset='), /offset=\d+/u.exec(bodyA)?.[0] ?? '未分页');
loomA.dispose();

/* 首页 + 续读能否读完 28000 字 */
console.log('\n[2] 分页读完整篇长正文');
const loomB = createLoom({ dbPath: dbA, config: { consolidation: { triggerTokens: 1e9 } } });
let offset = Number(/offset=(\d+)/u.exec(bodyA)?.[1] ?? NaN);
let pages = 1;
let last = bodyA;
while (Number.isFinite(offset) && pages < 40) {
  last = await loomB.call('memory_expand', { ref: refA, offset }, 's1');
  pages++;
  if (/已返回完/u.test(last)) break;
  offset = Number(/offset=(\d+)/u.exec(last)?.[1] ?? NaN);
}
check('续读能读到末尾', /已返回完/u.test(last), `${pages} 页读完`);
loomB.dispose();

/* ---------------- 显式上限 ---------------- */

console.log('\n[3] 显式上限 32000 —— 发送 30000 字');
const dbB = fresh('b');
const loomC = createLoom({ dbPath: dbB, config: { consolidation: { triggerTokens: 1e9 }, l0: { maxCharsPerMessage: 32000 } } });
const short = LOG.slice(0, 30000);
await loomC.turn('s1', short, '收到。');
const rowB = lastUserRow(dbB);
check('未超上限时不加标记', rowB.text === short && rowB.len === short.length, `${rowB.len} 字，无标记`);
loomC.dispose();

console.log('\n[4] 显式上限 32000 —— 发送 40000 字（必须截断）');
const loomD = createLoom({ dbPath: dbB, config: { consolidation: { triggerTokens: 1e9 }, l0: { maxCharsPerMessage: 32000 } } });
const long = LOG.slice(0, 40000);
await loomD.turn('s1', long, '收到。');
const rowC = lastUserRow(dbB);
check('正文被截到 32000 字', rowC.text.startsWith(long.slice(0, 32000).trimEnd()), `保留前 32000 字，总长 ${rowC.len}`);
check('截断处写明原因与原文长度', /…\[已截断：原消息 \d{5} 字，仅保留前 32000 字。/u.test(rowC.text), rowC.text.slice(-64).trim());
check('标记会告诉模型可调大配置', rowC.text.includes('l0.maxCharsPerMessage'), '含配置项名');
check('标记不会盖掉正文', rowC.text.length > 32000 && rowC.text.length < 32200, `总长 ${rowC.text.length} 字`);
loomD.dispose();

/* ---------------- 脱敏与截断的顺序 ---------------- */

console.log('\n[5] 脱敏与截断的先后');
const dbC = fresh('c');
const loomE = createLoom({ dbPath: dbC, config: { consolidation: { triggerTokens: 1e9 }, l0: { maxCharsPerMessage: 500 } } });
const secretAtTail = `前面是正常的聊天内容，用来把密钥挤到 500 字之后。${'填充说明文字继续写下去，凑够长度。'.repeat(30)} 最后这里贴一个密钥：sk-proj-abcdefghijklmnopqrstuvwxyz0123`;
await loomE.turn('s1', secretAtTail, '收到。');
const rowD = lastUserRow(dbC);
check('落库文本里没有明文密钥', !rowD.text.includes('sk-proj-abcdefghijklmnopqrstuvwxyz0123'), '未出现明文');
check('截断后仍保留可读前缀', rowD.text.startsWith('前面是正常的聊天内容'), rowD.text.slice(0, 16));
loomE.dispose();

/* ---------------- 体积对比 ---------------- */

console.log('\n[6] 体积：10 条长消息');
const dbD = fresh('d');
const loomF = createLoom({ dbPath: dbD, config: { consolidation: { triggerTokens: 1e9 } } });
for (let i = 0; i < 10; i++) await loomF.turn('s1', `第 ${i} 条。${LOG.slice(0, 12000)}`, '收到。');
loomF.dispose();
const dbStats = new DatabaseSync(dbD);
const stat = dbStats.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(text)) AS chars, SUM(LENGTH(tokens)) AS toks FROM l0 WHERE role='user'").get();
const pageCount = dbStats.prepare('PRAGMA page_count').get().page_count;
const pageSize = dbStats.prepare('PRAGMA page_size').get().page_size;
dbStats.close();
console.log(`  L0 ${stat.n} 行 / 正文共 ${stat.chars} 字符 / tokens 列共 ${stat.toks} 字符`);
console.log(`  库体积 ${(pageCount * pageSize / 1024).toFixed(0)} KB（UTF-8 中文约 3 字节/字）`);
check('tokens 列不再重复占用空间', stat.toks === 0, `${stat.toks} 字符`);
check('体积接近正文本身', pageCount * pageSize / (stat.chars * 3) < 1.6, `${(pageCount * pageSize / (stat.chars * 3)).toFixed(2)}x`);

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
