/**
 * 审计探针：把「怀疑」变成可测的断言。
 * 只跑不改，输出每条的实测结果，用于决定是否要改代码。
 */

import { rmSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';
import { sliceByTokens, estimateTokens, parseRef } from '../lib/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SESSION = 'probe-audit';

let fails = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails++;
};
const info = (label, detail) => console.log(`  ..   ${label} — ${detail}`);

const l0Count = (db) => {
  try {
    const conn = new DatabaseSync(db, { readOnly: true });
    const n = conn.prepare('SELECT COUNT(*) AS n FROM l0').get().n;
    conn.close();
    return Number(n);
  } catch {
    return -1;
  }
};

const fresh = (name) => {
  const db = `${HERE}tmp-audit-${name}.db`;
  for (const s of ['', '-wal', '-shm']) rmSync(`${db}${s}`, { force: true });
  return db;
};

/* ── 1. 代理对（emoji）在分页边界会不会被劈成两半 ───────────── */
console.log('\n[1] sliceByTokens 切在代理对中间');
{
  // 每个 emoji 占 2 个 UTF-16 码元；budget 取奇数，逼它切在中间
  const text = '中'.repeat(31) + '😀'.repeat(200);
  let offset = 0;
  let splits = 0;
  let pages = 0;
  for (let i = 0; i < 40; i++) {
    const { piece, end, done } = sliceByTokens(text, offset, 13);
    if (piece.length === 0) break;
    pages++;
    const last = piece.charCodeAt(piece.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) splits++;
    offset = end;
    if (done) break;
  }
  check('分页未出现半个代理对', splits === 0, `${pages} 页，其中 ${splits} 页以孤立高代理结尾`);
}

/* ── 2. offset 越界 ─────────────────────────────────────────── */
console.log('\n[2] offset 越界与负数');
{
  const r1 = sliceByTokens('短文本', 999, 4000);
  check('offset 超过长度返回空且 done', r1.piece === '' && r1.done === true, JSON.stringify(r1));
  const r2 = sliceByTokens('短文本', -5, 4000);
  check('负 offset 被夹紧', r2.piece === '短文本', JSON.stringify({ piece: r2.piece, end: r2.end }));
}

/* ── 3. 分页完整性：全文能否无损拼回 ────────────────────────── */
console.log('\n[3] 大正文分页拼接是否无损');
{
  const db = fresh('paging');
  const loom = createLoom({ dbPath: db, config: { timezone: 'Asia/Shanghai' } });
  const body = Array.from({ length: 400 }, (_, i) => `第${i}行：这是一段用来测试分页完整性的中文正文，包含数字 ${i * 37} 与英文 token-${i}。`).join('\n');
  await loom.turn(SESSION, '把下面这段整理成一篇正文', '好的');
  const packed = await loom.call('memory_pack', { title: '分页完整性', text: body }, SESSION);
  const ref = /D\d+/u.exec(packed)?.[0];
  check('memory_pack 生成了 D 编号', ref !== undefined, packed.slice(0, 60));

  if (ref !== undefined) {
    let offset = 0;
    const parts = [];
    let pages = 0;
    let guard = 0;
    while (guard++ < 200) {
      const page = await loom.call('memory_expand', { ref, offset }, SESSION);
      // 去掉页脚（以 --- 或「续读」开头的行之后的不算正文）
      const cut = page.lastIndexOf('\n—\n');
      const textPart = cut === -1 ? page : page.slice(0, cut);
      parts.push(textPart);
      pages++;
      const next = /offset=(\d+)/u.exec(page);
      if (next === null) break;
      const n = Number(next[1]);
      if (n <= offset) break;
      offset = n;
    }
    const joined = parts.join('');
    const same = joined.length >= body.length && body.split('\n').every((line) => joined.includes(line));
    check('分页能覆盖全文每一行', same, `共 ${pages} 页，拼回 ${joined.length} 字 / 原文 ${body.length} 字`);
    check('分页没有无限循环', pages < 60, `${pages} 页`);
  }
  loom.dispose();
}

/* ── 4. 脱敏正则的灾难性回溯 ───────────────────────────────── */
console.log('\n[4] redactSecrets 对恶意输入的性能');
{
  // 用一条长数字串 + 空格，压 (?:\\d[ -]?){13,19} 这个模式
  const adversarial = '1 '.repeat(20000) + 'x';
  const t0 = process.hrtime.bigint();
  const db = fresh('redos');
  const loom = createLoom({ dbPath: db, config: {} });
  await loom.turn(SESSION, adversarial, '收到');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('恶意数字串不会卡死写入', ms < 5000, `${ms.toFixed(0)} ms`);
  loom.dispose();
}

