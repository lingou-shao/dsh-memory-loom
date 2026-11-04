/*
 * 槽位通道的离线天花板。
 *
 * 变更题的证据全在库里，缺的是「按 (主体, 属性) 枚举版本」这一步。
 * 这个脚本不从产品代码取数，只用已导出的单元文本，回答三个问题：
 *
 *   1. 规则能不能从事实文本里抽出 (subject, attr)？覆盖率多少？
 *   2. 问句里能不能不靠模型就认出 slot？认错多少？
 *   3. 按 slot 枚举全部版本，命中率与材料成本各是多少？
 *
 * 复跑：node bench-hmb/sem/eval-slot.mjs [--out bench-hmb/out/slot.json]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== void 0 ? process.argv[i + 1] : fallback;
};
const OUT = argOf('out', 'bench-hmb/out/slot.json');

const units = JSON.parse(readFileSync('bench-hmb/out/sem/units.json', 'utf8'));
const questions = JSON.parse(readFileSync('bench-hmb/out/sem/questions.json', 'utf8'));
const retrieval = JSON.parse(readFileSync('bench-hmb/out/retrieval_loom-epB.json', 'utf8'));
const cidmap = JSON.parse(readFileSync('bench-hmb/out/loom-epB.db.cidmap.json', 'utf8'));

/* 段落长度：用来算材料成本。一个 cid 的展开成本是它覆盖的 L0 段落字数。 */
const l0len = new Map();
for (const e of cidmap) {
  let max = 0;
  for (let i = e.from; i <= e.to; i++) max = Math.max(max, Number(e.l0len?.[String(i)] ?? 0));
  l0len.set(e.cid, max || 400);
}

/*
 * 句式骨架：{subject} 的{attr}<动词>{value}
 * 「的」在 attr 内部也会出现（「缓存模块 的有效期秒数」），所以先从左边取值：
 * subject 不允许包含「的」，attr 取到第一个动词短语为止。
 */
const SLOT = /([^\s。，、；]{1,10})\s+的([^\s。，、；]{2,10}?)(?:首次确立为|调整为|被撤销|此后确立为|出现两种|自第|改名为)/u;

/** @returns {{subject: string, attr: string} | null} */
function slotOf(text) {
  /* 事件文本前面挂着「第 10 章（青石镇）。：」这类索引前缀，不锚定行首。 */
  let m = SLOT.exec(String(text).trim());
  /* 事件前缀里也可能先撞上「第 10 章（青石镇）」之外的「的」，取最后一次机会。 */
  if (m === null) return null;
  const subject = m[1].trim();
  let attr = m[2].trim();
  /* 「猎户项目·缓存模块 的缓存模块 的有效期秒数」这类重复拼接，取最后一段属性名。 */
  const tail = attr.split(/\s*的\s*/u).pop();
  if (tail !== void 0 && tail.length >= 2) attr = tail;
  if (subject.length === 0 || attr.length === 0 || attr.length > 16) return null;
  return { subject, attr };
}

const factSlots = new Map();          // unit.id -> {subject, attr}
const slotUnits = new Map();          // "subject|attr" -> Set<cid>
const subjects = new Set();
const attrs = new Set();
let parsed = 0;
const parsedByKind = { fact: 0, event: 0 };
for (const u of units) {
  const s = slotOf(u.text);
  if (s === null) continue;
  parsed++;
  parsedByKind[u.kind] = (parsedByKind[u.kind] ?? 0) + 1;
  factSlots.set(u.id, s);
  subjects.add(s.subject);
  attrs.add(s.attr);
  const key = `${s.subject}|${s.attr}`;
  if (!slotUnits.has(key)) slotUnits.set(key, new Set());
  slotUnits.get(key).add(u.cid);
}
const factTotal = units.filter((u) => u.kind === 'fact').length;
const eventTotal = units.filter((u) => u.kind === 'event').length;

