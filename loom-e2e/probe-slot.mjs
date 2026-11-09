/**
 * probe-slot.mjs — 属性槽位：(主体, 属性, 值) 三列，值链，改名闭包，嵌套隔离
 *
 * 为什么值得一个探针：一条事实能被找到靠的是共享字面，而「改过几次」「谁现在
 * 在哪」这类问题要的不是某一句，是一串。串在库里原本不存在，有两个原因，这个
 * 探针各盯一个：
 *
 *   1. 抽取口径漏了三种值动词。它不报错，只是那句话没有行——「确立为」「转为」
 *      「被撤销」「移到了」「并存」全部不进库，此后任何检索都取不到。
 *   2. 判定把「换了值」当成「说得更准」。judge 比的是措辞，而一次取值变更前后
 *      只差一个 token，于是判成 update，updateFactText 把旧行整行改写——库里
 *      只剩当前值，没有「变过」这件事。
 *
 * 断言：
 *   1. 四种句式都抽出来了，且 subject / attr / value 三列都对；
 *   2. 换过值的槽位留成一条链：旧行 superseded，新行 active；
 *   3. 槽位通道：问「改过几次」能把整条链取回来（FTS 只取回最新那条）；
 *   4. 改名闭包：用新名字问，能取到改名前写下的那一条；
 *   5. 嵌套隔离：问缓存模块，不把项目自己的值一起端出来；
 *   6. 不触发：问一个没有槽位的对象，不会顺带捞回槽位事实；
 *   7. 对照：关掉 slotMax 之后第 4 条取不到，证明差异来自这个通道；
 *   8. schema：库版本升到 6（v6 是原话索引，槽位列是 v5 给的），三列存在，旧库能原地打开；
 *   9. 记忆块：旧值那一行带「旧值」标记，不被读成现在生效的那个。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-slot-'));
const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);
const textOf = (value) => (typeof value === 'string' ? value : String(value?.content?.[0]?.text ?? value));
const refsOf = (reply) => [...textOf(reply).matchAll(/#F(\d+)/gu)].map((m) => Number(m[1]));

const CONFIG = { timezone: 'Asia/Shanghai', consolidation: { triggerTokens: 1, idleMinutes: 0 } };

/** 一段「项目属性 + 人物位置 + 改名 + 无关事实」的小语料，顺序即时间顺序。 */
const TURNS = [
  '猎户项目 的依赖名首次确立为 redis',
  '猎户项目 的依赖名调整为 lmdb',
  '猎户项目 的依赖名被撤销',
  '猎户项目 的有效期秒数首次确立为 600',
  '猎户项目·缓存模块 的有效期秒数首次确立为 10800',
  '满儿 移到了 码头',
  '满儿 自第 2 章起改名为 周舟',
  '用户养了一只叫年糕的橘猫，今年三岁',
];

const dbPath = join(root, 'loom.db');
const loom = createLoom({ dbPath, config: CONFIG });
for (const turn of TURNS) {
  await loom.turn('s-slot', turn, '嗯。');
  await loom.settle(8);
}

// ---- 1/2. 抽取与链 -----------------------------------------------------
console.log('[1] 规则路径把四种句式抽成槽位');
const db = new DatabaseSync(dbPath);
const rows = db.prepare('SELECT id, subject, attr, value, status, text FROM facts ORDER BY id').all();
const slots = rows.filter((row) => String(row.subject).length > 0);
for (const row of slots) console.log(`    ${row.subject} · ${row.attr} = ${row.value ?? '∅'}  [${row.status}]`);

const dep = rows.filter((row) => row.attr === '依赖名');
check('「首次确立为 / 调整为 / 被撤销」各留一行', dep.length === 3, `实际 ${dep.length} 行`);
check('subject 都读成「猎户项目」', dep.every((row) => row.subject === '猎户项目'), dep.map((row) => row.subject).join('/'));
check('value 依次是 redis / lmdb / null', JSON.stringify(dep.map((row) => row.value)) === JSON.stringify(['redis', 'lmdb', null]), JSON.stringify(dep.map((row) => row.value)));
const module = rows.find((row) => row.subject === '猎户项目·缓存模块');
check('嵌套主体保留全名', module !== undefined && module.attr === '有效期秒数' && module.value === '10800', JSON.stringify(module ?? {}));
const moved = rows.find((row) => row.attr === '位置');
check('「移到了」补出隐含属性「位置」', moved !== undefined && moved.subject === '满儿' && moved.value === '码头', JSON.stringify(moved ?? {}));
const renamed = rows.find((row) => row.attr === '名称');
check('「改名为」记成 名称 / 旧名 / 新名', renamed !== undefined && renamed.subject === '满儿' && renamed.value === '周舟', JSON.stringify(renamed ?? {}));

