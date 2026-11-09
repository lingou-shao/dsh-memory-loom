/**
 * 「第二天」是日历上的次日，不是满 24 小时；「别提这件事」是长期规则，不是一条事实。
 *
 * 两件事放一个探针，因为它们同属一类：**句子说的是哪件事、什么时候，不由字面决定**。
 *
 * 一、跨天。原话通道给第二个指针时优先「另一天」那句——「后来呢」的答案在那儿。
 *     这个「另一天」原来按 `|Δt| >= 24h` 算，而 04-08 18:10 说的计划、04-09 11:17
 *     说的结果只隔 17 小时，被判成同一天，于是第二个名额被一个四月下旬的旧轮拿走：
 *
 *       04-08 18:10 「我把那盆迷迭香挪到阳台里侧，外边晒得叶子卷」
 *       04-09 11:17 「今天看它缓过来了，浇水壶先放在阳台门旁边」  ← 答案，隔 17 小时
 *
 *     改成按本地日历日比较之后，第二句才拿得到那个名额。
 *
 * 二、界线。`你别主动提退稿邮件` 是**每次回复都成立**的规则，不是「我有一条关于
 *     退稿的事实」。它原来按普通事实存，靠相似度召回——而说这句话的那一轮
 *     （「今晚写得很卡，陪我说两句」）一个实词都没有，永远召回不到。现在它进
 *     常驻区的偏好栏：不必被问就该在眼前。
 *
 *     同一段里还有两个反例必须挡住：故事里的引语（`老褚只说“别问夜船”`）和
 *     把「别」贴在别的字后面的句子（`又一句别问夜船`），它们不是对助手说的。
 *
 *   node probe-day-boundary.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoom } from './harness.mjs';

let failed = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ` — ${detail}`}`);
};

const HOUR = 3600e3;
const DAY = 864e5;
const BASE = Date.parse('2026-04-08T18:10:00+08:00');

function boot(session) {
  const dir = mkdtempSync(join(tmpdir(), `loom-day-boundary-${session}-`));
  const dbPath = join(dir, 'loom.db');
  /*
   * `relaxBelow: 9` 把原话通道逼出来：探针要看的是「第二个指针给了谁」，不是
   * 派生层答不答得上。派生层一旦严格命中够多，原话通道根本不跑。
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

/* ── 1：第二天只隔 17 小时，也要算「另一天」 ─────────────────────── */
{
  const { loom, done } = boot('next-day');
  try {
    await loom.turn('next-day', '我把那盆迷迭香挪到阳台里侧，外边晒得叶子卷', '晒卷了确实得挪。', { at: BASE });
    await loom.turn('next-day', '今天看它缓过来了，浇水壶先放在阳台门旁边', '缓过来就好。', { at: BASE + 17 * HOUR });
    /*
     * 更早的一次无关对话。它离种子很远（几周），旧代码按 24 小时判「跨天」，
     * 它是唯一合格的候选，于是第二个指针给了它——这正是要复现的错。
     */
    await loom.turn('next-day', '这几天风大，阳台那盆薄荷搬进来了', '薄荷怕风。', { at: BASE + 21 * DAY });
    const out = String(await loom.call('memory_search', { query: '阳台那盆迷迭香浇水壶放哪了', limit: 10 }, 'next-day'));
    const hits = out.split('\n').filter((line) => /^\d+\./.test(line));
    check('结果里有两段原话', hits.length >= 2, `拿到 ${hits.length} 条`);
    check('第二个指针是次日那句（不是几周后的）', hits[1] !== undefined && hits[1].includes('浇水壶先放在阳台门旁边'), hits[1] ?? '(无)');
  } finally {
    done();
  }
}

/* ── 2：界线进常驻区，不必被问 ───────────────────────────────────── */
{
  const { loom, done } = boot('boundary');
  try {
    await loom.turn('boundary', '我第一本书扑街那段，还有当年那些退稿邮件的事，你别主动提。', '记住了。', { at: BASE });
    await loom.turn('boundary', '今晚写得很卡，陪我说两句就行。', '那就先歇一会儿。', { at: BASE + 2 * HOUR });
    const block = String(loom.memoryBlock('boundary'));
    check('常驻块里有那条界线（逐字）', block.includes('你别主动提'), block.split('\n').slice(0, 6).join(' / '));
    check('它落在偏好与要求那一栏', /偏好|要求/.test(block), block.split('\n')[1] ?? '');
  } finally {
    done();
  }
}

/* ── 3：方言「莫」同样是界线；引语和「又一句别问」不是 ──────────── */
{
  const { loom, done } = boot('dialect');
  try {
    await loom.turn('dialect', '区级体育教师编制，冲刺期压力大得很。你莫主动问她成绩', '不问。', { at: BASE });
    await loom.turn('dialect', '老褚只说“别问夜船”，阿桔就没再问', '有些事问不出来。', { at: BASE + HOUR });
    await loom.turn('dialect', '那老褚肯说另一半在谁手里吗，还是又一句别问夜船', '他就是不肯说。', { at: BASE + 2 * HOUR });
    const block = String(loom.memoryBlock('dialect'));
    /*
     * 只看偏好那一栏。「别问夜船」作为故事内容当然还留在事实区，那是另一回事——
     * 它不该变成一条「以后别问夜船」的长期规则。
     */
    const pref = block.split('【').find((part) => /偏好|要求/.test(part.slice(0, 20))) ?? '';
    check('「你莫主动问她成绩」进了常驻区', pref.includes('莫主动问她成绩'), '');
    check('引语「别问夜船」没有被当成界线', !pref.includes('别问夜船'), '');
  } finally {
    done();
  }
}

if (failed > 0) {
  console.error(`\n${failed} 项未通过`);
  process.exit(1);
}
console.log('\n全部通过');