/* 问句侧：subject / attr 都是小集合，直接子串命中，不调模型。 */
const subjectList = [...subjects].sort((a, b) => b.length - a.length);
const attrList = [...attrs].sort((a, b) => b.length - a.length);

function matchSlots(question) {
  const q = String(question);
  const hitSubjects = subjectList.filter((s) => q.includes(s));
  const hitAttrs = attrList.filter((a) => q.includes(a));
  const picked = [];
  for (const s of hitSubjects) {
    for (const a of hitAttrs) {
      const key = `${s}|${a}`;
      if (slotUnits.has(key)) picked.push(key);
    }
  }
  /* attr 没认出来时退一步：该主体下的全部 slot。宁可多取，不要漏。 */
  if (picked.length === 0) {
    for (const s of hitSubjects) for (const key of slotUnits.keys()) if (key.startsWith(`${s}|`)) picked.push(key);
  }
  return { hitSubjects, hitAttrs, picked: [...new Set(picked)] };
}

const base = new Map(retrieval.rows.map((r) => [r.qid, r]));
const judged = (need, cids, allNeeded) => {
  if (need.length === 0) return false;
  return allNeeded ? need.every((n) => cids.has(n)) : need.some((n) => cids.has(n));
};

const rows = [];
for (const q of questions) {
  const { hitSubjects, hitAttrs, picked } = matchSlots(q.question);
  const cids = new Set();
  let chars = 0;
  for (const key of picked) for (const cid of slotUnits.get(key)) {
    cids.add(cid);
    chars += l0len.get(cid) ?? 400;
  }
  const r = base.get(q.qid);
  rows.push({
    qid: q.qid, type: q.type, question: q.question,
    subjects: hitSubjects, attrs: hitAttrs, slots: picked,
    cids: [...cids], chars,
    need: q.need, all_needed: q.all_needed,
    slotHit: judged(q.need, cids, q.all_needed),
    rawHit: judged(q.need, new Set((r?.raw ?? []).map((h) => h.cid)), q.all_needed),
  });
}

const types = [...new Set(questions.map((q) => q.type))];
console.log(`事实 ${factTotal} 条抽出 ${parsedByKind.fact ?? 0}｜事件 ${eventTotal} 条抽出 ${parsedByKind.event ?? 0}`);
console.log(`distinct subject ${subjects.size}｜distinct attr ${attrs.size}｜distinct slot ${slotUnits.size}\n`);

console.log('按题型（槽位通道单独使用）：');
console.log('  类型        n   槽位命中   现状 raw   平均 slot 数   平均字数');
for (const t of types) {
  const sub = rows.filter((r) => r.type === t);
  const sh = sub.filter((r) => r.slotHit).length;
  const rh = sub.filter((r) => r.rawHit).length;
  const ns = sub.reduce((s, r) => s + r.slots.length, 0) / sub.length;
  const ch = sub.reduce((s, r) => s + r.chars, 0) / sub.length;
  console.log(`  ${t.padEnd(8, '　')} ${String(sub.length).padStart(4)}   ${String(sh).padStart(4)}      ${String(rh).padStart(4)}      ${ns.toFixed(1).padStart(6)}     ${Math.round(ch).toString().padStart(6)}`);
}

const ch = rows.filter((r) => r.type === '变更');
console.log(`\n变更题 ${ch.length} 道逐题（slot 命中 / 选了几个 slot / 字数）：`);
for (const r of ch) {
  console.log(`  ${r.qid.slice(-8)} ${r.slotHit ? '✓' : '✗'}  slots=${r.slots.length}  ${Math.round(r.chars)} 字  ${r.subjects.length === 0 ? '【主体未认出】' : ''}${r.attrs.length === 0 ? '【属性未认出】' : ''}`);
}

writeFileSync(OUT, JSON.stringify({
  factTotal, parsed, subjects: [...subjects], attrs: [...attrs], slots: slotUnits.size,
  rows: rows.map((r) => ({ ...r, cids: r.cids })),
}, null, 1));
console.log(`\n写出 ${OUT}`);
