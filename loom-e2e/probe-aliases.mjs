/**
 * Do AI-written retrieval aliases actually widen recall — and do they leak into
 * an unrelated topic?
 *
 * Three arms over the *same* corpus:
 *   A  no aliases            (0.2.17 behaviour)
 *   B  aliases + relax guard counts the aliases (0.2.18)
 *   C  aliases, relaxMatch off — the strict pass only
 *
 * C matters because the obvious guess is "aliases make the AND easier". They do
 * not: the strict pass needs *every* bigram of the sentence, and three short
 * aliases cannot cover a spoken sentence. Without C, B's win gets attributed to
 * the aliases rather than to the guard change.
 *
 * Each target is asked three ways:
 *   terse    the alias verbatim — the strict pass can win this on its own
 *   covered  a sentence the aliases were written for, mostly disjoint from the
 *            stored wording — the strict pass cannot, the relax pass can
 *   open     a fourth phrasing nobody modelled — the honest ceiling
 *
 * The corpus is deliberately skewed towards the second kind. A fact written as
 * 「一直没跟家里说」 and asked about as 「还没跟我妈开口」 shares *zero* bigrams,
 * and that is the only place aliases are decisive: 0.2.17's relax pass already
 * covers the paraphrase that keeps two or three of the original words. The
 * printed overlap columns make that visible per question instead of asking the
 * reader to trust an aggregate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

const SESSION = 'probe-alias-session';

const TARGETS = [
  {
    marker: '辞职',
    text: '用户辞职后一直没跟家里说，怕父母担心',
    aliases: ['辞职', '没告诉爸妈', '瞒着我妈'],
    terse: '没告诉爸妈',
    covered: '瞒着我妈那事',
    open: '那件事还没跟我妈开口'
  },
  {
    marker: '像素地牢',
    text: '用户在做像素地牢的卡牌模式，已经写到第三版了',
    aliases: ['像素地牢', '卡牌游戏', '第三版'],
    terse: '卡牌游戏',
    covered: '那个卡牌游戏又改了一版',
    open: '游戏做到哪一步了'
  },
  {
    marker: '香菜',
    text: '用户对香菜过敏，点外卖要备注不要香菜',
    aliases: ['香菜', '过敏', '挑出来'],
    terse: '挑出来',
    covered: '菜里有香菜我得挑出来',
    open: '我不能吃那个东西'
  },
  {
    marker: '豆豆',
    text: '用户养了一只叫豆豆的橘猫，今年三岁',
    aliases: ['豆豆', '那只橘猫', '铲屎官'],
    terse: '铲屎官',
    covered: '铲屎官说豆豆胖了',
    open: '我家猫几岁了'
  },
  {
    marker: '杭州',
    text: '用户在杭州做过网店运营，认识不少供货的人',
    aliases: ['杭州', '开网店', '卖货'],
    terse: '卖货',
    covered: '开网店卖货那阵子',
    open: '我上一份工作在哪'
  },
  {
    marker: '奶奶',
    text: '用户的奶奶住在绍兴，每年过年回去看她',
    aliases: ['奶奶', '绍兴', '回老家'],
    terse: '回老家',
    covered: '回老家看老人',
    open: '家里老人身体还好吗'
  }
];

/**
 * 24 fillers, so the cold-start `recentFacts(8)` channel cannot answer for the targets.
 *
 * The last eight carry aliases of their own: in production *every* fact gets
 * them, and those eight are exactly what fills the block when the topic
 * changes. Testing the leak with alias-free fillers would have been a free win.
 */
const DISTRACTORS = [
  '用户参加过一次数学建模比赛，拿了省二等奖',
  '用户在为考研做准备，专业课选了数据结构',
  '用户家里有一台半自动咖啡机，喜欢浅烘豆子',
  '用户的键盘换了静音轴体，办公室不吵了',
  '用户学过两年吉他，只会弹几首民谣',
  '用户喜欢拍胶片，手上有台奥林巴斯',
  '用户每周跑三次五公里，配速六分左右',
  '用户去年瘦了八公斤，靠控制晚饭',
  '用户租的房子在地铁终点站，通勤四十分钟',
  '用户的房东不肯换热水器，冬天很难受',
  '用户考过六级，听力分数一般',
  '用户的论文查重率降到了百分之八',
  '用户想换一台二十七寸的显示器',
  '用户的降噪耳机左耳有点接触不良',
  '用户收藏了一块机械表，舍不得日常戴',
  '用户的移动硬盘里有十几年的照片备份',
  ['用户家的路由器放在客厅角落，卧室信号差', ['路由器', '信号差', '断网']],
  ['用户的洗衣机甩干时有异响，打算报修', ['洗衣机', '异响', '报修']],
  ['用户习惯把包裹放在楼下驿站，懒得送上楼', ['包裹', '驿站', '取件']],
  ['用户办过一张储蓄卡，专门用来存旅行基金', ['储蓄卡', '存钱', '旅行基金']],
  ['用户的医保卡绑在了手机小程序上', ['医保卡', '小程序', '看病']],
  ['用户的身份证快到期了，得回户籍地换', ['身份证', '到期', '换证']],
  ['用户不喜欢吃甜的，奶茶永远点无糖', ['奶茶', '无糖', '甜']],
  ['用户睡觉前一定要把手机调成飞行模式', ['飞行模式', '睡前', '手机']]
].map((entry) => Array.isArray(entry) ? { text: entry[0], aliases: entry[1] } : { text: entry, aliases: [] });

