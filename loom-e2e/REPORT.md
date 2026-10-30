# 端到端测试报告

对象：`dsh-memory-loom@0.2.12`（融合后的单包，含钩子索引层）
方式：跑**真实的插件 bundle**（`../lib/index.js`），不是模拟。

> 这份报告随 npm 包发布（`loom-e2e/REPORT.md`），但**下面引用的 `harness.mjs` / `scenario-*.mjs` / `probe-*.mjs` 只存在于仓库的 `loom-e2e/` 目录，不在安装包里**——它们需要一个能解析 `@deepseek-ai/*` 的 Node 环境，安装位置没有。想复跑请 clone 仓库后 `npm install`。

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

```bash
npm install                 # 先装 peer/dev 依赖（仓库根）
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
cd .. && npm test           # 钩子索引自测，30 项
```

当前全部通过（work 18 + limit 17 + merged 24 + l0cap 15 + diary 17 + selftest 30 = **121 项断言**，另有六个探针脚本全绿，退出码均为 0）。

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
| 装好的包里跑 e2e | 把 `loom-e2e/` 拷进 `node_modules/dsh-memory-loom/` | work 18 + merged 24 + limit 17 + l0cap 15 + diary 17 + probe-config 全过 |

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
| 装好的包里 `npm test` 报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-tools` | DSH 的 pnpm 不安装 peer（`+6` 而不是 `+25`），运行时靠宿主解析，裸 `node` 进程没有这条解析路径 | `test/selftest.mjs` 改为捕获该错误并打印「回仓库跑」，不再甩堆栈 |
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
