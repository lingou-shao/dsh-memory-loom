# 端到端测试报告

对象：`dsh-memory-loom@0.2.12` 起，逐版追加至 `0.2.16`（融合后的单包，含钩子索引层）
方式：跑**真实的插件 bundle**（`../lib/index.js`），不是模拟。

> 这份报告随 npm 包发布（`loom-e2e/REPORT.md`），但**下面引用的 `harness.mjs` / `scenario-*.mjs` / `probe-*.mjs` 没有随包发布**——它们需要一个能解析 `@deepseek-ai/*` 的 Node 环境，安装位置没有（DSH 用 pnpm，不装 peer）。想复跑请从 Release 附件下载 `loom-e2e-0.2.16.zip`，把解压出的 `loom-e2e/` 覆盖到包根目录，先 `npm install` 再按下面第二节跑。

## 一、测试环境是真的还是假的

| 部件 | 真假 | 说明 |
|---|---|---|
| 插件代码 | **真** | `harness.mjs` 直接加载 `../lib/index.js`，与发布物同一份文件 |
| `defineTool` / 参数校验 | **真** | 来自本机 dsh 安装的 `@deepseek-ai/dsh-tools@0.2.1-rc.3` |
| `Config` 默认值与校验 | **真** | `@deepseek-ai/schemastery@3.18.5` |
| 事件捕获、切段、整合、检索、渲染 | **真** | 全部走插件自己的代码路径 |
| 模型调用 | 无 | 全程 `ctx.llm` 缺失 = 规则模式，这是插件声明的受支持部署形态（`docs/design.md` §1.3） |
| cordis 宿主 | **假** | 只实现了插件真正用到的四个面：`systemPrompt.section/context`、`session/event`、`agent/created` + `turn-stopping`、`tools.register` |

## 二、怎么跑

> 跑的时候 Node 会打印 `ExperimentalWarning: SQLite is an experimental feature`（Node 22 上 `node:sqlite` 仍带这个标记）。**这是警告不是失败**，看退出码即可。

```bash
npm install                 # 先装 peer/dev 依赖（包根，npm 会把 peer 一并装上）
cd loom-e2e
node scenario-work.mjs      # 工作类：写代码 + 表格，18 项
node scenario-limit.mjs     # 极限类：60 轮 + 40 事实 + 12000 字单条，17 项
node scenario-merged.mjs    # 索引层工具闭环：view/search/promote/rebuild/gc/expand/pack，24 项
node scenario-l0cap.mjs     # 长消息落库与截断，15 项
node scenario-diary.mjs     # 日记镜像 + 语气标注 + 老库兼容，17 项
node scenario-cost.mjs      # 分页取回成本：四档预算 × 中英文
node probe-config.mjs       # 配置一致性：schema 默认值 vs indexDefaults vs 引擎配置
node probe-ceiling.mjs      # 上限实测：rebuild 成本与驻留 token
node probe-recall.mjs       # 池外事件找回闭环：FTS5 → memory_expand
node probe-hotload.mjs      # 热加载：会话先存在、插件后组合时，四块 prompt 内容是否都挂上
node probe-episodes.mjs     # 事件块：能否列出、标题是否带对象名、跨会话是否合并，18 项
node probe-model-title.mjs  # 模型路径：假 llm 服务喂回 JSON，看标题是否真被采用，16 项
cd .. && npm test           # 钩子索引自测，30 项
```

当前全部通过（work 18 + limit 17 + merged 25 + l0cap 15 + diary 17 + selftest 30 = **122 项断言**，另有 17 个探针脚本全绿，退出码均为 0）。

## 三、各场景覆盖什么

