/*
 * 抽取层的天花板：把语料里的属性断言全部结构化，再按槽位枚举。
 *
 * 这一步不从 loom 库里取数，直接从题库原文抽 (subject, attr, value)，
 * 回答一个问题：变更题的失败，有多少是「抽取没抽到」，有多少是
 * 「抽到了但检索不到」。
 *
 * 只用规则：主语与属性之间的空格、属性词、六个动词。没有模型。
 *
 * 复跑：node bench-hmb/sem/eval-assertion.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const corpus = JSON.parse(readFileSync('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main/chain/corpus/corpus.json', 'utf8'));
const keys = JSON.parse(readFileSync('C:/Users/shaoz/Documents/GitHub/hive-memory-bench-main/chain/keys/keys.json', 'utf8'));

/* 语料里只有「移到」隐含属性名（位置），其余都显式写着。 */
const PATTERNS = [
  { re: /([^\s。，；]{1,20})\s*的([^\s。，；]{2,12}?)(调整为|首次确立为|此后确立为|转为)\s*([^，。；]*?)(?:，|。|$)/gu, attr: (m) => m[2], value: (m) => m[4] },
  { re: /([^\s。，；]{1,20})\s*的([^\s。，；]{2,12}?)被撤销/gu, attr: (m) => m[2], value: () => null },
  { re: /([^\s。，；]{1,20})\s*的([^\s。，；]{2,12}?)出现两种并存的取值[：:]\s*([^，。；]*)/gu, attr: (m) => m[2], value: (m) => m[3] },
  { re: /([^\s。，；]{1,20})\s*移到了\s*([^，。；]*)/gu, attr: () => '位置', value: (m) => m[2] },
];
const RENAME = /([^\s。，；]{1,10})\s+自第\s*\d+\s*[章次][^。]*?改名为\s*([^\s。，；]{1,10})/gu;

const assertions = [];
const renames = [];
for (const doc of corpus) {
  for (const m of doc.text.matchAll(RENAME)) renames.push({ from: m[1], to: m[2], cid: doc.cid });
  for (const p of PATTERNS) {
    for (const m of doc.text.matchAll(p.re)) {
      let subject = m[1].trim();
      let attr = p.attr(m).trim();
      /* 「猎户项目·缓存模块的缓存模块 的有效期秒数」这类拼接，取最后一段。 */
      subject = subject.split(/的|·的/u).pop() ?? subject;
      attr = attr.split(/\s*的\s*/u).pop() ?? attr;
      if (subject.length === 0 || attr.length === 0) continue;
      assertions.push({ subject, attr, value: p.value(m)?.trim() ?? null, cid: doc.cid });
    }
  }
}
const attrCount = new Map();
for (const a of assertions) attrCount.set(a.attr, (attrCount.get(a.attr) ?? 0) + 1);

/* 名字闭包：改名前后的两个名字指同一个人。 */
const groups = new Map();
for (const name of new Set([...assertions.map((a) => a.subject), ...renames.flatMap((r) => [r.from, r.to])])) groups.set(name, new Set([name]));
for (const r of renames) {
  const a = groups.get(r.from) ?? new Set([r.from]);
  const b = groups.get(r.to) ?? new Set([r.to]);
  const merged = new Set([...a, ...b]);
  for (const n of merged) groups.set(n, merged);
}

const slotCids = new Map();   // "subject|attr" -> Set<cid>
for (const a of assertions) {
  const key = `${a.subject}|${a.attr}`;
  if (!slotCids.has(key)) slotCids.set(key, new Set());
  slotCids.get(key).add(a.cid);
}
/* 同一实体的全部名字共享槽位：把闭包里每个名字的 slot 合并。 */
for (const [, names] of groups) {
  const attrs = new Set();
  for (const n of names) for (const key of slotCids.keys()) if (key.startsWith(`${n}|`)) attrs.add(key.split('|')[1]);
  for (const n of names) for (const a of attrs) {
    const set = new Set();
    for (const other of names) for (const cid of slotCids.get(`${other}|${a}`) ?? []) set.add(cid);
    slotCids.set(`${n}|${a}`, set);
  }
}

/* 嵌套主体：A·B 的槽位不应被 A 的槽位吞掉，枚举时按主体前缀过滤。 */
function cidsFor(subject, attr) {
  const direct = slotCids.get(`${subject}|${attr}`);
  if (direct !== void 0) return direct;
  const set = new Set();
  for (const [key, cids] of slotCids) {
    const [s, a] = key.split('|');
    if (a === attr && (s.startsWith(`${subject}·`) || subject.startsWith(`${s}·`))) for (const c of cids) set.add(c);
  }
  return set;
}

const ch = keys.filter((q) => q.type === '变更' && !q.reconstructible && !q.ambiguous);
const rows = [];
for (const q of ch) {
  const need = q.answer.change_chain.map((c) => `${q.doc}#${c.seq}`);
  const cids = cidsFor(q.subject, q.slot);
  const hit = need.filter((n) => cids.has(n));
  rows.push({ qid: q.qid, interference: q.interference, subject: q.subject, slot: q.slot, need: need.length, hit: hit.length, full: hit.length === need.length, picked: cids.size });
}

console.log(`属性断言 ${assertions.length} 条，distinct 属性 ${attrCount.size}，改名 ${renames.length} 条`);
console.log('属性分布：', [...attrCount].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '));

console.log('\n按干扰类型：');
console.log('  类型        n   全中   seq 覆盖   平均枚举段数');
const byType = new Map();
for (const r of rows) {
  if (!byType.has(r.interference)) byType.set(r.interference, []);
  byType.get(r.interference).push(r);
}
for (const [k, list] of byType) {
  const n = list.length;
  const full = list.filter((r) => r.full).length;
  const cov = list.reduce((s, r) => s + r.hit, 0) / list.reduce((s, r) => s + r.need, 0);
  const avg = list.reduce((s, r) => s + r.picked, 0) / n;
  console.log(`  ${k.padEnd(8, '　')} ${String(n).padStart(4)}  ${String(full).padStart(3)}/${n}  ${(cov * 100).toFixed(1).padStart(6)}%   ${avg.toFixed(1)}`);
}
const fullAll = rows.filter((r) => r.full).length;
const covAll = rows.reduce((s, r) => s + r.hit, 0) / rows.reduce((s, r) => s + r.need, 0);
console.log(`\n合计：全中 ${fullAll}/${rows.length}，seq 覆盖 ${(covAll * 100).toFixed(1)}%`);

console.log('\n未全中：');
for (const r of rows.filter((x) => !x.full)) console.log(`  ${r.qid.slice(-8)} ${r.interference} ${r.subject}·${r.slot} ${r.hit}/${r.need} 枚举${r.picked}段`);

writeFileSync('bench-hmb/out/assertion.json', JSON.stringify({ assertions, renames, rows }, null, 1));
console.log('\n写出 bench-hmb/out/assertion.json');
