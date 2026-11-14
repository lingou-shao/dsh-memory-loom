/**
 * 改口闸（R4）的输入在我们这里**不存在**——把这件事钉成断言（§115.2）。
 *
 * 外部那份设计的 R4 是「`superseded && !historical → 拒`」。它成立的前提是：旧值是一条
 * **带状态的派生行**，而检索通道仍会把它当候选。这个前提在我们这里不成立，两处都量过：
 *
 *   1. 词法通道 `searchFacts` 默认只收 `status IN ('active','disputed')`，
 *      被取代的行**根本进不来**；只有 `slotFacts`（「这个槽位改过几次」）故意收历史。
 *   2. 用户实际看到的「旧值」不是 fact 行，是**事件摘要和原话**——它们没有状态可判。
 *      问「我那只猫叫什么」，答案里混进来的旧值是「去年那只叫栗子」那一轮原话，
 *      不是一条 superseded 事实。
 *
 * 所以把 R4 抄过来会是死代码：它的判据能命中 46 条事实（M01 3 / M02 43，§113.5），
 * 而那 46 条本来就不在候选池里。真正该修的是**链的形成**（同一属性两个值得连起来），
 * 那是另一件事，改的是写侧。
 *
 * 这个探针钉的是「现状是对的」，防止下一轮有人照着 R4 加一道硬闸，把「改过几次」
 * 这条链一起拒掉。
 *
 *   node loom-e2e/probe-superseded.mjs
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, DAY } from './harness.mjs';

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
	if (ok) pass += 1;
	else fail += 1;
	console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const BASE = Date.parse('2026-05-01T10:00:00+08:00');
const dir = mkdtempSync(join(tmpdir(), 'loom-sup-'));
const dbPath = join(dir, 'loom.db');
const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 } } });
const sid = 'sup';

await loom.turn(sid, '我的自行车是捷安特的，蓝色的，骑了三年。', '好。', { at: BASE });
await loom.turn(sid, '自行车换成美利达了，深灰的，捷安特卖了。', '换了。', { at: BASE + DAY });
await loom.turn(sid, '今天加班到九点，路上买了盒酸奶。', '早点睡。', { at: BASE + 2 * DAY });
await loom.ready?.();

/*
 * 造一对「旧值 / 新值」：两条都走产品的写入口（`memory_write`），再用一条 UPDATE 把旧值
 * 标成 superseded。规则路径的判官不会自己连这条链（§113.5：M01 只建了 3 条），所以这一步
 * 必须手动做——判的是**通道**，不是链。
 */
await loom.call('memory_write', { text: '我的自行车是美利达，深灰色，二〇二六年五月换的。' }, sid);
await loom.call('memory_write', { text: '我的自行车是捷安特，蓝色。' }, sid);
const db = new DatabaseSync(dbPath);
const newer = db.prepare("SELECT id FROM facts WHERE text LIKE '%美利达%' ORDER BY id DESC LIMIT 1").get();
const older = db.prepare("SELECT id FROM facts WHERE text LIKE '%捷安特，蓝色%' ORDER BY id DESC LIMIT 1").get();
db.prepare("UPDATE facts SET status = 'superseded', superseded_by = ? WHERE id = ?").run(newer.id, older.id);
const oldId = older.id;
const counts = db.prepare('SELECT status, COUNT(*) AS n FROM facts GROUP BY status').all();
const slots = db.prepare("SELECT COUNT(*) AS n FROM facts WHERE subject <> '' AND attr <> ''").get().n;
db.close();

/* ── 1. 被取代的行进不了词法通道 ───────────────────────────────── */
console.log('\n[1] 被取代的事实不进检索结果（词法通道默认只收 active / disputed）');
const wide = String(await loom.call('memory_search', { query: '我那辆自行车是什么牌子的？', limit: 10 }, sid));
check('结果里有新值', wide.includes('美利达'), wide.split('\n').slice(1, 3).join(' ').slice(0, 120));
check('没有那条 superseded 事实（它的原话是「我的自行车是捷安特，蓝色。」）', !wide.includes('我的自行车是捷安特，蓝色。'), `旧值 id=${oldId}`);

/* ── 2. 它还在库里 ─────────────────────────────────────────────── */
console.log('\n[2] 降级不是删除');
check('库里仍有 superseded 行', counts.some((one) => one.status === 'superseded' && one.n >= 1), JSON.stringify(counts.map((one) => `${one.status}:${one.n}`)));

/* ── 3. 原话那一轮照旧能查到 ───────────────────────────────────── */
console.log('\n[3] 原话通道照旧：旧说法是**记录**，不是取值');
const raw = String(await loom.call('memory_search', { query: '我以前那辆自行车多少钱买的？', limit: 10 }, sid));
check('旧说法仍然在结果里（#L 原话或事件）', raw.includes('捷安特'), raw.split('\n').slice(1, 3).join(' ').slice(0, 140));

/* ── 4. 槽位链在这类库上等于关闭 ──────────────────────────────── */
console.log('\n[4] 「改过几次」那条链需要槽位，规则路径的库里没有');
check('没有一行同时带 subject 与 attr', slots === 0, `slot 行 ${slots} 条`);
check('所以 R4 的判据没有输入（判据能命中的行本来就不在池子里）', slots === 0 && counts.some((one) => one.status === 'superseded'));

/* ── 5. 反例：问酸奶不会被自行车的事污染 ──────────────────────── */
console.log('\n[5] 反例：问酸奶，两代自行车都不出现');
const other = String(await loom.call('memory_search', { query: '我昨天买了什么喝的？', limit: 10 }, sid));
check('没有捷安特也没有美利达', !other.includes('捷安特') && !other.includes('美利达'), other.split('\n').slice(0, 3).join(' ').slice(0, 120));

loom.dispose();

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