console.log('\n[2] 换过值的槽位留成一条链');
check('旧的两行标 superseded', dep.filter((row) => row.status === 'superseded').length === 2, dep.map((row) => row.status).join('/'));
check('最新的那行是 active', dep.at(-1).status === 'active', dep.at(-1).status);
const cyc = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE attr = '有效期秒数'").get();
check('同一属性在两个主体上各留一行（嵌套没有互相吞掉）', Number(cyc.n) === 2, `${cyc.n} 行`);

// ---- 3. 槽位通道 -------------------------------------------------------
const chain = refsOf(await loom.call('memory_search', { query: '猎户项目 的依赖名改过哪几次', limit: 20 }, 's-slot'));
const chainFacts = chain.filter((id) => dep.some((row) => Number(row.id) === id));
check('问「改过几次」取回整条链', chainFacts.length === 3, `${chainFacts.length}/3：${chainFacts.join(',')}`);

// ---- 4. 改名闭包 -------------------------------------------------------
const closure = refsOf(await loom.call('memory_search', { query: '周舟 现在在什么位置', limit: 20 }, 's-slot'));
check('用新名字问，取到改名前那条「满儿 移到了 码头」', closure.includes(Number(moved.id)), `返回 ${closure.join(',')}，要 ${moved.id}`);

// ---- 5. 嵌套隔离 -------------------------------------------------------
/*
 * 隔离在这里只能是「排序」而不是「不出现」。放宽那一遍（OR）本来就会把项目
 * 自己那条 600 捞回来——两句共享「有效期秒数」和「猎户项目」，那是 bm25 的
 * 判断，不是槽位的。槽位能保证的是：被问的那个模块排在前面，项目那条在后。
 */
const nested = refsOf(await loom.call('memory_search', { query: '猎户项目·缓存模块 的有效期秒数是多少', limit: 20 }, 's-slot'));
const parentRow = rows.find((row) => row.subject === '猎户项目' && row.attr === '有效期秒数');
check('问到缓存模块的那一条', nested.includes(Number(module.id)), nested.join(','));
check('项目自己那条排在它后面（嵌套不互相吞掉）', nested.indexOf(Number(module.id)) < nested.indexOf(Number(parentRow.id)) || !nested.includes(Number(parentRow.id)), `${nested.join(',')}｜项目=${parentRow.id}`);

// ---- 6. 不触发 ---------------------------------------------------------
const cat = refsOf(await loom.call('memory_search', { query: '年糕 那只猫几岁了', limit: 20 }, 's-slot'));
check('没有槽位的对象不会顺带捞回槽位事实', cat.every((id) => !slots.some((row) => Number(row.id) === id)), cat.join(','));

// ---- 7. 记忆块里的旧值标记 --------------------------------------------
console.log('\n[3] 记忆块');
/*
 * 记忆块只在「这一轮的问句自己点了名」时才带上链，所以要先问一句。问句本身
 * 不是事实（不含任何值动词），不会污染库。
 */
await loom.turn('s-slot', '猎户项目 的依赖名改过哪几次', '我看看。');
await loom.settle(8);
const block = loom.memoryBlock('s-slot');
const marked = block.split('\n').find((line) => line.includes('旧值'));
check('旧值那一行带「旧值」标记', marked !== undefined, block.split('\n').filter((line) => line.startsWith('- ')).slice(0, 5).join(' | '));

// ---- 8. 对照：关掉通道 -------------------------------------------------
loom.dispose();
const reuse = createLoom({ dbPath, config: { ...CONFIG, retrieval: { slotMax: 0 } } });
const closureOff = refsOf(await reuse.call('memory_search', { query: '周舟 现在在什么位置', limit: 20 }, 's-slot'));
reuse.dispose();
check('关掉通道后同一个问题取不到那条', !closureOff.includes(Number(moved.id)), `仍然返回 ${closureOff.join(',')}`);

// ---- 9. schema ---------------------------------------------------------
const version = Number(db.prepare('PRAGMA user_version').get().user_version);
// 6 是槽位列落地的版本；之后的迁移只会往上加，不该让这条断言每版重写一次。
check('库版本至少 6', version >= 6, `user_version=${version}`);
const columns = db.prepare('PRAGMA table_info(facts)').all().map((row) => String(row.name));
check('三列都在', ['subject', 'attr', 'value'].every((name) => columns.includes(name)), columns.join(','));
const index = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'facts_slot'").get();
check('facts_slot 索引建了', index !== undefined, '没有建');
db.close();

// ---- 汇总 --------------------------------------------------------------
let pass = 0;
let fail = 0;
console.log('');
for (const [label, ok, detail] of results) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`);
  }
}
console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 项通过，${fail} 项失败`);
rmSync(root, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
