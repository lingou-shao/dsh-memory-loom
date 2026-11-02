/**
 * probe-diary-budget.mjs — 主观层预算探针
 *
 * 假设（待验证）：`appendSection` 里的 `used` 是全局累加的，而调用方传进去的
 * cap 却是 `Math.floor(target * subjectiveShare)` 这种「块内配额」的算法。
 * 如果事实区先用掉超过这个数值的 token，主观层（印象 / 日记 / 偏好）就会被
 * 整体挡在门外 —— 配置里写着启用，实际注入为零，且没有任何报错。
 *
 * 探针构造「事实很多 + 有日记 + 有印象」的真实形态，然后看：
 *   1. 日记是否出现在记忆块里；
 *   2. 印象是否出现；
 *   3. 事实是否把主观层挤空。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLoom, MIN } from './harness.mjs';

const root = mkdtempSync(join(tmpdir(), 'loom-diary-'));
const dbPath = join(root, 'loom.db');

const results = [];
const check = (label, ok, detail = '') => results.push([label, Boolean(ok), detail]);

const loom = createLoom({
  dbPath,
  // 重度用户的配置：事实多，允许一次放更多条
  config: { timezone: 'Asia/Shanghai', retrieval: { maxItems: 40 } },
});

const DIARY_ENTRY = '今天他一直在调那个记忆插件，反复说怕压缩之后我会忘事。我解释了两遍记忆不在上下文里，他还是不放心，最后自己去翻了代码。这个人不太信口头保证，得给他看东西。';

try {
  // 1. 先灌 20 条长事实，把事实区撑到接近预算上限
  const facts = [
    '我在杭州做后端开发，主要写 Node 和 Go，最近两年项目里 Node 的比例在下降，Go 越来越多，主要是团队觉得运维简单',
    '我的主力电脑是 Windows，装开发工具习惯用 scoop 而不是 winget，因为 scoop 不往注册表里塞东西，卸载干净',
    '我养了一只叫年糕的橘猫，今年四岁，是领养的，胆子很小，听到门铃就会躲到沙发底下待半小时才出来',
    '我每天早上七点半起床，先喝一杯黑咖啡再开始工作，不加糖不加奶，喝的是手冲，磨豆机用了三年还没换',
    '我不喜欢电话沟通，能打字就打字，尤其是工作上的事，因为电话说完没有记录，事后容易扯皮，文字至少能回看',
    '我上一个项目是做电商后台的订单模块，做了两年，最后因为公司业务调整整条线被砍了，团队解散的时候还挺难受',
    '我最近在自学 Rust，卡在所有权和生命周期那一章，borrow checker 报的错经常看不懂，只能一行一行试',
    '我周末通常在家写代码或者打游戏，很少出门，除非有人约，但朋友大多结婚生子了，能约出来的人越来越少',
    '我讨厌开会，尤其是超过半小时又没有明确议题的会，遇到这种会我会在群里假装有别的安排提前退出',
    '我用的编辑器是 VS Code，装了 vim 插件但只用了最基本的移动命令，复杂操作还是靠鼠标，一直想学但没时间',
    '我对声音特别敏感，写代码时必须戴降噪耳机，办公室有人大声讲电话我会完全无法集中注意力，只能换个地方',
    '我去年体检血脂偏高，医生让我少吃油炸和内脏，我现在外卖基本只点清淡的，但偶尔还是会破戒吃一次炸鸡',
    '我妈每周末会打电话来问吃饭没有，每次都要聊二十分钟，内容大部分是重复的，但我知道她只是想找人说说话',
    '我有一个弟弟在读大三，学的是土木工程，他最近在纠结要不要考研，我建议他先工作两年看看再说，他不太认同',
    '我的显示器是 27 寸 4K，旁边接了一块竖屏专门用来看日志和文档，这个双屏布局用了两年，换回单屏会很不习惯',
    '我把所有密码都存在 1Password 里，主密码记在纸上锁在抽屉里，两步验证的恢复码打印了两份，一份放老家',
    '我出差讨厌坐早班机，宁愿前一天晚上走，因为早上五点起床赶飞机一整天都会是废的，晚上到至少能睡个整觉',
    '我写代码前会先写一段注释理清思路，写完再删掉，这个习惯是从一个老同事那里学的，他说想不清楚就别开始写',
    '我租的房子在城西，通勤单程四十分钟，地铁直达不用换乘，但早高峰很挤，所以我一般十点才出门避开高峰',
    '我不用微信支付以外的任何支付方式，信用卡只有一张，额度不高，主要是怕自己乱花钱，这个习惯保持了五年',
  ];
  for (const text of facts) await loom.call('memory_write', { text, kind: 'fact' }, 's1');
  // 最后 8 条写成长事实：recentFacts 固定取最近 8 条，长事实才能把事实区撑过主观层预算
  const LONG = [
    '我在杭州做后端开发，主要写 Node 和 Go。最近两年项目里 Node 的比例在下降，Go 越来越多，主要是团队觉得 Go 部署简单、内存占用低、排查线上问题的时候栈信息更清楚。我个人其实更喜欢 Node 的写法，但不得不承认 Go 在这类服务上确实省心，尤其是那种需要长期跑着不能重启的进程。',
    '我的主力电脑是 Windows，装开发工具习惯用 scoop 而不是 winget。原因是 scoop 默认装到用户目录，不往注册表里塞东西，卸载的时候删掉目录就干净了，不会留下那种删不掉的残留服务。代价是有些 GUI 软件 scoop 上没有，还得单独去官网下安装包，所以我机器上两套都在用。',
    '我养了一只叫年糕的橘猫，今年四岁，是领养的。它胆子特别小，听到门铃就会躲到沙发底下待半小时才出来，家里来客人的时候基本一整天见不到它。但它又很黏人，只有我一个人的时候会趴在键盘旁边，我写代码它就睡，我一起身它就跟着走。',
    '我不喜欢电话沟通，能打字就打字，尤其是工作上的事。因为电话说完没有记录，事后容易扯皮，文字至少能回看，也能截图留证据。我知道这样效率低一些，有些事情三分钟电话能说清，但我宁愿多花十分钟写清楚，也不想事后为了“当时到底怎么说的”争半天。',
    '我上一个项目是做电商后台的订单模块，做了两年。最后因为公司业务调整，整条线被砍了，团队解散的时候还挺难受的，毕竟那套代码是我一行一行写起来的。现在回头看，那两年学到的东西比项目本身值钱，尤其是怎么处理那种涉及钱的状态机，一个边界条件没考虑到就是资损。',
    '我最近在自学 Rust，卡在所有权和生命周期那一章。borrow checker 报的错经常看不懂，只能一行一行试，改这里报那里，有时候一个函数要折腾一晚上。但我还是想学下去，因为听说写出来的东西跑起来特别稳，而且我现在做的这类长驻服务，正好是它擅长的场景。',
    '我对声音特别敏感，写代码的时候必须戴降噪耳机。办公室里如果有人大声讲电话，我会完全无法集中注意力，脑子里全是对方说的内容，一行代码都写不进去，只能换个地方或者干脆等对方打完。这个毛病从小就有，考试的时候旁边有人翻卷子我都会分心。',
    '我把所有密码都存在 1Password 里，主密码记在纸上锁在抽屉里，两步验证的恢复码打印了两份，一份放老家一份放办公室。这么做的原因是之前丢过一次账号，找回来的过程极其麻烦，从那以后我就把所有东西都做了冗余，宁愿麻烦一点也不想再经历一次。',
  ];
  for (const text of LONG) await loom.call('memory_write', { text, kind: 'fact' }, 's1');


  // 2. 一条 standing preference —— 它必须出现，这是用户最在意的东西
  await loom.call('memory_write', { text: '我不吃香菜，点外卖一定要备注', kind: 'instruction' }, 's1');

  // 3. 一轮对话，让 recall 有 query
  await loom.turn('s1', '今天写了一天代码，有点累', '累了就先停，明天再弄也一样。', { gapMs: 2 * MIN });

  // 4. 直接往库里写日记与印象，模拟整合产物
  //    （规则模式不会自动生成这两样，但渲染路径与真实整合后完全一致）
  const db = new DatabaseSync(dbPath);
  const identityId = String(db.prepare('SELECT id FROM identities LIMIT 1').get().id);
  const now = Date.now();
  const insertDiary = db.prepare('INSERT INTO diary (identity_id, entry, day_key, created_at) VALUES (?, ?, ?, ?)');
  for (let day = 0; day < 3; day++) {
    insertDiary.run(identityId, DIARY_ENTRY, `2026-10-${28 + day}`, now - day * 86400000);
  }
  db.prepare(`
    INSERT INTO impressions (identity_id, text, confidence, observations, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(identity_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at
  `).run(identityId, '他对自己做的东西有一种过度负责的倾向：明明只是个自用插件，却反复检查边界情况，怕别人装了出问题。这种人不擅长休息，也不太会接受“已经够好了”这个答案。', 0.6, 4, now);
  db.close();

  const block = loom.memoryBlock('s1');
  const hasFacts = block.includes('【关于你（事实）】');
  const hasDiary = block.includes('【我的日记】');
  const hasImpression = block.includes('【我对你的印象】');
  const hasPreference = block.includes('香菜');

  check('事实区出现', hasFacts, '');
  check('日记区出现', hasDiary, hasDiary ? '' : '被预算挤掉');
  check('印象区出现', hasImpression, hasImpression ? '' : '被预算挤掉');
  check('偏好出现', hasPreference, hasPreference ? '' : '被预算挤掉');

  const tokenCount = Math.ceil(
    [...block].reduce((n, ch) => n + (/[\p{Script=Han}]/u.test(ch) ? 0.65 : /[A-Za-z0-9]/.test(ch) ? 0.25 : 0.25), 0),
  );
  check('整块未超过硬上限', tokenCount <= 3000, `${tokenCount} token`);

  if (process.env.LOOM_PROBE_VERBOSE === '1') {
    console.log('--- block ---');
    console.log(block);
    console.log('--- end ---');
  }
} finally {
  loom.dispose();
}

let failed = 0;
console.log('=== 主观层预算 ===');
for (const [label, ok] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}
console.log(`\n${failed === 0 ? '全部通过' : '失败 ' + failed + ' 项'}（${results.length} 项）`);

try {
  rmSync(root, { recursive: true, force: true });
} catch {
  // best effort
}

process.exit(failed === 0 ? 0 : 1);