/* ── 5. 相对路径 / 含空格 / 非 ASCII 路径 ──────────────────── */
console.log('\n[5] 非本机路径形态（空格 + 中文 + 相对路径）');
{
  const weirdDir = `${HERE}tmp dir 中文 命名`;
  mkdirSync(weirdDir, { recursive: true });
  const weirdDb = `${weirdDir}/记忆 loom.db`;
  for (const s of ['', '-wal', '-shm']) rmSync(`${weirdDb}${s}`, { force: true });
  let ok = false;
  let detail = '';
  try {
    const loom = createLoom({ dbPath: weirdDb, config: {} });
    await loom.turn(SESSION, '路径里带空格和中文', '记下了');
    ok = l0Count(weirdDb) > 0;
    detail = `l0 落库 ${l0Count(weirdDb)} 行`;
    loom.dispose();
  } catch (error) {
    detail = String(error).slice(0, 80);
  }
  check('含空格与中文的路径可正常建库写入', ok, detail);
  for (const s of ['', '-wal', '-shm']) rmSync(`${weirdDb}${s}`, { force: true });
  rmSync(weirdDir, { recursive: true, force: true });
}

/* ── 6. :memory: 路径 ──────────────────────────────────────── */
console.log('\n[6] :memory: 路径');
{
  let ok = false;
  let detail = '';
  try {
    const loom = createLoom({ dbPath: ':memory:', config: {} });
    await loom.turn(SESSION, '内存库试一下', '好');
    ok = loom.shared.tools.size > 0;
    detail = `工具注册 ${loom.shared.tools.size} 个，l0 可写`;
    loom.dispose();
  } catch (error) {
    detail = String(error).slice(0, 80);
  }
  check(':memory: 可用', ok, detail);
}

/* ── 7. 空正文 / 非法编号 ──────────────────────────────────── */
console.log('\n[7] 边界输入');
{
  const db = fresh('edge');
  const loom = createLoom({ dbPath: db, config: {} });
  await loom.turn(SESSION, '随便说一句', '嗯');

  const emptyPack = await loom.call('memory_pack', { title: '空的', text: '   ' }, SESSION);
  info('memory_pack 空正文', emptyPack.slice(0, 70));

  const badRef = await loom.call('memory_expand', { ref: 'ZZZ' }, SESSION);
  check('非法编号给出可读提示而不是抛错', /没有取到|不存在|无法/u.test(badRef), badRef.slice(0, 50));

  const hashRef = await loom.call('memory_expand', { ref: '#E1' }, SESSION);
  check('带 # 的编号能识别', /【正文|没有取到/u.test(hashRef), hashRef.slice(0, 40));

  info('parseRef("#E1") =', JSON.stringify(parseRef('#E1')));
  loom.dispose();
}

/* ── 8. 两个进程同时打开同一个库 ───────────────────────────── */
console.log('\n[8] 并发打开同一库');
{
  const db = fresh('concurrent');
  const a = createLoom({ dbPath: db, config: {} });
  await a.turn(SESSION, '进程 A 写一条', '好');
  let ok = false;
  let detail = '';
  try {
    const b = createLoom({ dbPath: db, config: {} });
    await b.turn('probe-audit-b', '进程 B 也写一条', '好');
    ok = l0Count(db) >= 2;
    detail = `l0 共 ${l0Count(db)} 行（两个连接各写一条）`;
    b.dispose();
  } catch (error) {
    detail = String(error).slice(0, 100);
  }
  check('同一库被两个连接同时打开仍可写', ok, detail);
  a.dispose();
}

/* ── 9. 估算一致性：estimateTokens 对代理对 ────────────────── */
console.log('\n[9] estimateTokens 与切片的自洽');
{
  const text = '😀'.repeat(100); // 200 码元 / 100 码点
  const tokens = estimateTokens(text);
  info('100 个 emoji（200 码元）估算 token', String(tokens));
  const { piece } = sliceByTokens(text, 0, 10);
  check('emoji 文本切片不超过预算', estimateTokens(piece) <= 10, `切出 ${piece.length} 码元，${estimateTokens(piece)} token`);
}

console.log(fails === 0 ? '\n审计探针：全部通过' : `\n审计探针：${fails} 项异常`);
for (const n of ['paging', 'redos', 'edge', 'concurrent']) {
  for (const s of ['', '-wal', '-shm']) rmSync(`${HERE}tmp-audit-${n}.db${s}`, { force: true });
}
process.exit(fails === 0 ? 0 : 1);
