/**
 * Diary mirror + tone hints (Q63 / Q64).
 *
 * Q63 decided the diary is not worth weighting into recall, so the owner gets
 * a readable copy instead: one Markdown file per day, in a folder resolved
 * relative to the database. Q64 decided the only thing that matters about tone
 * is that the model *sees* it when reading a memory, so it rides along on the
 * event line instead of a separate injection channel.
 *
 *   node loom-e2e/scenario-diary.mjs
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom } from './harness.mjs';

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'loom-diary-'));
const now = Date.now();
const EVENT_COLUMNS = `INSERT INTO events (identity_id, session_id, title, summary, tokens, domain,
  started_at, ended_at, turn_from, turn_to, salience, valence, arousal, l0_from, l0_to, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Build a store, then fill the diary and two events by hand — the consolidation
 * pass is the only writer of diary rows and needs a model, so the mirror is
 * exercised from the database side instead.
 */
function seed(dbPath, { diary = true, events = true } = {}) {
  const first = createLoom({ dbPath });
  first.dispose();
  const db = new DatabaseSync(dbPath);
  if (diary) {
    const insert = db.prepare('INSERT INTO diary (identity_id, entry, day_key, created_at) VALUES (?, ?, ?, ?)');
    // 25 entries on one day: more than the old `recentDiary(…, 20)` cap, so the
    // profile counter is checked for the real total instead of a truncated one.
    for (let i = 0; i < 25; i++) insert.run('master', `第 ${i + 1} 篇：今天想清楚了一点事。`, '2026-10-29', now - i * 60000);
    insert.run('master', '第二天写的第一篇。', '2026-10-30', now + 36e5);
  }
  if (events) {
    const insertEvent = db.prepare(EVENT_COLUMNS);
    insertEvent.run('master', 's1', '为辞职吵起来的那次', '说到加班时声音变高，明显不高兴。', '', 'relationship',
      now - 9e5, now - 8e5, 1, 1, 0.8, -0.7, 0.55, 0, 0, now - 8e5);
    insertEvent.run('master', 's1', '她夸我那次', '聊到最后心情不错，语速也慢下来。', '', 'relationship',
      now - 6e5, now - 5e5, 2, 2, 0.6, 0.6, 0.2, 0, 0, now - 5e5);
    // A Latin title keeps the neutral case searchable: the Chinese index is
    // bigram-based and these fixtures bypass the writer that fills `tokens`.
    insertEvent.run('master', 's1', 'weather question', 'asked about the weather tomorrow, flat tone.', '', 'other',
      now - 3e5, now - 2.9e5, 3, 3, 0.2, 0, 0.05, 0, 0, now - 2.9e5);
  }
  db.close();
}

/* ---- 1. 日记镜像 --------------------------------------------------------- */

console.log('[1] 日记镜像：库旁边的只读 Markdown');
const dir = join(root, 'vault');
const dbPath = join(dir, 'loom.db');
seed(dbPath);
const loom = createLoom({ dbPath });
const diaryDir = join(dir, 'diary');
check('镜像目录建在库旁边（相对 path 解析）', existsSync(diaryDir), diaryDir.replace(root, '…'));
const days = existsSync(diaryDir) ? readdirSync(diaryDir).filter((name) => name.endsWith('.md')).sort() : [];
check('一天一个文件', days.length === 2, days.join(' / '));
const body = existsSync(join(diaryDir, '2026-10-29.md')) ? readFileSync(join(diaryDir, '2026-10-29.md'), 'utf8') : '';
check('标题即日期', body.startsWith('# 日记 2026-10-29'));
check('按人分组', body.includes('## 主人'));
check('每条带时间', /^- \d{2}:\d{2} /m.test(body));
const lines = (body.match(/^- \d{2}:\d{2} /gm) ?? []).length;
check('25 篇一篇不少', lines === 25, `${lines} 条`);
check('文件自带只读说明', body.includes('只读镜像'));

const profile = await loom.call('memory_profile', {}, 's1');
check('profile 给出日记入口', profile.includes(`日记目录：${diaryDir}`), '可直接用文件管理器打开');
check('日记计数是总数而非前 20 条', profile.includes('日记 26 篇'));

// 重开一次不会重复写、也不会丢：stamp 打在同一进程里，跨进程靠重算。
loom.dispose();
const again = createLoom({ dbPath });
const same = readFileSync(join(diaryDir, '2026-10-29.md'), 'utf8');
check('重开进程后文件内容不变', same === body);
again.dispose();

// 关掉镜像时不应创建任何目录。
const quietDir = join(root, 'quiet');
seed(join(quietDir, 'loom.db'), { events: false });
const quiet = createLoom({ dbPath: join(quietDir, 'loom.db'), config: { diary: { mirror: false } } });
check('mirror=false 时不建目录', !existsSync(join(quietDir, 'diary')), readdirSync(quietDir).join(' / '));
quiet.dispose();

/* ---- 2. 语气提示 --------------------------------------------------------- */

console.log('\n[2] 语气提示：随记忆行一起出现，不需要额外通道');
const live = createLoom({ dbPath });
await live.turn('s1', '还记得辞职那件事吗', '记得，那次你很不高兴。');
const block = live.memoryBlock('s1');
check('回想块里带上当时的语气', block.includes('（语气偏冲）'), 'valence -0.7 / arousal 0.55');
check('正面情绪也标注', block.includes('（语气愉快）'), 'valence 0.6');
check('中性事件不加标记', !/weather question[^\n]*（语气/.test(block));
const hit = await live.call('memory_search', { query: 'weather' }, 's1');
check('memory_search 同样带语气信息', hit.includes('weather question') && !hit.includes('（语气偏冲）'), '中性那条没有标记');
live.dispose();

const offLoom = (() => {
  const quietDb = join(root, 'plain', 'loom.db');
  seed(quietDb, { diary: false });
  return createLoom({ dbPath: quietDb, config: { retrieval: { toneHint: false } } });
})();
await offLoom.turn('s1', '还记得辞职那件事吗', '记得。');
const off = offLoom.memoryBlock('s1');
check('toneHint=false 时完全不出现', off.length > 0 && !off.includes('（语气'));
offLoom.dispose();

/* ---- 3. 旧库兼容 --------------------------------------------------------- */

console.log('\n[3] 旧库兼容：weight/mood 列还在也不影响读写');
const legacy = join(root, 'legacy', 'loom.db');
seed(legacy, { events: false });
const legacyDb = new DatabaseSync(legacy);
legacyDb.exec('PRAGMA journal_mode = WAL');
legacyDb.exec("ALTER TABLE diary ADD COLUMN weight REAL NOT NULL DEFAULT 1");
legacyDb.exec("ALTER TABLE diary ADD COLUMN mood TEXT NOT NULL DEFAULT ''");
legacyDb.close();
const reopened = createLoom({ dbPath: legacy });
const legacyProfile = await reopened.call('memory_profile', {}, 's1');
check('老库多出的列被忽略，读写正常', legacyProfile.includes('日记 26 篇'));
reopened.dispose();

rmSync(root, { recursive: true, force: true });
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
