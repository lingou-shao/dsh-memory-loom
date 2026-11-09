/**
 * 双时间轴：一句话说的那件事，发生在哪一天。
 *
 * 行首的日期是「他哪天说的」（transaction time），原话里的「明天/昨天」是
 * 「事情哪天发生的」（valid time）。两者不同的时候，同一个事件会散成好几句，
 * 而字面上它们几乎不相交：
 *
 *   t1  04-01「明天还得陪我爸去社区医院开药，他嫌排队」
 *   t3  04-02「今天陪我爸去社区医院，排队排了快一个钟头」
 *
 * 两句说的是同一件事，选点却按 bm25 排——计划句更短，常把结果句挤掉，于是
 * 「排队排了多久」这道题拿到的是「他嫌排队」。这里测三件事：
 *
 *   1. 事件日算得出来，并且写在结果的方括号里（引号内仍是逐字原话）；
 *   2. 同一个事件的两句话合成**一个**指针，区间覆盖两轮——不是告诉模型
 *      「你少了一半」，是把另一半并进同一段；
 *   3. 算不出（「上次」）或不成立（「后天免疫」）时一个字都不加。
 *
 *   node probe-event-day.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const DAY = 864e5;
const BASE = Date.parse('2026-04-01T21:00:00+08:00');

function boot(session) {
  const dir = mkdtempSync(join(tmpdir(), `loom-event-day-${session}-`));
  const dbPath = join(dir, 'loom.db');
  /*
   * `relaxBelow: 9` 是为了把原话通道逼出来：这个探针要看的是「原话那一条
   * 指针给了谁」，不是派生层能不能先答上。派生层一旦严格命中够多，原话通道
   * 根本不会跑，测的就不是这段逻辑了。
   */
  const loom = createLoom({ dbPath, config: { consolidation: { triggerTokens: 0 }, retrieval: { relaxBelow: 9 } } });
  return {
    loom,
    dbPath,
    done() {
      loom.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 把派生层清空，模拟「抽取器没抓住这段」。
 *
 * 原话通道是派生层的兜底：派生层已经抓住的那一轮，原话那一条会被判重跳过
 * （同一个 `#L` 不占两个名额）。这两句话在规则路径上会被抽成 event，于是
 * 通道根本不跑——探针要测的是通道自己，所以先把上层的读数清掉。
 */
function wipeDerived(dbPath) {
  const db = new DatabaseSync(dbPath);
  db.exec('DELETE FROM events');
  db.exec('DELETE FROM facts');
  db.close();
}

/** 某一轮在 l0 里的 id 区间，用来判断指针有没有覆盖它。 */
function spanOf(dbPath, session, turn) {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare('SELECT MIN(id) AS "from", MAX(id) AS "to" FROM l0 WHERE session_id = ? AND turn = ?').get(session, turn);
  db.close();
  return row === undefined || row === null ? null : { from: Number(row.from), to: Number(row.to) };
}

/** 一条结果行里的 `#L5-12` → 区间。 */
function refRange(line) {
  const m = /#L(\d+)(?:[-–~](\d+))?/u.exec(line);
  if (m === null) return null;
  return { from: Number(m[1]), to: Number(m[2] ?? m[1]) };
}

const quoteLines = (text) => String(text).split('\n').filter((line) => /原话/u.test(line) && /#L/u.test(line));

/* ── 1 + 2：同一件事的两个时刻 ──────────────────────────────────────── */
{
  const { loom, dbPath, done } = boot('same');
  try {
    await loom.turn('same', '明天还得陪我爸去社区医院开药，他嫌排队，我得去盯着', '谈国华那脾气，排队最磨人。', { at: BASE });
    await loom.turn('same', '回来路上买了两斤橘子，甜', '橘子这时候正好。', { at: BASE + 2 * 3600e3 });
    await loom.turn('same', '今天陪我爸去社区医院，排队排了快一个钟头，他中途差点甩手走人', '还真被你说中了。', { at: BASE + DAY });
    /*
     * 第三个时刻是这件事**之后很久的一次回忆**，事件日不同——它才是第二个
     * 名额该去的地方。没有它，被让位的那句只能原地留着，「合并」就没有意义。
     */
    await loom.turn('same', '之前陪我爸去社区医院开降糖药，排了四十分钟，回来还偷吃白糖糕', '四十分钟啊，他嫌排队果然不是白嫌的。', { at: BASE + 60 * DAY });
    wipeDerived(dbPath);

    const out = String(await loom.call('memory_search', { query: '我最早说明天陪我爸去社区医院开药，排队时间先后又是怎么说的？', limit: 10 }, 'same'));
    console.log('\n[1] 同一件事两个时刻 → 一个指针覆盖两轮\n');
    console.log(out.split('\n').map((l) => '    ' + l).join('\n'));

    const plan = spanOf(dbPath, 'same', 1);
    const result = spanOf(dbPath, 'same', 3);
    const lines = quoteLines(out);
    const carrying = lines.filter((line) => {
      const range = refRange(line);
      return range !== null && plan !== null && range.from <= plan.to && range.to >= plan.from;
    });
    const resultLines = lines.filter((line) => line.includes('快一个钟头'));

    check('结果句拿到了指针', resultLines.length === 1, String(resultLines.length));
    check('指针区间盖住了前两天那句计划', carrying.length >= 1, `计划轮 L${plan?.from}-${plan?.to}`);
    if (resultLines.length === 1) {
      const range = refRange(resultLines[0]);
      check('盖住计划的是**结果句那一条**（合并不是各占一个名额）', range !== null && plan !== null && range.from <= plan.to && range.to >= plan.from, JSON.stringify(range));
    }
    check('计划句没有单独再占一条（合并生效）', !lines.some((line) => line.includes('他嫌排队，我得去盯着') && !line.includes('快一个钟头')), String(lines.length));

  } finally {
    done();
  }
}

/* ── 3：事件日写在方括号里，引号内不动 ─────────────────────────────── */
{
  const { loom, dbPath, done } = boot('annot');
  try {
    await loom.turn('annot', '明天还得陪我爸去社区医院开药，他嫌排队，我得去盯着', '谈国华那脾气，排队最磨人。', { at: BASE });
    await loom.turn('annot', '这两天风大，阳台那盆薄荷搬进来了', '薄荷怕风，搬进来好。', { at: BASE + 3600e3 });
    wipeDerived(dbPath);
    const out = String(await loom.call('memory_search', { query: '明天陪我爸去社区医院开药排队的事', limit: 10 }, 'annot'));
    console.log('\n[2] 事件日写在 [ ] 里，引号内逐字不变\n');
    console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
    const line = out.split('\n').find((one) => one.includes('明天还得陪我爸')) ?? '';
    check('计划句那一行标出了事件日 04-02', /事件\s*04-02/u.test(line), line);
    check('引号里仍是原话（「明天」前没插日期）', line.includes('「明天还得陪我爸去社区医院开药'), line);
  } finally {
    done();
  }
}

/* ── 4：算不出的不加，伪日期不认 ───────────────────────────────────── */
{
  const { loom, dbPath, done } = boot('none');
  try {
    await loom.turn('none', '上次去社区医院排队排了四十分钟，他嫌得不行', '四十分钟确实久。', { at: BASE });
    await loom.turn('none', '后天免疫这事我查过，跟先天两码事', '那是两套机制。', { at: BASE + DAY });
    wipeDerived(dbPath);
    const out = String(await loom.call('memory_search', { query: '社区医院排队排了多久，后天免疫跟先天有什么区别', limit: 10 }, 'none'));
    console.log('\n[3] 算不出 / 不是日期 → 一个字都不加\n');
    console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
    check('「上次」不标事件日', !/上次去社区医院[^）]*）\[[^\]]*事件/u.test(out) && !out.split('\n').some((line) => line.includes('上次去社区医院') && line.includes('事件')));
    check('「后天免疫」不当成后天', !out.split('\n').some((line) => line.includes('后天免疫') && line.includes('事件')), out.split('\n').find((line) => line.includes('后天免疫')) ?? '');
  } finally {
    done();
  }
}

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