- **work**：两条并行会话分别推进一个代码调试任务和一张表格任务，对照「原记忆块每轮全量注入」与「索引 + 按需展开」的 token 账，并交叉验证两套检索路径谁能答上「怎么确认的」。
- **limit**：把对话推到整合阈值之上、单条 1.2 万字、40 条事实挤占，验证切段与驻留稳定；20 次 rebuild 结果逐字一致（防人格漂移的硬指标）。
- **merged**：索引层三个工具的全部分支，包括 `T` 拒绝挂载、同名折叠、promote、遗忘级联（search 返回 `#F2` → forget → expand 拒绝 → gc → 钩子消失）。
- **l0cap**：默认整条落库、显式上限截断带标记、脱敏先于截断、体积 1.14x。
- **diary**（v0.2.9）：日记导出到数据库旁的 `diary/` 目录（一天一个 md、按人分组、带时间、25 篇不丢一行）、`mirror=false` 不建目录、`memory_profile` 给出目录入口与真实总数；事件行尾的语气标注（偏冲 / 愉快 / 中性不标 / `toneHint:false` 全关）；老库多出 `weight`/`mood` 列时读写不受影响。
- **cost / probe-***：数字证据，详见 `docs/design.md` §11.4 与 §9.7。

## 四、历史上发现并修复的坑

完整清单见 `docs/design.md`（§7.2、§9、§10、§11）。代表性几个：

- 整合层静默吞 TypeError 导致 L0 一行不写（`toEngineConfig` 白名单漏了 `l0`）
- 8000 字静默截断无提示（0.1.x）
- 分页切片固定按中文比率猜字符数，英文/代码页数翻倍
- `memory_search` 返回裸 `#id`，与 `memory_expand` 的 `E`/`F` 前缀对不上，且两个 id 空间同号会撞

## 五、v0.2.7 审计：三个真 bug + 一个跨机器 bug

这一轮不是加功能，是拿探针去撞「文档写了但代码没做」的地方。每个结论都有可复现的脚本。

| 问题 | 探针 | 修复前 | 修复后 |
| --- | --- | --- | --- |
| `consolidation.enabled: false` 完全无效（全文件零处读取） | `probe-audit2.mjs [1]` | 关掉后仍产生 3 个事件 | 0 个事件 |
| 分页把 emoji 劈成半个字符 | `probe-audit.mjs [1]` | 10 页里 8 页以孤立高代理结尾 | 0 页 |
| `memory_pack(ref="E9999")` 挂到不存在的编号还报成功 | `probe-audit3.mjs [2]` | 建了死链接 + 回执「已挂到 E9999」 | 不建链接，如实说编号记错了 |
| `URL.pathname` 取路径，路径含空格/中文时 `npm test` 直接 ENOENT | 换到 `tmp 别人的电脑/repo 克隆` 跑 | 找不到 `lib/index.js`（路径里是 `%20`） | 全部通过 |

跨机器验证的完整路径：`npm install <tgz>` 到一个带空格和中文的目录 → 裸包名 `import('dsh-memory-loom')` 成功（9 个导出）→ 用另一个目录里的库跑两轮真实对话（cwd 在 `/c/`）→ L0 4 行 / events 1 个 / hooks 2 条 / 三个 prompt 块都有内容 → 自带 `npm test` 全过（0.2.8 时 29 项；0.2.9 加了一项 diary 表结构检查，共 30 项）。

**没修、但已记录为已知边界**（`docs/design.md` §12.4）：`refAlive` 不带 `identity_id` 过滤；`memory_pack` 反复覆盖同一编号会留下无链接的旧 `loom_docs`（靠 `gc` 或候选 `LIMIT 60` 淘汰）；`render()` 的 token 统计少算换行符。

## 六、v0.2.9：日记与语气

| 项 | 结论 | 证据 |
| --- | --- | --- |
| 日记不加权 | 评分固定 `similarity: .35` / 渲染固定 `base: .7`，`diary.weight` 无人读，已删列 | `scenario-diary.mjs [1]`；`selftest.mjs` 断言 diary 表只剩 `id, identity_id, entry, day_key, created_at` |
| 日记有入口 | 每天一个 `diary/YYYY-MM-DD.md`，路径按 `path` 所在目录解析相对值 | 同上，`mirror=false` 时不建任何目录 |
| 语气标注 | 只在非中性时出现，记忆块与 `memory_search` 都带，可关 | 两条情绪事件让记忆块 59 → 65 token |
| 老库兼容 | 旧库残留 `weight`/`mood` 列（有默认值）不影响新代码读写 | 手工 `ALTER TABLE` 加回两列后 `memory_profile` 仍显示 26 篇 |

