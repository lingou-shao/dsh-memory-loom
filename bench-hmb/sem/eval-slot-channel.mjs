/*
 * 槽位通道当作第三条通道时，全量 561 题上的收益与成本。
 *
 * 输入是 eval-assertion.mjs 产出的断言表（理想抽取），所以这里的数字是
 * 天花板：它回答「如果抽取做对了，这条路能拿多少、要花多少字」。
 *
 * 复跑：node bench-hmb/sem/eval-slot-channel.mjs
 */
import { readFileSync } from 'node:fs';

const data = JSON.parse(readFileSync('bench-hmb/out/assertion.json', 'utf8'));
const questions = JSON.parse(readFileSync('bench-hmb/out/sem/questions.json', 'utf8'));
const retrieval = JSON.parse(readFileSync('bench-hmb/out/retrieval_loom-epB.json', 'utf8'));
const cidmap = JSON.parse(readFileSync('bench-hmb/out/loom-epB.db.cidmap.json', 'utf8'));

const l0len = new Map();
for (const e of cidmap) {
  let max = 0;
  for (let i = e.from; i <= e.to; i++) max = Math.max(max, Number(e.l0len?.[String(i)] ?? 0));
  l0len.set(e.cid, max || 400);
}

const assertions = data.assertions;
const byCid = new Map();
for (const a of assertions) {
  if (!byCid.has(a.cid)) byCid.set(a.cid, []);
  byCid.get(a.cid).push(a);
}
const subjects = [...new Set(assertions.map((a) => a.subject))].sort((a, b) => b.length - a.length);
const attrs = [...new Set(assertions.map((a) => a.attr))].sort((a, b) => b.length - a.length);

/** 问句侧：库内实体名与属性名都是小集合，子串命中即可，不调模型。 */
function slotOf(question) {
  const q = String(question);
  const s = subjects.filter((x) => q.includes(x));
  const a = attrs.filter((x) => q.includes(x));
  return { subjects: s, attrs: a, picked: s.length > 0 && a.length > 0 };
}

const base = new Map(retrieval.rows.map((r) => [r.qid, r]));
const judge = (q, cids) => {
  const need = q.need ?? [];
  if (need.length === 0) return false;
  return q.all_needed ? need.every((n) => cids.has(n)) : need.some((n) => cids.has(n));
};

const rows = [];
for (const q of questions) {
  const slot = slotOf(q.question);
  const cids = new Set();
  let chars = 0;
  let items = 0;
  if (slot.picked) {
    for (const a of assertions) {
      if (slot.subjects.includes(a.subject) && slot.attrs.includes(a.attr)) {
        cids.add(a.cid);
        items++;
        /* 一条断言的渲染成本：主体 + 属性 + 值 + 序号，约 32 字。 */
        chars += 32;
      }
    }
  }
  const r = base.get(q.qid);
  const rawCids = new Set((r?.raw ?? []).map((h) => h.cid));
  rows.push({
    qid: q.qid, type: q.type, all_needed: q.all_needed, need: q.need ?? [],
    picked: slot.picked, items, chars, cids: [...cids],
    rawHit: judge(q, rawCids),
    slotHit: judge(q, cids),
    unionHit: judge(q, new Set([...rawCids, ...cids])),
    rawChars: (r?.raw ?? []).reduce((s, h) => s + (h.chars ?? 0), 0),
  });
}

const types = [...new Set(questions.map((q) => q.type))];
console.log('题型      n   触发   raw命中  槽位命中  raw∪槽位   增量   槽位条数/题');
for (const t of types) {
  const sub = rows.filter((r) => r.type === t);
  const trig = sub.filter((r) => r.picked).length;
  const rh = sub.filter((r) => r.rawHit).length;
  const sh = sub.filter((r) => r.slotHit).length;
  const un = sub.filter((r) => r.unionHit).length;
  const items = sub.reduce((s, r) => s + r.items, 0) / sub.length;
  console.log(`${t.padEnd(6, '　')} ${String(sub.length).padStart(4)}  ${String(trig).padStart(4)}   ${String(rh).padStart(4)}     ${String(sh).padStart(4)}     ${String(un).padStart(4)}    ${String(un - rh).padStart(3)}   ${items.toFixed(1).padStart(5)}`);
}
const tot = rows.length;
const rh = rows.filter((r) => r.rawHit).length;
const un = rows.filter((r) => r.unionHit).length;
console.log(`\n全量 ${tot}：raw ${rh} (${(rh / tot * 100).toFixed(1)}%) → raw∪槽位 ${un} (${(un / tot * 100).toFixed(1)}%)，+${un - rh} 题`);

const trig = rows.filter((r) => r.picked);
console.log(`\n触发槽位的 ${trig.length} 题：平均 ${(trig.reduce((s, r) => s + r.items, 0) / trig.length).toFixed(1)} 条断言 = ${Math.round(trig.reduce((s, r) => s + r.chars, 0) / trig.length)} 字`);
console.log(`未触发的 ${tot - trig.length} 题：材料量不变`);
console.log(`全量题均材料：raw ${Math.round(rows.reduce((s, r) => s + r.rawChars, 0) / tot)} 字 → raw+槽位 ${Math.round(rows.reduce((s, r) => s + r.rawChars + r.chars, 0) / tot)} 字`);