/** Unrelated turns. None of them names a target, so any target here is a leak. */
const OFF_TOPIC = [
  '今天天气挺好的，出去走走',
  '帮我把这段代码格式化一下',
  '这个周末有什么好看的电影吗',
  '你能帮我翻译一段英文吗',
  '电脑突然很卡怎么办',
  '讲个笑话吧',
  '最近有点累，想休息几天',
  '这个项目什么时候能结束'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Bigram set, mirroring the plugin's index tokenisation closely enough to report overlap. */
function bigrams(text) {
  const set = new Set();
  for (const run of text.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = [...run[0]];
    for (let index = 0; index < chars.length - 1; index++) set.add(`${chars[index]}${chars[index + 1]}`);
  }
  return set;
}

/** Share of the query's bigrams present in `haystack`. */
function overlap(query, haystack) {
  const need = bigrams(query);
  if (need.size === 0) return 0;
  const have = bigrams(haystack);
  let shared = 0;
  for (const token of need) if (have.has(token)) shared++;
  return shared / need.size;
}

function countLines(block) {
  return block.split('\n').filter((line) => line.startsWith('- ')).length;
}

async function runArm(mode) {
  const dir = mkdtempSync(join(tmpdir(), `loom-alias-${mode}-`));
  const loom = createLoom({
    dbPath: join(dir, 'loom.db'),
    // Consolidation off: the probe writes by hand, and a background run would
    // fold the probe's own questions into new facts.
    config: {
      consolidation: { enabled: false },
      retrieval: mode === 'strict' ? { relaxMatch: false } : {}
    }
  });

  try {
    for (const target of TARGETS) {
      await loom.call('memory_write', {
        text: target.text,
        ...(mode === 'none' ? {} : { aliases: target.aliases })
      }, SESSION);
      await sleep(3);
    }
    for (const filler of DISTRACTORS) {
      await loom.call('memory_write', {
        text: filler.text,
        ...(mode === 'none' || filler.aliases.length === 0 ? {} : { aliases: filler.aliases })
      }, SESSION);
      await sleep(3);
    }

    const rows = [];
    for (const target of TARGETS) {
      for (const kind of ['terse', 'covered', 'open']) {
        await loom.turn(SESSION, target[kind], '好。');
        const block = loom.memoryBlock(SESSION);
        rows.push({ marker: target.marker, kind, hit: block.includes(target.marker), items: countLines(block) });
      }
    }

    const offTopic = [];
    for (const question of OFF_TOPIC) {
      await loom.turn(SESSION, question, '好。');
      const block = loom.memoryBlock(SESSION);
      offTopic.push({
        question,
        leaked: TARGETS.filter((target) => block.includes(target.marker)).map((target) => target.marker),
        items: countLines(block)
      });
    }
    return { rows, offTopic };
  } finally {
    loom.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

const rate = (rows, kind) => {
  const picked = rows.filter((row) => row.kind === kind);
  return { hits: picked.filter((row) => row.hit).length, total: picked.length };
};

const ARMS = [
  ['A 无别名', 'none', 'A'],
  ['B 别名+放宽', 'relax', 'B'],
  ['C 别名+仅严格', 'strict', 'C']
];
const results = new Map();
for (const [label, mode] of ARMS) results.set(label, await runArm(mode));
const cell = (label, marker, kind) => {
  const row = results.get(label).rows.find((entry) => entry.marker === marker && entry.kind === kind);
  return row.hit ? '·' : '×';
};

console.log('[1] 同一批 6 条记忆、24 条干扰项，三种问法下的命中\n');
console.log('                 A 无别名   B 别名+放宽   C 别名+仅严格');
for (const kind of ['terse', 'covered', 'open']) {
  const line = ARMS.map(([label]) => {
    const { hits, total } = rate(results.get(label).rows, kind);
    return `${String(hits)}/${String(total)}`.padStart(8);
  });
  const name = { terse: '原始说法（别名原文）', covered: '换说法（别名覆盖）', open: '第四种说法（没覆盖）' }[kind];
  console.log(`  ${name.padEnd(22)}${line.map((part) => part.padStart(12)).join('')}`);
}

console.log('\n[2] 逐题：为什么命中 / 为什么漏（重合 = 问题二字组被该栏目覆盖的比例）\n');
console.log('  记忆      问法     问题                  与原文   与别名    A  B  C');
for (const target of TARGETS) {
  for (const kind of ['terse', 'covered', 'open']) {
    const question = target[kind];
    const textOverlap = (overlap(question, target.text) * 100).toFixed(0);
    const aliasOverlap = (overlap(question, `${target.text} ${target.aliases.join(' ')}`) * 100).toFixed(0);
    const pads = (text, width) => text + ' '.repeat(Math.max(0, width - [...text].length));
    const marks = ARMS.map(([label]) => cell(label, target.marker, kind)).join('  ');
    console.log(
      `  ${pads(target.marker, 8)}  ${pads(kind, 7)}  ${pads(question, 20)}  ${textOverlap.padStart(5)}%  ${aliasOverlap.padStart(5)}%    ${marks}`
    );
  }
}

console.log('\n[3] 换话题：块里被拖进来的旧记忆\n');
for (const { question, leaked, items } of results.get('B 别名+放宽').offTopic) {
  console.log(`  ${question.padEnd(18)} 块内 ${String(items).padStart(2)} 条   旧记忆漏出 ${leaked.length === 0 ? '无' : leaked.join('、')}`);
}
const average = ARMS.map(([label]) => {
  const rows = results.get(label).offTopic;
  return [label, (rows.reduce((sum, row) => sum + row.items, 0) / rows.length).toFixed(1)];
});
console.log(`\n  换话题时平均块大小：${average.map(([label, size]) => `${label} ${size} 条`).join(' · ')}`);

console.log('\n[4] 模型写坏别名时会不会被挡住（端到端，走 memory_search）\n');
const guardDir = mkdtempSync(join(tmpdir(), 'loom-alias-guard-'));
const guard = createLoom({ dbPath: join(guardDir, 'loom.db'), config: { consolidation: { enabled: false } } });
let guardOk = true;
try {
  await guard.call('memory_write', {
    text: '用户对香菜过敏，点外卖要备注不要香菜',
    aliases: ['工作', '这是一句明显超过六个字的长句子', '香菜', '香菜']
  }, SESSION);
  await sleep(3);
  await guard.call('memory_write', { text: '用户周末去爬了香山，拍了不少照片' }, SESSION);
  await sleep(3);
  const clean = await guard.call('memory_search', { query: '香菜' }, SESSION);
  const generic = await guard.call('memory_search', { query: '工作今天' }, SESSION);
  console.log(`  泛词「工作」：${generic.includes('香菜过敏') ? '× 仍然命中（漏网）' : '· 已丢弃，没有把过敏那条拖出来'}`);
  console.log(`  超过 6 字的句子：${clean.includes('香菜过敏') ? '· 已丢弃，合法的「香菜」仍然生效' : '× 连合法别名一起丢了'}`);
  guardOk = clean.includes('香菜过敏') && !generic.includes('香菜过敏');
} finally {
  guard.dispose();
  rmSync(guardDir, { recursive: true, force: true });
}

const terseA = rate(results.get('A 无别名').rows, 'terse');
const terseB = rate(results.get('B 别名+放宽').rows, 'terse');
const terseC = rate(results.get('C 别名+仅严格').rows, 'terse');
const coveredA = rate(results.get('A 无别名').rows, 'covered');
const coveredB = rate(results.get('B 别名+放宽').rows, 'covered');
const coveredC = rate(results.get('C 别名+仅严格').rows, 'covered');
const openB = rate(results.get('B 别名+放宽').rows, 'open');
const leak = (label) => results.get(label).offTopic.reduce((sum, row) => sum + row.leaked.length, 0);

console.log('\n[5] 结论\n');
const checks = [
  ['换说法时，别名把召回从零拉到多数', coveredA.hits === 0 && coveredB.hits >= 4, `A ${coveredA.hits}/6 → B ${coveredB.hits}/6`],
  ['只开严格匹配时，别名救不了句子', coveredC.hits === 0, `C ${coveredC.hits}/6`],
  ['别名原文这种短问法，严格匹配也够', terseB.hits === terseC.hits && terseC.hits >= 5, `B ${terseB.hits}/6 · C ${terseC.hits}/6`],
  ['没被覆盖的第四种说法仍然漏（这是天花板）', openB.hits <= 1, `${openB.hits}/6`],
  ['换话题不把旧记忆拖进来', leak('A 无别名') === 0 && leak('B 别名+放宽') === 0, `A ${leak('A 无别名')} 条 · B ${leak('B 别名+放宽')} 条`],
  ['坏别名被清洗掉', guardOk === true, guardOk ? '泛词/超长都被丢' : '清洗失效']
];
let failed = 0;
for (const [label, ok, detail] of checks) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label} — ${detail}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