## 七、v0.2.10：从 GitHub 真装一遍

不是本地 `npm install <tgz>`，是让 pnpm 从网络拉发布产物：

| 安装方式 | 命令 | 结果 |
| --- | --- | --- |
| Release 里的 tarball | `pnpm add https://github.com/lingou-shao/dsh-memory-loom/releases/download/v0.2.9/dsh-memory-loom-0.2.9.tgz` | 25 个包 / 21.6s，裸包名 import 9 个导出，`npm test` 30 项全过 |
| GitHub 仓库地址 | `pnpm add github:lingou-shao/dsh-memory-loom` | 同上（codeload 取 tar.gz，走 `files` 白名单：`lib` / `test` / `docs` / `cordis.patch.yml` / `README.md` / `LICENSE` 齐全） |
| 装好的包里跑 e2e | 把 `loom-e2e/` 拷进 `node_modules/dsh-memory-loom/` | work 18 + merged 25 + limit 17 + l0cap 15 + diary 17 + probe-config 全过 |

兼容性预检（直接调用 DSH 的 `evaluatePluginCompatibility()`，第三参数分别传运行时版本）：

| 运行时 | `0.2.9` 声明 | `0.2.10` 声明 |
| --- | --- | --- |
| `0.2.1-rc.3` | 通过 | 通过 |
| `0.2.5` | 通过 | 通过 |
| `0.3.0` | **拒绝**（5 个 `@deepseek-ai/dsh-*` 全部不满足） | 通过 |
| `1.0.0` | **拒绝** | 通过 |

`@deepseek-ai/dsh-tools` 的传递依赖解释了 25 个包 / 17 MB 的体积（`dsh-agent` / `dsh-llm` / `dsh-session` 等），这是 `defineTool` 的代价，删 peer 声明并不能减小它——`defineTool` 是纯函数，副本与宿主不同源不影响运行。

## 八、v0.2.11：装进真实 DSH 之后暴露的四个问题

