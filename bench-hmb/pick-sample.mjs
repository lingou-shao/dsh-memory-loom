/**
 * 从全卷扫描的明细里挑一批题，只把「模型当时手上有什么」摊成纯文本。
 *
 * 答题样本必须看不见 rubric / evidence / answer-key，否则量的是抄答案。所以这个
 * 脚本只输出三样：题目、当天的日期、loom 交出来的东西（常驻块 + 搜索 + 展开）。
 *
 *   node pick-sample.mjs --tags 相对日期,时间题 --per 2
 */
import fs from 'node:fs';
import path from 'node:path';

const BENCH = process.env.HMB_DIR ?? 'C:/Users/shaoz/Desktop/chat-memory-bench';
const SRC = path.join(BENCH, process.env.HMB_IN ?? 'loom-surface.jsonl');
const OUT = path.join(BENCH, 'work', 'sample');

const argOf = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const TAGS = String(argOf('tags', '')).split(',').filter(Boolean);
const PER = Number(argOf('per', 2));
/**
 * 按题号点名重出样本。
 *
 * A/B 同一批题时不能再用 --tags 抽——抽法虽固定，但只要覆盖变了池子就变了，
 * 两次拿到的不是同一批题，比较就没有意义。点名出样保证逐题对齐。
 */
const IDS = String(argOf('ids', '')).split(',').filter(Boolean);

const rows = fs.readFileSync(SRC, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const usable = rows.filter((row) => (row.facts ?? []).length > 0 && row.context !== undefined);

const picked = [];
const seen = new Set();
const seenCase = new Set();
if (IDS.length > 0) {
  const byId = new Map(usable.map((row) => [row.id, row]));
  for (const id of IDS) {
    const row = byId.get(id);
    if (row === undefined) {
      console.error(`这批结果里没有 ${id}（题库有，但这个人物的时点没跑到）`);
      process.exit(1);
    }
    picked.push({ ...row, pickedFor: '点名' });
  }
} else
for (const tag of TAGS) {
  const pool = usable.filter((row) => (row.tags ?? []).includes(tag) && !seen.has(row.id));
  // 每个距离档各取 PER 道，取 id 最小的那些——挑法固定，不按「看起来能不能答对」挑。
  for (const days of [0, 3, 15, 45]) {
    const cell = pool.filter((row) => row.intervalDays === days).sort((a, b) => a.id.localeCompare(b.id));
    /*
     * 同一个 case 在四个距离档上问的是同一件事——四道一起收，等于把一个样本
     * 记四遍。所以先挑没出现过的 case，挑不到才退回按 id 取。
     */
    const fresh = cell.filter((row) => !seenCase.has(row.id.replace(/\/d\d+$/u, '')));
    const chosen = (fresh.length > 0 ? fresh : cell).slice(0, PER);
    for (const row of chosen) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      seenCase.add(row.id.replace(/\/d\d+$/u, ''));
      picked.push({ ...row, pickedFor: tag });
    }
  }
}

fs.mkdirSync(OUT, { recursive: true });
for (const file of fs.readdirSync(OUT)) if (file.endsWith('.md')) fs.unlinkSync(path.join(OUT, file));

const lines = [];
for (const [index, row] of picked.entries()) {
  const name = `${String(index + 1).padStart(2, '0')}-${row.id.replace(/[\/]/g, '_')}.md`;
  const body = [
    `# 第 ${index + 1} 题 · ${row.id}`,
    '',
    `今天是 ${row.now}（星期${'日一二三四五六'[new Date(row.now).getDay()]}）。你和这个人已经聊过 ${row.cutoffTurn} 轮。`,
    '',
    '## 用户此刻问',
    '',
    row.question,
    '',
    '## 每轮自动注入的记忆块',
    '',
    row.context.block.trim() || '（空）',
    '',
    '## 你自己调了一次 memory_search，拿回这些',
    '',
    row.context.search.trim() || '（空）',
    ''
  ];
  if ((row.context.expanded ?? []).length > 0) {
    body.push('## 你顺手展开了其中两条指针');
    body.push('');
    for (const one of row.context.expanded) {
      body.push(`### #${one.ref}`);
      body.push('');
      body.push(String(one.text ?? '').trim() || '（空）');
      body.push('');
    }
  }
  fs.writeFileSync(path.join(OUT, name), body.join('\n'), 'utf8');
  lines.push({ n: index + 1, file: name, id: row.id, tag: row.pickedFor, days: row.intervalDays });
}

fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ tags: TAGS, per: PER, items: lines }, null, 1) + '\n');
console.log(`挑了 ${lines.length} 题 → ${OUT}`);
for (const one of lines) console.log(`  ${String(one.n).padStart(2)}  ${one.id}  d${String(one.days).padStart(2, '0')}  ${one.tag}`);
