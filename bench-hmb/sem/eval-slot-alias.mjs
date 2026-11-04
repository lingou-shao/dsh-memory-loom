/*
 * 槽位通道的上界：别名闭包 + (主体, 属性) 枚举。
 *
 * 用户问「周舟 的位置改过几次」，而 seq 2–7 的原文写的是「满儿 的位置」——
 * 同体异名。精确名字匹配只能拿到改名之后的版本，所以变更题要的不是
 * 「加两列」，是「先做名字闭包，再按槽位枚举」。
 *
 * 这个脚本用题库自带的 subject / slot 标注当理想解析，量四件事：
 *   1. 精确名字能枚举到多少（现状的近似）
 *   2. 加上「改名为」闭包后能枚举到多少
 *   3. 嵌套主体（A·B）需不需要排除更长的前缀
 *   4. 分干扰类型的失败原因
 *
 * 复跑：node bench-hmb/sem/eval-slot-alias.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const units = JSON.parse(readFileSync('bench-hmb/out/sem/units.json', 'utf8'));
const cidmap = JSON.parse(readFileSync('bench-hmb/out/loom-epB.db.cidmap.json', 'utf8'));
const keys = JSON.parse(readFileSync('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main/chain/keys/keys.json', 'utf8'));

const l0len = new Map();
for (const e of cidmap) {
  let max = 0;
  for (let i = e.from; i <= e.to; i++) max = Math.max(max, Number(e.l0len?.[String(i)] ?? 0));
  l0len.set(e.cid, max || 400);
}

/* 一个 cid 段落里的全部文本，拼起来再判断。 */
const cidText = new Map();
for (const u of units) cidText.set(u.cid, `${cidText.get(u.cid) ?? ''} ${u.text}`);

/* 改名关系：「舟子 自第 2 章起改名为 周舟」。 */
const aliasEdge = [];
for (const u of units) {
  const m = /([^\s。，、；]{1,10})\s+自第\s*\d+\s*[章次][^。]*?改名为\s*([^\s。，、；]{1,10})/u.exec(u.text);
  if (m !== null) aliasEdge.push([m[1], m[2]]);
}

/** 名字闭包：同一实体的所有曾用名与现用名。 */
function closureOf(name) {
  const group = new Set([name]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [from, to] of aliasEdge) {
      if (group.has(from) || group.has(to)) {
        if (!group.has(from)) { group.add(from); grew = true; }
        if (!group.has(to)) { group.add(to); grew = true; }
      }
    }
  }
  return group;
}

/* 精确主体匹配：包含名字，且不是更长主体的一部分（嵌套主体 A·B 里 B 不算 A 的版本）。 */
function mentions(text, name) {
  let i = text.indexOf(name);
  while (i >= 0) {
    const before = text.slice(Math.max(0, i - 2), i);
    if (!before.endsWith('·')) return true;
    i = text.indexOf(name, i + 1);
  }
  return false;
}

function enumerate(subject, slot, names) {
  const picked = [];
  for (const [cid, text] of cidText) {
    if (!text.includes(slot)) continue;
    if (![...names].some((n) => mentions(text, n))) continue;
    picked.push(cid);
  }
  return picked;
}

const ch = keys.filter((q) => q.type === '变更' && !q.reconstructible && !q.ambiguous);
const rows = [];
for (const q of ch) {
  const subject = q.subject;
  const slot = q.slot;
  const names = closureOf(subject);
  const exact = enumerate(subject, slot, new Set([subject]));
  const expanded = enumerate(subject, slot, names);
  const need = q.answer.change_chain.map((c) => `${q.doc}#${c.seq}`);
  const hitExact = need.filter((n) => exact.includes(n)).length;
  const hitExp = need.filter((n) => expanded.includes(n)).length;
  rows.push({
    qid: q.qid, interference: q.interference, subject, slot,
    names: [...names], need: need.length,
    exact: hitExact, expanded: hitExp,
    exactFull: hitExact === need.length, expandedFull: hitExp === need.length,
    cids: expanded.length,
    chars: expanded.reduce((s, c) => s + (l0len.get(c) ?? 400), 0),
  });
}

const byType = new Map();
for (const r of rows) {
  const k = r.interference;
  if (!byType.has(k)) byType.set(k, []);
  byType.get(k).push(r);
}
console.log(`变更题 ${rows.length} 道｜改名关系 ${aliasEdge.length} 条\n`);
console.log('干扰类型       n   精确全中   闭包全中   精确 seq 覆盖   闭包 seq 覆盖');
for (const [k, list] of byType) {
  const n = list.length;
  const ef = list.filter((r) => r.exactFull).length;
  const xf = list.filter((r) => r.expandedFull).length;
  const es = list.reduce((s, r) => s + r.exact, 0) / list.reduce((s, r) => s + r.need, 0);
  const xs = list.reduce((s, r) => s + r.expanded, 0) / list.reduce((s, r) => s + r.need, 0);
  console.log(`${k.padEnd(10, '　')} ${String(n).padStart(4)}    ${String(ef).padStart(3)}/${n}      ${String(xf).padStart(3)}/${n}      ${(es * 100).toFixed(1).padStart(6)}%        ${(xs * 100).toFixed(1).padStart(6)}%`);
}
const tot = rows.reduce((s, r) => s + r.need, 0);
console.log(`\n合计：精确 seq ${rows.reduce((s, r) => s + r.exact, 0)}/${tot}｜闭包 seq ${rows.reduce((s, r) => s + r.expanded, 0)}/${tot}`);
console.log(`闭包全中 ${rows.filter((r) => r.expandedFull).length}/${rows.length}；平均枚举 ${(rows.reduce((s, r) => s + r.cids, 0) / rows.length).toFixed(1)} 段，${Math.round(rows.reduce((s, r) => s + r.chars, 0) / rows.length)} 字`);

console.log('\n未全中的题：');
for (const r of rows.filter((r) => !r.expandedFull)) {
  console.log(`  ${r.qid.slice(-8)} ${r.interference} ${r.subject}·${r.slot} 闭包{${r.names.join('/')}} ${r.expanded}/${r.need}`);
}

writeFileSync('bench-hmb/out/slot-alias.json', JSON.stringify({ aliasEdge, rows }, null, 1));
console.log('\n写出 bench-hmb/out/slot-alias.json');