以下不是我这边的模拟环境，是 `dsh plugin --profile desktop add dsh-memory-loom-0.2.10.tgz` 装进真实桌面端之后的实测（pnpm 11.28.5，`+6 packages`，559 ms）：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| profile 里钉成 `file:C:/Users/shaoz/Desktop/....tgz` | 用本地 tarball 安装的必然结果，桌面文件一挪，下次 pnpm 重装就断 | 插件这边无法改；README 建议装完把 tgz 放固定目录，或直接用 release 直链 |
| 装好的包里 `npm test` 报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools` | DSH 的 pnpm 不安装 peer（`+6` 而不是 `+25`），运行时靠宿主解析，裸 `node` 进程没有这条解析路径 | `test/selftest.mjs` 改为捕获该错误并打印两条复跑路径（release 附件的 `loom-e2e-*.zip` / clone 仓库），不再甩堆栈 |
| pnpm 警告 peer，多装 `schemastery` + `cosmokit` | `schemastery` 同时写在 `dependencies` 与 `peerDependencies` | 删掉 peer 里那一份，只留 `dependencies`（DSH 环境里 peer 本来就不装，留着只会误导） |
| 文档说「重启后旁边多一个 `diary/`」，实测没有 | `syncDiary()` 懒创建目录，库里 0 条日记时不会 mkdir | 改文档：**第一篇日记落盘后**才出现，并说明这不是失败 |

顺带把兼容性声明改准：新增 `engines.dsh: ">=0.2.1-rc.2 <0.3.0"`。DSH 的预检优先读这个字段，读到就不再逐个比对 peer——比靠 peer 范围兜着精确。上限定在 `<0.3.0` 是诚实的：插件用了 `defineTool`、`systemPrompt.section`、session 事件这些宿主内部面，0.3 改语义时它不会自动知道，装不上比装上了坏掉好。

实测记录（真实库 `~/.dsh/memory/loom.db`，装好当天）：`events 0 / facts 1 / diary 0 / loom_hooks 2 / loom_docs 1`。9 个 `memory_*` 工具全部挂载，两个 prompt 块进系统提示，`memory_write → memory_search → memory_expand → memory_pack → memory_index → memory_expand D1` 整条链路真实走通。**整合（写事件、写日记）需要单会话 2 万 token 或空闲 5 分钟才触发，所以当天还没有事件** —— 这一点无法在装机当天验证，如实记在这里。

## 九、v0.2.12：热加载漏挂了一半

真机时间戳先推翻了「装完要重启」：宿主主进程 19:58:15 启动，20:05:09 装插件，20:05:11 `loom.db` 就被建出来了——建库的是那个六分钟前启动的进程。DSH 是**即时重组**，不是「下次启动才装配」。

顺着这条往下查，发现 `apply()` 有一半内容在热加载时是哑的：

| 注入内容 | 注册方式 | 依赖 `agent/created` | 热加载时 |
| --- | --- | --- | --- |
| 记忆使用约定 / 索引约定 | 全局 `systemPrompt.section` | 否 | ✓ |
| 9 个 `memory_*` 工具 | `ctx.tools.register` | 否 | ✓ |
| 人设卡 | `agent.ctx.systemPrompt.section` | **是** | ✗ |
| 钩子索引块 | `agent.ctx.systemPrompt.context` | **是** | ✗ |
| 记忆块 | `agent.ctx.systemPrompt.context` | **是** | ✗ |

原因很直接：热加载时当前会话的 agent 早就创建好了，`agent/created` 不会再来一次。而装机时最容易确认的两样（工具、全局协议块）恰好都不依赖它，所以表面上「一切正常」。

`probe-hotload.mjs` 用 fake ctx 构造「agent 先存在、插件后 `apply`」的场景固定差异：

```
修复前  protocol ✓  index-protocol ✓  persona ✗  hooks ✗  memory ✗  工具 ✓
修复后  protocol ✓  index-protocol ✓  persona ✓  hooks ✓  memory ✓  工具 ✓
新会话（装完之后才创建）：修复前后都 ✓ —— 所以这个缺陷只影响「装之前就开着的那个会话」
```

修法三条，都只影响中途装载这条路径：

1. `apply()` 末尾遍历宿主 `agents` 服务的 `list()`，对每个 live agent 调 `attachAgent`（函数自带幂等保护）。
2. `turn-stopping` 里补一次 `attachAgent`，用于宿主不暴露 `agents` 服务的场合。
3. 新增 `ctx.effect("memory-loom:agents")`，卸载/重组时撤掉全部按会话的 section，避免反复重组叠同名块。

回归：selftest 30 项、work 18 / merged 24 / limit 17 / l0cap 15 / diary 17 全过，`probe-config` / `probe-ceiling` / `probe-recall` / `probe-audit`(×3) / `probe-hotload` 退出码全 0。正常启动路径行为未变。

## 十、v0.2.13：宿主不兜底 prompt 块，一条坏库会让每轮都失败

来自装了这个插件的 DSH 自己的代码审查：它指出 `recallFor()` 外面没有 try/catch，怀疑宿主不兜底。顺着查下去，结论比它说的更糟一点。

读本机 `D:/dsh/resources/app.asar` 里的实际实现（不是文档）：

- `dsh-system-prompt` 的 `assemble()` 与 `resolveContext()` 都是 `section.text(context)` 裸调用，整个模块没有 try/catch。
- `required: true` 只参与「运行期上下文被抑制时是否保留」的过滤，**不参与异常处理**。
- `dsh-agent-loop` 的 `preStep()` 直接 await `assemble()`；`turn()` 外层 catch 把异常折成 `turn/end: { reason: { kind: "error" } }` 再 rethrow；driver 的 `while (await this.turn())` 外面有 `catch (_error) {}`。

所以进程不倒，但**每一轮都失败**，直到库恢复。三块按会话的 prompt（persona / hooks / memory）都会抛，前两块此前没人注意。

`loom-e2e/probe-prompt-guard.mjs` 固定这条（关闭引擎 = 库不可用）：

```
修复前  persona ✗  hooks ✗  memory ✗   （3/3 抛错，exit 1）
修复后  persona ✓  hooks ✓  memory ✓   （3/3 返回空串，exit 0）
```

修法是 `guardPrompt(label, fn)`：失败返回 `""`，同一 label 60 秒内只告警一次。空块会被宿主过滤（`renderPrompt` / `renderContextSections` 都 `filter(text.length > 0)`），不会留下空标题。

回归：selftest 30 项、work 18 / merged 24 / limit 17 / l0cap 15 / diary 17 全过，`probe-hotload` / `probe-prompt-guard` / `probe-config` / `probe-ceiling` / `probe-recall` 退出码全 0。

## 十一、v0.2.14：让降级说话，并给模型一个自检入口

v0.2.13 的降级是安静的：库坏了，模型照样自信地回答，用户看不出区别。这一版补两条——一条给人（状态行），一条给模型（`memory_doctor`）。

**状态行**：三块 prompt 的失败计数进同一份 per-session 注册表；连续失败 3 次后，由 `memory` 块（唯一每轮必被求值、且最后求值的块）输出一句 `【记忆状态】…`，列出所有失败块、要求"如实说明、不要凭印象编造"，并指向 `memory_doctor`。任一 label 成功即清零。前两次失败保持静默，避免单次抖动刷屏。降级期间每轮多约 90 token，且追加在 `budgetTokens` 之外。

**memory_doctor（第 10 个工具）**：只读体检 8 项——库连接、库文件大小与 mtime、WAL、`journal_mode`/`synchronous`、`quick_check`、六张表行数、最近一次 `recall` 时间、prompt 三块连续失败。每项独立 try/catch；不用 `actorOf()`（它会读库）；时间格式化在 `timezoneOf()` 抛错时退回本机时区。报告分 ✓/✗/·，只有 ✗ 计入"发现 N 处问题"。

断库实测（把 `ctx.effect` 全撤，等效库被删/损坏）：

```
✗ 库连接  database is not open
✓ 库文件  280.0 KB · 修改于 2026/10/31 22:56:04
· WAL  不存在（没有未落盘的写入，或库被正常关闭）
✗ prompt 块  memory 连续 3 次（database is not open）
· 日记目录  …\diary

结论：发现 2 处问题。
下一步：库连不上：先确认没有第二个 DSH 实例占着它，再重启 DSH。不要删库；库本身也许是好的：把上面 prompt 块的错误原文发给维护者。
```

`loom-e2e/probe-degrade-notice.mjs` 8 项全过（健康不出状态行 / 注册 / 健康自检 / 前两次静默 / 第三次出现 / 含两条指令 / 只出现一次 / 坏库不抛错且定位到连接），exit 0。

回归：selftest 30 项全过；`scenario-work/merged/limit/l0cap/diary/cost` 全过；`probe-hotload`（断言改为 10 个工具）/`probe-prompt-guard`/`probe-config`/`probe-ceiling`/`probe-recall`/`probe-audit*` 退出码全 0。

未覆盖：库恢复后的计数清零只有代码核对，没有做"失败 3 次再恢复"的故障注入。

## 十二、终检补的两处（仍在 v0.2.14）

**1. 会话销毁时漏清一张表。** `agent/disposed` 里清了 `agentDisposers` 和 `turns`，但 v0.2.14 新加的 `promptHealth`（每会话的 prompt 失败计数）没有 delete——会话越开越多，这张表只增不减。每条只有几百字节，属于缓慢泄漏，不是功能错误，但既然另外两张都清了，这张没清就是疏漏。补一行 `promptHealth.delete(sessionId)`。

验证（临时脚本，构造支持 `on()` 的 fake ctx，先断库造出 3 次失败，再触发 `agent/disposed`）：

```
disposed 前: ✗ prompt 块  memory 连续 3 次（database is not open）
disposed 后: ✓ prompt 块  本轮三块都读到了
```

状态确实被清掉。未把这项写进 `probe-degrade-notice.mjs`：它的 fake ctx `on()` 是空实现，要支持事件触发得改 harness，为一行修复不值当。

**2. 复跑时会看到 SQLite 的 experimental 警告。** 已在第二节开头注明这是警告不是失败。

回归（终版包 + zip 覆盖 + `npm install`）：15 个脚本 + `npm test` 全部 exit 0。

## 十三、v0.2.15：三个「以为有、其实没有」

对照一篇外部记忆架构文章（四层 / 四不变量）自查，再加上写探针时撞见的真缺陷。三处共同点是：文档写着有、代码在跑、产物是空的，而且不报错。

**1. 长期偏好根本召回不到（最严重）**

`compileMatch()` 把用户这句话的每个 CJK bigram 用空格连起来交给 FTS5，而空格在 FTS5 里是隐式 AND。实测：

```
偏好：我不吃香菜，点外卖一定要备注
"香菜"             → 命中
"我不吃香菜"       → 命中
"记得我不吃香菜吗" → 不命中（7 个 bigram 只中 4 个）
"今天天气不错"     → 不命中
```

不命中时 `subjective` 为空 → `blocks` 为空 → 记忆块返回空串。**那一轮模型看到的记忆是空的**，不是少一点。facts / events 有 `pinnedFacts()` 和 `recentFacts(8)` 兜底，偏好一条兜底都没有，所以只有它彻底消失。

修法：`recentPreferences()` + `retrieval.residentPreferences`（默认 3）让最近几条每轮常驻；偏好命中改用 `compileLooseMatch()`（OR 连接）。设 0 回到旧行为。

**2. 主观层的 cap 是块内配额，却拿去比全局 used**

`appendSection` 判断 `used + blockUsed + cost > cap`，`used` 全局累加；但主观层传的 cap 是 `target × 0.25`（=500）。事实区超过 500 token 后，印象和日记整块消失，配置里仍写着启用。

`probe-diary-budget.mjs` 实测（20 条长事实，`maxItems: 40`）：

```
修复前  印象 ✗  日记 ✗  偏好 ✓
修复后  印象 ✓  日记 ✓  偏好 ✓
```

偏好幸存是因为它走 `pushWhole(..., hard)`，用绝对上限。修法：cap 改传绝对位置，并给日记留 `diaryShare`（默认 0.4）保底。

**3. 快照靠用户自觉**

`loom.db` 单文件明文无副本，README 把备份写成用户责任。现在默认每 24 小时 `VACUUM INTO` 一份、保留 7 份、放在库同级 `backups/`，空库不拍。产物自包含，不需要另拷 `-wal`。同盘快照挡不住硬盘故障，文档写明异地备份仍是用户责任。

**另外两件**

- 事实渲染加溯源：`source !== "manual" && confidence < 0.6` 的条目后缀「待确认」，协议解释其含义。此前 `facts` 有 `source` 和 `confidence` 但渲染没用，用户亲口说的和整合推断的看起来一样权威。
- 新增第 11 个工具 `memory_handoff`：五格交接卡，全部原文引用，不改人设不写记忆，「下一步」刻意留空。

**探针**

新增 6 个，共 52 项断言，全部 exit 0：`probe-compaction`(12) / `probe-preference-resident`(7) / `probe-diary-budget`(5) / `probe-backup`(8) / `probe-fact-source`(6) / `probe-handoff`(14)。

回归：selftest 30 项全过；`probe-audit*` / `probe-ceiling` / `probe-config` / `probe-degrade-notice` / `probe-hotload`（断言改为 11 个工具）/ `probe-prompt-guard` / `probe-recall` 与 `scenario-*` 六个场景全部 exit 0。

**未覆盖**

- 快照在真实 DSH 里的首次触发时机（探针用 10 秒维护间隔模拟，真实默认 60 秒）。
- 偏好常驻对长会话预算的实际影响：每条约 15–40 token，默认最多 3 条，属可接受范围，但没有拿真实长会话量过。
- 压缩探针只验证「插件侧状态不受压缩影响」，宿主压缩算法本身不在覆盖范围。

## 十四、v0.2.16：事件块认不出自己

问题不是「缺项目维度」，是「块认不出自己」。同一个人在两段对话里推进同一个项目，插件记成两块互不相干的事件；换个会话之后模型接不上。看起来像缺 `project_id`，实际缺的是块的可辨识与可枚举。

**1. 实测：四块里三块认不出**

本机真实库（`~/.dsh/memory/loom.db`，4 块 / 1 会话 / 4 条事实）：

```
财务·那么，装了这个插件，需不需要考虑上下文崩…     30 字 · 规则兜底
用户想让AI主动追问                                114 字 模型生成
技术·插件我更新了，你去更新一下                    13 字 规则兜底
技术·也就是说，已经撞上了？                        30 字 规则兜底
```

模型路径那一块标题摘要都能用；三块规则兜底是「领域·原句」，摘要就是原句。前缀在同一批块上完全一样，还带错——那段讲插件与上下文预算的对话被判成 `财务`。

**2. 标题取第一句，不取最长句**

第一版取「最长句」，`scenario-merged` 立刻抓到：搜「辞职」期望命中 E1，实际只中 `D1`。E1 第一句含「辞职」，最长句是「她问我在怕什么…」——标题换掉之后关键词从钩子上消失了。改为「第一个 ≥6 字、去掉语气词开头的句子」，语气词表 `那么/但是/不过/所以/然后/对了/其实/也就是说/嗯/啊/诶/哎/哦`，同时剥掉残留的 `用户：`。上限 24 → 32 字符。

模型路径：提示词「标题 ≤12 字」改成「≤16 字」，加一条要求带对象名（项目 / 工具 / 作品 / 人名 / 地点），空标题不再退化成领域名。

**3. 摘要兜底与清单去重**

摘要从「最长两句」改成「首句 + 最长句」。规则路径下标题就是摘要第一句，`标题 —— 摘要` 会说两遍同一句；清单渲染比较公共前缀，超过 12 字只印标题。

**4. 新增第 12 个工具 `memory_episodes`**

只列举不归并：按时间倒序列块（时间 / 类型 / `E` 编号 / 关联事实数 / 标题 / 摘要），支持 `query` 与 `days` 过滤，`limit` 默认 20。跨会话可见。归并留给模型——「这两块是不是同一个项目」是判断，插件做只会做错且无法解释。也不指望 `memory_search` 兼任：FTS 的 match 是二字组隐式 AND，「这个项目我都干过什么」没有关键词可用。

**探针**

新增 `probe-episodes`（18 项，全部通过）：空库不抛错、时间倒序、无领域前缀、两块各带自己的对象名（`loom` / `Blender`）、标题不被摘要重复、`query` 命中相关且排除无关、`days` 过滤、`limit`、跨会话合并、只读不改记忆块。`probe-hotload` 工具数断言改为 12，并加一条「`memory_episodes` 已注册」。

**回归**

selftest 30 项全过；`probe-*` 17 个脚本与 `scenario-*` 六个场景全部 exit 0。中途 `scenario-merged` 的「search 能命中冷区钩子」失败过一次，正是第 2 条描述的退化，改成取第一句后恢复。

**当时未覆盖（下一节补上了第一条）**

- 模型路径下标题是否真的带对象名：前面的探针都跑在规则模式（无 `llm`）上，只能固定提示词与兜底行为。
- 块粒度：当时只写了「可能偏碎」，没有实测。

## 十五、补验：模型路径与块粒度

发布前把 §14 留下的两条未覆盖补上。两条都不改插件代码，只补测试。

**1. 模型路径：假 llm 服务**

此前所有探针都不提供 `llm`，跑的是规则兜底。v0.2.16 改的却是模型提示词（标题 ≤16 字、要求写具体对象）——「提示词写好了」和「模型照做」之间隔着一整条调用链，一行都没被执行过。

`harness.mjs` 加了一个可选的 `llm` 参数（不传时行为与之前完全一致）和一个 `mockLlm(reply)` 工厂：它实现 `listProviders` / `listModels` / `stream` 三个成员，`stream` 推一个 text-delta 再推 `finish(stop)`，正是 `createLlmBridge` 消费的形状。假服务只在探针进程里存在。

`probe-model-title.mjs`（16 项，全部通过）：

| 断言 | 结果 |
| --- | --- |
| 模型路径被调用（不是静默退回规则） | ✓ 1 次抽取 + 1 次冲突判定 |
| 抽取提示词含「具体对象」 | ✓ |
| 抽取提示词含「≤16 字」 | ✓ |
| 模型给的标题被采用 | ✓ `星轨渲染器·glTF 材质丢失` |
| 标题不超 32 字 | ✓ |
| 模型给的摘要被采用 | ✓ 含「相对路径」，不是原句截断 |
| 模型给的事实落库 | ✓ `memory_search` 命中 `· fact ·` |
| 块可按对象名检索 | ✓ `query=星轨` 命中 |
| 记忆块里出现该标题 | ✓ 下一轮就能读到 |
| 空标题退化成句子标题 | ✓ `loom 的 memory_episodes 现在能按天过滤了…`，不是裸领域名 |
| 空标题的块仍可按原文检索 | ✓ |
| 非 JSON 回复退回规则 | ✓ 块仍在，标题含 `Blender` |
| 非 JSON 时对话不中断 | ✓ |
| 模型流抛错时对话不中断 | ✓ 记忆块照常渲染 |
| 模型流抛错时块照样生成 | ✓ |
| 模型流抛错时不写脏事实 | ✓ 假事实文本没落库 |

假服务不等于真模型：它能证明插件把请求发对了、把回包用对了、回包坏了会降级；不能证明真模型一定按提示词写标题。后者是提示词工程问题，只能在真机会话里回看。

**2. 块粒度：先分清是配置还是行为**

第一次测出来是「每轮一块」，6 轮 6 块。查下来不是 `drift`，是探针把 `consolidation.triggerTokens` 设成了 1：`completeTurn()` 的判定是 `tokenCount >= triggerTokens`，设 1 就是每轮整合一次，每次整合只看到 1 轮，自然一块一轮。默认是 20000。

按真实节奏重测（每轮约 17 token，`triggerTokens=80` 让五轮凑成一次整合）：

```
五轮同一项目连续推进（材质缓存）→ 3 块
  E1  我在给星轨渲染器加一个材质缓存…（前 3 轮）
  E2  缓存键用文件路径加修改时间应该够（第 4 轮）
  E3  先只缓存颜色贴图，法线贴图以后再说（第 5 轮）
单条消息里混三个话题（缓存 / 配色 / 下雨）→ 1 块
两条消息同一话题 → 各 1 块（同样是 triggerTokens 造成的）
```

结论：同一次整合里，前 3 轮被合并，第 4 轮「缓存键」和第 5 轮「只缓存颜色贴图」各成一块——段内 `drift`（`microTopicJaccard=0.3`）确实在切，切点停在「同一件事的不同侧面」。单条消息内部不切，混三个话题也是一块。

对这个需求（让 AI 或用户按块归拢项目）来说，碎不是缺陷：块越小，标题越具体，越容易认领。代价是清单更长、prompt 里「我们一起经历过」更早被同项目的碎片占满。本次不改阈值，理由是改大之后同一块会混进多个话题，标题又变回含糊——那正是 v0.2.16 要修的问题。真要调，`segmentation.microTopicJaccard` 是唯一的旋钮。
