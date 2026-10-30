# dsh-memory-loom

# DSH 记忆插件 (dsh-memory-loom)

> ⚠️ **项目状态：早期测试版 (Early Alpha) / 求各位帮忙踩坑**
> 
> 这是我用 AI 辅助开发的 DSH 记忆插件。我个人的初步测试已经通过，但我深知 AI 写的代码在**极端情况下**可能会有我考虑不到的漏洞。
> 
> 所以，我把它开源出来，**非常需要正在使用 DSH 的朋友帮我实测！** 
> 
> 🙏 **我想请你帮我测什么？**
> 1. 在实际聊天中，记忆的提取和召回效果到底怎样？是否真的达到了“长久记忆”的目的？
> 2. 有没有什么**极端输入**（比如超长文本、特殊符号、乱码）会导致插件崩溃或报错？
> 3. 长期挂机运行，会不会导致内存泄漏、Token 消耗异常飙升（怕我的大肥鱼被吃穷）？
> 
> 🐛 **如何反馈？**
> 如果你遇到了报错、崩溃，或者有任何关于极端情况的测试结果，请直接在这个仓库的 **Issues** 区告诉我。提供你的报错日志或复现步骤，感激不尽！

---

（以下是原 README 的详细说明文档）

给 DeepSeek Harness 的长期记忆插件：把对话沉淀成**四层记忆 + 主观层 + 人设卡**，全部存在一个本地 SQLite 文件里。**v0.2.0 起内置钩子索引层**：上下文里只放每条约 15 token 的"钩子"，完整正文留在库里按需取回。

- **L0** 原始对话（只追加，不按时间清理）
- **L1** 原子事实（带类型、主题域、TTL、情绪显著度）
- **L2** 事件摘要（按话题与情绪切分出的「一段经历」）
- **L3** 自我叙事（助手对自己的长期叙述）
- **主观层** 印象、日记、隔离的长期偏好
- **人设卡** 分区、可锁定、用户/助手按来源分权
- **钩子索引**（v0.2.0）记忆块的指针版：`- E37 要不要辞职的长谈 2.7k字`，背后是几千字完整叙事，`memory_expand` 按需取回
- **原文不裁剪**（v0.2.1）单条消息整条落库，贴多长的日志、代码、报错都不丢尾巴

不依赖任何在线服务：中文检索用 CJK 二元分词 + SQLite FTS5，衰减、切分、冲突判断都有确定性规则版本。**没有可用模型时插件照常工作**，只是抽取与判断走规则，L0 仍然完整积累。

---

## 1. 它解决什么问题

多数「记忆插件」只做两件事：把对话塞进向量库，检索时贴回来。后果是记忆越来越多、越来越像、越来越不可解释。

这个插件按「人会怎么记」来设计：

| 问题         | 做法                                            |
| ---------- | --------------------------------------------- |
| 什么值得记      | 只抽稳定信息（偏好、身份、关系、计划、经历、长期要求）；寒暄与工具输出不记         |
| 记多久        | 双曲衰减 `base·(1+t/S)^(−d)`；被检索到会提升稳定性 S，而不是重置时间 |
| 过期了怎么办     | 软失效：不删除，只连续降权（半衰期 45 天，地板 0.02）               |
| 旧事实与新说法冲突  | 写入时 supersede；检索时再标「可能已过时」并降权；当前对话永远优先        |
| 一段对话是什么    | 按时间间隔、话题偏移、情绪尖峰切段，段内再按微观话题细切                  |
| 该怎么读记忆     | 事实用表格行、主观层用自然语言；事实在前、主观在后，紧挨对话                |
| 不同人之间      | 主人 / 朋友 / 路人的权限梯度；记忆按人隔离；路人 48 小时后删原始对话       |
| 上下文装不下所有记忆 | **钩子索引**：常驻 prompt 只放快照化的钩子清单，正文顺指针取回（见 §6）   |

---

## 2. 安装

要求 Node `^22.19.0 || >=24`（使用内置 `node:sqlite`，无原生编译）。

### 方式一：DSH 里一键安装（推荐）

打开 DSH → **插件** → **添加插件**，在输入框里填其中一个：

- **GitHub 仓库地址**：`https://github.com/lingou-shao/dsh-memory-loom`
- **本地目录路径**：先把仓库 clone 到本地，然后填目录路径

点「安装」即可。包内 `package.json` 声明了 `dsh.bundle.patch`，DSH 组合 profile 时自动叠加，无需手改配置；数据库默认落在 `$DSH_HOME/memory/loom.db`。

### 方式二：tarball

```bash
npm install ./dsh-memory-loom-0.2.9.tgz
```

### 方式三：手动挂载

把包放进 profile 的 `node_modules`（或 `$DSH_HOME/profiles/node_modules`），并在 profile 的 bundle 列表里加入 `dsh-memory-loom`。`cordis.patch.yml`（包内自带）会被组合器读取：

```yaml
- insert:
    - id: memory-loom
      name: dsh-memory-loom
      config:
        path: !!js dshHomePath('memory', 'loom.db')
```

`path` 是必填项：对话的长期记录不应该落在「启动目录」里。临时试用可以设成 `:memory:`。

### 本地开发

```bash
git clone https://github.com/lingou-shao/dsh-memory-loom
cd dsh-memory-loom
npm install        # 安装 peer/dev 依赖
npm test           # 钩子索引自测，30 项（node test/selftest.mjs）
```

仓库直接以构建产物发布（`lib/index.js` 即完整插件），没有独立的源码目录和构建步骤；`npm run build` / `typecheck` 已随 v0.2.5 移除。改动后的验证方式是 `npm test` 加上仓库外脚手架里的端到端场景。

---

## 3. 配置

全部字段都有默认值，只有 `path` 必填。

| 字段                                                        | 默认                                             | 说明                            |
| --------------------------------------------------------- | ---------------------------------------------- | ----------------------------- |
| `path`                                                    | —                                              | SQLite 文件路径，或 `:memory:`      |
| `ownerName`                                               | `主人`                                           | master 身份的称呼，用在事件抽取提示与「关系印象」里 |
| `locale`                                                  | `zh`                                           | 记忆块语言（`zh` / `en`）            |
| `timezone`                                                | 空                                              | IANA 时区；空表示用宿主时区              |
| `capture`                                                 | `true`                                         | 是否把每轮对话写入 L0                  |
| `l0.maxCharsPerMessage`                                   | `0`                                            | 单条消息存储上限。`0` = 全文落库，一个字不丢（v0.2.1 已修改：0.2.0 及以前硬编码 8000 字静默截断） |
| `maintenanceIntervalSeconds`                              | `60`                                           | 后台维护与整合检查间隔                   |
| `consolidation.enabled`                                   | `true`                                         | 关掉后**完全不整合**：不产生事件与事实，也不再调模型；原始对话照旧落 L0、`T` 尾巴照旧可见。省额度用这个（v0.2.7 已修复：此前该开关不生效，设 `false` 仍会整合） |
| `consolidation.provider` / `.model`                       | 空                                              | 整合调用的路由；空表示沿用会话最近一次请求的路由      |
| `consolidation.triggerTokens`                             | `20000`                                        | 单会话累计到多少 token 触发整合           |
| `consolidation.idleMinutes`                               | `5`                                            | 空闲多久视为可以整合                    |
| `consolidation.maxRunSeconds`                             | `180`                                          | 单次整合总时长上限                     |
| `consolidation.itemTimeoutSeconds`                        | `30`                                           | 单条模型调用超时                      |
| `consolidation.dailyLlmCalls`                             | `200`                                          | 每用户每日模型调用上限                   |
| `consolidation.sampleK` / `.sampleM`                      | `20` / `100`                                   | 动态段长 N 的滑动窗口与样本充分阈值           |
| `consolidation.coldStartFacts`                            | `50`                                           | 事实数低于此值用保守参数                  |
| `consolidation.diaryPerDay`                               | `3`                                            | 每天最多日记条数                      |
| `consolidation.narrativeEvidence`                         | `12`                                           | 新证据累积到多少重写自我叙事                |
| `consolidation.retries` / `.dlqItems` / `.dlqDays`        | `2` / `20` / `7`                               | 单条重试次数与死信队列阈值                 |
| `segmentation.gapMinutes`                                 | `30`                                           | 超过这个间隔硬切                      |
| `segmentation.hardTopicJaccard`                           | `0.12`                                         | 话题相似度低于此值且主题域变化时硬切            |
| `segmentation.softSalience` / `.softDelta`                | `0.70` / `0.25`                                | 情绪尖峰软切                        |
| `segmentation.microTopicJaccard` / `.microSalience`       | `0.30` / `0.55`                                | 二级（微观）切分                      |
| `segmentation.minSecondary`                               | `5`                                            | 动态段长 N 的下限                    |
| `decay.d`                                                 | `1`                                            | 双曲衰减指数                        |
| `decay.sInitial`                                          | `30`                                           | 初始稳定性（天）                      |
| `decay.sMaxMultiplier`                                    | `50`                                           | 稳定性上限 = 初始 × 50               |
| `decay.floor`                                             | `0.02`                                         | 分数地板                          |
| `decay.retrievalBoost`                                    | `0.25`                                         | 每次被检索到时的稳定性增益                 |
| `decay.expiryHalfLifeDays`                                | `45`                                           | 软失效后的降权半衰期                    |
| `emotion.l1Weight`                                        | `0.5`                                          | 事实的情绪加权权重                     |
| `emotion.subjectiveWeight`                                | `1`                                            | 主观层/事件的情绪加权权重                 |
| `emotion.boost`                                           | `0.18`                                         | 情绪项系数                         |
| `retrieval.budgetTokens`                                  | `2000`                                         | 记忆块软目标                        |
| `retrieval.hardCapTokens`                                 | `3000`                                         | 单轮硬上限                         |
| `retrieval.subjectiveShare`                               | `0.25`                                         | 主观层配额占比                       |
| `retrieval.maxItems`                                      | `20`                                           | 条目数上限                         |
| `retrieval.minScore`                                      | `0.05`                                         | 低于此分不注入                       |
| `retrieval.conflictPenalty`                               | `0.85`                                         | 「可能已过时」的乘数                    |
| `retrieval.toneHint`                                      | `true`                                         | 事件行后是否标注当时的语气（Q64，v0.2.9 新增）。只标注不中性的情绪，一条约 3 token |
| `retrieval.layerPenalty.*`                                | `fact 0 / event .04 / subjective .02 / l0 .15` | 层级成本惩罚                        |
| `diary.mirror`                                            | `true`                                         | 是否把日记导出成人能直接读的 Markdown（Q63，v0.2.9 新增） |
| `diary.mirrorDir`                                         | `diary`                                        | 镜像目录。相对路径按**数据库所在目录**解析，不写死任何绝对路径 |
| `diary.mirrorDays`                                        | `14`                                           | 启动时重写最近多少个「有日记的日子」                |
| `roles.visitorPurgeHours`                                 | `48`                                           | 路人原始对话保留时长                    |
| `roles.pendingDeleteDays`                                 | `7`                                            | 删除冷静期                         |
| `roles.promotionVisits` / `.demotionDays`                 | `3` / `5`                                      | 路人转朋友 / 朋友回落                  |
| `privacy.masterCrossIdentity`                             | `true`                                         | 主人能否跨用户查询（仅 L1/L2）            |
| `prompt.personaOrder` / `.memoryOrder` / `.protocolOrder` | `10` / `900` / `930`                           | 三个 prompt 贡献的排序               |
| `prompt.indexOrder`                                       | `895`                                          | 钩子索引块的排序（在记忆块之前）              |
| `index.hooksBudgetTokens`                                 | `300`                                          | 钩子索引块的 token 软上限              |
| `index.maxHooks`                                          | `16`                                           | 驻留钩子条数硬上限                     |
| `index.minHookScore`                                      | `0.3`                                          | 低于此分的钩子不占位                    |
| `index.expandBudgetTokens`                                | `4000`                                         | `memory_expand` 单次返回上限，超出自动分页（v0.2.3 已调整：由 2600 上调） |
| `index.maxCharsPerPack`                                   | `60000`                                        | `memory_pack` 单篇上限            |
| `index.rebuildMinutes`                                    | `5`                                            | 驻留快照重算间隔，`0` 关闭               |
| `index.coldDays`                                          | `7`                                            | 被淘汰钩子的冷区时长                    |
| `index.includeAssistant`                                  | `true`                                         | 取回正文是否包含助手自己的话                |

---

## 4. 模型工具

插件注册九个工具，模型自己决定何时调用。

| 工具                | 参数                                                                  | 作用                                                                       |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `memory_search`   | `query`*, `identity`, `limit`                                       | 搜事实与事件（FTS5，不受索引候选池限制）。每条结果带 `#E12` / `#F7` 编号，可直接交给 `memory_expand`（v0.2.4 已修改：此前返回裸 `#12`，两个 id 空间同号会撞，得靠行内类型猜前缀）。`identity` 仅主人可用，且只返回可公开的对方事实 |
| `memory_write`    | `text`*, `kind`, `pinned`, `tags`                                   | 手动记一条。`kind=instruction` 进入隔离的长期偏好区；重复会合并，冲突会取代旧事实                       |
| `memory_forget`   | `id`*, `permanent`                                                  | 默认软删除（冷静期内可恢复），`permanent=true` 立即彻底删除                                   |
| `memory_profile`  | —                                                                   | 人设卡、自我叙述、对他的印象与各类计数；**并打印日记目录**，那是用户读日记的入口（v0.2.9 已新增）           |
| `memory_persona`  | `action`*, `zone`, `text`, `confirm`, `overlay`                     | 查看/修改人设卡。只有主人能改；锁定区需要 `confirm`；`overlay` 只对当前人生效                        |
| `memory_identity` | `action`*, `name`, `evidence`, `claimId`, `identityId`, `keepFacts` | `show` / `export` 人人可用；`list`、`claim`、`approve`、`reject`、`erase` 仅主人     |
| `memory_expand`   | `ref`*, `offset`                                                    | 按编号取正文：`E` 事件 / `F` 事实上下文 / `D` 整理版 / `T` 最近未整理。超预算自动分页并给出续读指令           |
| `memory_pack`     | `title`*, `text`*, `ref`                                            | 把整理好的叙事单独存为 `D` 并挂到钩子上，之后取回优先返回整理版。`T` 拒绝挂载（滚动区间挂不住固定正文）                 |
| `memory_index`    | `action`*, `query`, `ref`                                           | `view` 常驻钩子 / `search` 全量（含冷区）/ `promote` 置顶 / `rebuild` 重建 / `gc` 清孤儿正文 |

*`*` 表示必填。*

`memory_identity` 的 `action`：

- `show` 当前身份、会话、时区
- `export` 导出记忆 JSON（自己；主人可指定 `identityId`）
- `list` 所有身份
- `claim` 朋友自报身份，进入待审
- `approve` / `reject` 主人裁决（通过则合并到同名朋友，或直接转正）
- `erase` 按用户要求清除：路人立即删，朋友走 7 天冷静期

---

## 5. 运行时行为

### 捕获

`session/event` 上的 `user/message` 与 `assistant/message` 同步写入 L0。只收 `source.kind === 'user'` 的真实用户输入，工具注入、系统提示、子智能体消息都不算。写入前脱敏（私钥、API key、Bearer、密码赋值、手机号、身份证、银行卡）。

**整条消息原样落库**，默认没有长度上限。要压体积就设 `l0.maxCharsPerMessage`：超限时会截断，并把截断原因和原文长度写进正文（`…[已截断：原消息 40000 字，仅保留前 32000 字]`），不会让模型把半截日志当成完整日志读。脱敏先于截断执行——密钥不会因为被截断而漏存。

> v0.2.1 已修改：0.1.x–0.2.0 在这里硬编码 `clip(..., 8000)`，超出部分静默丢弃，既不报错也不可配置。详见 `docs/design.md` §10。

`request/context` 用来记住会话的 provider/model，整合调用默认沿用这条路由。

### 整合

`agent/turn-stopping` 收尾本轮并计数；命中「累计 token 超阈值」时在后台启动整合，**不阻塞用户**。另有一个 60 秒的后台循环，处理空闲会话、访问回写、软失效、路人清理、冷静期到期删除与每月去重扫描。

一次整合最多两次模型调用：先抽取事实与摘要，再一次完成「去重 / 更新 / 矛盾 / 显著度 / TTL」四项判断。解析失败按规则兜底并记死信。没有模型时全程规则，`report.degraded` 保持 `false`——规则模式是受支持的部署形态。

### 注入位置（Q65）

```
系统提示
  ├─ …（宿主自己的 section）
  ├─ memory-loom:persona:<session>   人设卡（section，常量协议之外唯一的静态块）
  ├─ memory-loom:protocol            记忆使用约定（全局 section）
  └─ memory-loom:index-protocol      记忆索引使用约定（全局 section）
动态上下文
  ├─ memory-loom:hooks:<session>     钩子索引块（context，在记忆块之前）
  └─ memory-loom:memory:<session>    记忆块（context，落在对话之前）
对话历史
```

记忆块内部：事实 → 事件 → 印象 → 日记 → 自我叙事 → 长期偏好 → 原文下钻片段。软目标 2000 token，硬上限 3000，主观层独占约 25%。

人设卡独立成 section 这件事属于 Q65 的落地：它不跟事实抢预算，也不随召回结果变化。

> **Q64 在 v0.2.9 收口（原文写「语气分离注入」）**：当时的设想是给语气单开一条注入通道，再加一套离线评估。实际结论是——只要模型在读记忆时能看见「这话当时是什么口气」就够了，不需要独立通道。现在语气以 `（语气偏冲）` 这样的短标注跟在事件行后面，见下面的「语气」小节。

两个 prompt 贡献都设了 `interpolate: false`：用户写进人设或事实里的 `{{...}}` 是字面文本，不会被当成模板变量。

### 冲突（Q66，用户确认版）

协议里固定一条规则：**当前对话永远优先于记忆块**。此外做一次确定性检测——候选事实与当前这句话共享足够词汇（containment ≥ 0.45 且 ≥3 个共同 token），却在否定词或数字上不一致时，标「可能已过时」并乘 0.85。不额外调用模型。

### 语气（Q64，v0.2.9 定稿）

整合时每个事件已经存了 `valence`（正负）与 `arousal`（强度）。渲染时用一个纯函数把它们折成一句话，附在事件行尾部，**只在情绪不中性时才出现**：

```
【我们一起经历过】
- [10-30] 为辞职吵起来的那次：说到加班时声音变高，明显不高兴。（语气偏冲）
- [10-30] 她夸我那次：聊到最后心情不错。（语气愉快）
- [10-30] 问天气：问了明天的天气，语气平常。          ← 中性，不加标注
```

- **只影响“读到的语气”，不影响排序**：打分仍然只看相似度、衰减、salience。
- **不额外调模型**：用的是已经落库的两个数，`memory_search` 的结果里同样带。
- **成本**：每条被标注的事件约 +3 token；中性事件 0。实测两条情绪事件让记忆块从 59 → 65 token。
- **可以关**：`retrieval.toneHint: false`。
- **不声称准确**：语气标签是阈值映射，不是判断模型。离线评估没有做，也不打算做——这正是 Q64 被缩小掉的那一半。

### 日记：不给权重，给一个能看的文件（Q63，v0.2.9 定稿）

日记是唯一「写给助手自己」的层。原来的设计里它按 `weight`（情绪 salience）参与叙事触发，后来发现：**日记按权重加进去也不会让人更愿意看它，反而让「谁更重要」这件事被一个拍出来的系数绑住**。所以定稿是——

- **不加权**：日记不参与事实/事件的排序，也不计入叙事证据（`narrativeEvidence()` 只数事件）。
- **给入口**：每天一个 Markdown 文件，导出到数据库旁边的 `diary/` 目录，任何文件管理器点开就能读：

```
~/.dsh/memory/loom.db        ← 数据库（默认 path）
~/.dsh/memory/diary/
  2026-10-29.md
  2026-10-30.md
```

文件长这样（按人分组，只读镜像，写入以数据库为准）：

```markdown
# 日记 2026-10-29

## 主人

- 15:23 今天她把辞职的事说到底了，我怕的其实不是钱。

> 由 memory-loom 从 diary 表导出，只读镜像；以数据库为准。
```

导出时机：插件加载时回写最近 `diary.mirrorDays`（默认 14）天，之后每次维护 tick 检查最近两天，只在内容变了（条数或时间戳变了）才重写。目录写不进去不会影响主流程——条照旧进数据库，每 tick 重试一次，日志里给一条 warn。`memory_profile` 会打印这个目录的绝对路径，那就是用户找日记的入口。

---

## 6. 钩子索引（v0.2.0 新增）

记忆块是"渲染出来的摘要"，钩子索引是"指向正文的指针清单"。两者并存：记忆块负责日常氛围与事实，索引负责**任何一段经历的完整叙事都可回溯**。

索引块的真实样子（约 60 token）：

```
【记忆索引】只有钩子，细节用 memory_expand(ref) 取；不要仅凭钩子断言具体内容。
- T 最近未整理 · 4轮 304字
- E1 技术·线上那个 Node 服务… 415字
- E2 其他·改完了，把 handle… 390字
- E3 其他·我用 pandas 读一… 329字
```

三条设计原则：

1. **驻留快照，不是每轮重排。** 常驻钩子集合是落盘快照（`loom_hooks.resident`），只在定时器（`index.rebuildMinutes`）、`memory_pack` 之后、显式 `rebuild` 时重算。渲染只读快照——同一段记忆在轮次之间逐字稳定，这是刻意防人格漂移：漂移的根因不是上下文长，而是注入内容每轮都在变。
2. **淘汰钩子，绝不压缩正文。** 超预算时低分钩子进冷区（`index.coldDays`，默认 7 天，不回抖），而不是花模型调用去摘要压缩。正文一直在 `l0` 里，冷区钩子仍可用 `memory_index search` 命中、直接 `memory_expand` 取回。
3. **软上限双保险。** token 预算 + 条数硬顶；低于 `index.minHookScore` 的候选直接不占位——空位比坏钩子便宜。同名近重复事件只留最高分。

实测（端到端，跑真实 bundle，79 项断言全过）：

| 场景                     | 记忆块                      | 索引块                              |
| ---------------------- | ------------------------ | -------------------------------- |
| 两条工作会话（写代码 + 表格）同时活跃   | 504 token                | **65 token**                     |
| 60 轮 + 41 条事实 + 40 段事件 | 407 token / 13 行（超限静默丢弃；索引块只是旁路兜底，没有改变记忆块自身行为） | **137 token / 10 条钩子，任意一条可展开全文** |

遗忘级联：`memory_forget` / `erase` 删除素材后，`memory_expand` 拒绝返回对应正文，`memory_index gc` 清理孤儿整理版；重建时会自动清掉已失效的驻留钩子。

从 0.1.x 升级：无需迁移。索引表（`loom_docs` / `loom_links` / `loom_hooks`）在启动时自动创建，已有 `loom.db` 直接可用；曾经单独安装 `dsh-memory-loom-index` 的，把两个插件换成这一个即可。

### v0.2.1：取消单条消息长度限制

0.1.x–0.2.0 在捕获层硬编码 `clip(..., 8000)`，超过就静默丢尾巴——贴长日志、贴大段代码时，被截掉的部分连自己都不知道。现在改为：

- **默认整条落库**，没有隐式上限。
- 想要体积可控就设 `l0.maxCharsPerMessage`；截断时会写明原文长度并提示调大配置，不让模型误读半截内容。
- 超长行不再写 `l0.tokens`（该列从无读取方，只是正文的 1.6 倍副本），所以放开上限后库体积只增长约 1.14 倍于正文本身。

实测：单条 5.2 万字写入耗时 79 ms，`memory_expand` 5 页读完。旧库无需迁移。

### v0.2.2：分页切片不再浪费预算

`sliceByTokens` 原先用固定 `budget / 0.65` 推算每页字符数（0.65 是中文的 token/字 比率，最坏情况），而收缩循环只能往下调、不能往上补。于是英文日志和代码（约 0.26 token/字）每页只用到预算的 **38%**，页数凭空翻倍。

现在先采样正文前 2000 字，用这段文本自己的比率推算。5 万字英文日志从 **14 页降到 5 页**，中文叙事从 14 页降到 12 页（中文本来就在 0.65 附近，只吃掉了浪费）。

分页成本是平方级的——第 k 页要把前 k−1 页重发一遍，所以「少一页」比「小一页」值钱。本地开销（SQL + 切片）实测 4–18 ms，可以忽略；时间全在往返次数上。

### v0.2.3：单页预算 2600 → 4000

5 万字正文在四档预算下的实测（累积输入 = 分页重发后的总 token 消耗）：

| 正文 | 2600 | 4000（默认） | 8000 | 12000 |
|---|---|---|---|---|
| 中文叙事 5 万字 | 12 页 / 24s / 189.6k | **8 页 / 16s / 128.3k** | 4 页 / 8s / 71.8k | 3 页 / 6s / 53.8k |
| 英文日志 5 万字 | 5 页 / 10s / 37.3k | **4 页 / 8s / 26.5k** | 2 页 / 4s / 17.1k | 2 页 / 4s / 13.1k |

从 2600 提到 4000，往返次数少三分之一，总消耗降到 68%；再往上收益递减，但单页把上下文占得更满、也更容易挤掉正在用的东西。4000 是拐点。

同版补了 §7 的备份提醒（要备哪些文件、在哪、怎么恢复），并把「48 小时兜底被空闲触发替代」的理由写清（`docs/design.md` §7.2）。

### v0.2.4：`memory_search` 返回可直接使用的编号

旧版返回 `(#1234)`，但 `memory_expand` 要的是 `E1234` / `F1234`。而 `events.id` 与 `facts.id` 是两张表各自自增，**同一个数字可能既是 E12 又是 F12**——模型得先看行里的 `· event ·` 再映射前缀，撞号时会取错表。

现在直接返回 `#E12` / `#F7`，可原样喂给 `memory_expand`。这是「钩子看不见、靠检索找回」那条通道的最后一公里：FTS5 命中的老事件不必再猜编号前缀。

顺带实测了上限这一层（`docs/design.md` §9.6 已更新）：

| 项 | 数字 | 结论 |
|---|---|---|
| 取回成本 vs 钩子数 | 0.040 ms（16 条）/ 0.037 ms（64 条） | 解耦，扩上限不会让每次回看变贵 |
| 索引块每轮 | 16 条 124 token；64 条 422 token | 只有这项随上限线性涨 |
| rebuild（封顶 300） | 恒定 ~118 ms | 保护有效 |
| rebuild（不封顶，3000 事件） | 1248 ms 同步阻塞 | 扩候选池的真实代价 |

**结论：不扩 `maxHooks`、不扩候选池。** 前者的成本落在每一轮，后者会阻塞事件循环，而收益都被「只有 16 条能进 prompt」这条上限吃掉。

### v0.2.5：发布就绪

为「在 DSH 里填 GitHub 地址直接安装」做的清理，其中两个是会让安装直接失败的雷：

1. **删掉 `prepare: tsdown`。** `prepare` 在包被 `npm install` 时执行，而 devDependencies 此时不会安装，tsdown 不存在 → 整个安装失败。包以预构建的 `lib/` 发布，本就不需要构建步骤。
2. **删掉 `vitest run`。** 仓库里从来没有 vitest 测试文件，`npm test` 必失败。现在 `npm test` 就是钩子索引自测（v0.2.5 时 29 项，v0.2.9 为 30 项）。
3. `memory_index search` 的关键词转义 `LIKE` 通配符：以前搜 `%` 会匹配一切。
4. `loom-e2e/` 入仓（端到端场景 + 三个探针脚本），import 直接指向 `../lib/index.js`，不再依赖 vendor 副本；测试报告重写为当前形态（`loom-e2e/REPORT.md`；v0.2.5 时 103 项断言，v0.2.9 为 121 项）。
5. README 安装节重写：方式一是 DSH 插件页填 GitHub 地址或本地目录路径。

### v0.2.6：开源前脱敏

对「准备公开仓库」这件事做的清理，功能零改动：

1. **`loom-e2e/` 里 9 处硬编码的 Windows 绝对路径**（含本机用户名）改成 `fileURLToPath(new URL('./tmp-xxx.db', import.meta.url))`，换机器、换系统都能跑。
2. **README 两处 `<你的用户名>` 占位符**填成实际仓库地址。
3. 新增 **`.env.example`**：明确写清本插件不需要任何密钥，只列 `DSH_HOME` / `LOOM_DB_PATH` / `LOOM_BUNDLE` 三个可选变量。
4. **`.gitignore` 重写**：覆盖环境变量、各类本地数据库、日志、缓存、Python 产物、编辑器与系统杂项。
5. README §7 新增「安全事实（可自行复核）」表：每条结论都附一条能自己跑的 `grep` 命令，包括「插件不持凭据、不外联、无遥测、只写一个文件、落盘前脱敏」。
6. README §9 目录按实际仓库形态重写——原文写的是并不存在的 `src/*.ts`，会误导贡献者。

### v0.2.7：逐行审计修掉的四个真 bug

不带新功能，只修「文档说做到、代码其实没做」的地方：

1. **`consolidation.enabled: false` 之前完全无效。** schema 里有这个开关、README 也在宣传，但全文件没有任何地方读取它——关掉之后照样整合、照样调模型。现在 `tick()` 会整个跳过整合阶段（`maintain`、`T` 尾巴、钩子索引都不受影响），并且把 `enabled` 转发进引擎配置。要省 API 额度，这是正确的开关。
2. **分页会把 emoji 劈成两半。** `sliceByTokens` 按 UTF-16 码元切，正好落在代理对中间时，模型收到的是半个字符（渲染成 `�`），下一页开头又是一个孤立的低代理。现在 `safeCut()` 会把切点退到代理对边界外。实测 9 页里 0 页出现孤立代理。
3. **`memory_pack` 能挂到不存在的编号上。** 传 `ref="E9999"` 时，回执说「已挂到 E9999」，但这个编号根本不存在——之后 `memory_expand` 只会告诉你"已被删除"，这份正文永远取不回来。现在先校验编号是否真的存在，不存在就不建链接、并如实说明；正文仍然作为独立 `D` 条目可取。

4. **路径里有空格或中文时 `npm test` 直接崩。** `test/selftest.mjs` 用 `new URL(...).pathname` 取路径，这个值在 Windows 上带前导斜杠、而且是**百分号编码**的——目录名一旦有空格或汉字，读到的是 `tmp%20%E5%88%AB...`，`readFileSync` 直接 ENOENT。这是"别人的电脑"上最常见的失败：很多人的用户名或项目目录就是中文。现已全部换成 `fileURLToPath`（`test/selftest.mjs` 与两个探针各一处）。

另外三处小修：`sliceByTokens` 传负 offset 时 `done` 算错（返回 `done:false` 却已经给了全文，导出的 API，工具层自己夹紧了所以没暴露）；`memory_expand` 的工具描述把「4000 token」写死，改了 `expandBudgetTokens` 后文案会失真，现在按实际配置生成；`migrate()` 的两个分支代码完全相同（死代码），合并成一条并且只向前打版本号。

还有一处**为别人的电脑**加的容错：`PRAGMA journal_mode = WAL` 在网络盘、部分 FUSE 挂载和部分企业漫游家目录上会抛错，原来这一抛就整个 profile 起不来。现在降级到 `DELETE` 日志模式继续跑——慢一点，但能活。

### v0.2.8：文档标注与未解决清单（无代码变更）

只改文档，不改行为：

1. 本文里凡是「已被后续版本修复/调整」的地方，都在原处补了 `vX 已修复` / `vX 已修改` / `vX 已调整` 标记，并给出对应章节。此前读者看到 §5 的旧行为描述，无法分辨那是现状还是历史。
2. `docs/design.md` 顶部加「阅读约定」，明确它是时间累加文档、前文可能被后文推翻；凡前文问题在后文解决，原处标 `→ 已解决` / `→ 已修正` 并指向章节。
3. `docs/design.md` 新增 **§13 未解决问题清单**：把 Q63（日记未计权）、Q64（语气注入未评估）、Q39（评估集）以及其余挂起项、已知缺陷收成一张盘点表，每条写清现状、代价、为什么不修。以前这些问题散在 §5 表格的 `◐`/`○` 与 §7 偏差里，读者要自己拼。
4. §8 已知边界补三行（Q63 / Q64 / Q39），并说明当前测试衡量的是「机制正确性」而不是「记忆质量」。

### v0.2.9：日记给入口、语气给标注、删掉一个死列

三件都是「决定不做大改动，但把该给的东西给到位」：

1. **日记导出为人能读的 Markdown（Q63 定稿）。** 日记不加权——它不进排序、不计入叙事证据。取而代之的是每天一个文件，落在数据库旁边的 `diary/` 目录（相对 `path` 解析，不写死绝对路径）：加载时回写最近 14 天，之后每次 tick 只在内容变了才重写。目录不可写不影响主流程，条照旧进库并每 tick 重试。`memory_profile` 会打印这个目录，那就是入口。
2. **事件行尾标注当时的语气（Q64 收口）。** 用整合时已经存下的 `valence`/`arousal` 折成一句「（语气偏冲）」，只在情绪不中性时出现，记忆块与 `memory_search` 都带；每条约 +3 token，`retrieval.toneHint: false` 可关。**不再做「语气分离注入」**，也不做离线评估。
3. **删掉 `diary.weight` 死列（顺手清掉 `mood`）。** 这一列写入的是 `emotion.salience`，`recentDiary()` 也映射了出来，但下游没有任何一处读它——评分用固定的 `similarity: .35`，渲染用固定的 `base: .7`。一个永远不生效的列只会让下一个人以为它在起作用，所以直接删表定义。老库里的列会留着（有默认值，插入不写它），读写都正常，无需迁移。
4. `memory_profile` 的日记计数以前是 `recentDiary(…, 20).length`，超过 20 篇永远显示 20——现在是真总数。

---

## 7. 隐私与数据权利

- **按人隔离**：事实、事件、印象、日记、偏好都带 `identity_id`；路人默认不可被跨用户查询，只有 `evidence.public === true` 才放行。
- **主人跨用户查询只有 L1/L2**：拿不到 L0 逐字内容。
- **删除**：`memory_forget` 软删除 → 冷静期 → 硬删；`memory_identity erase` 按角色处理；路人原始对话到期自动清除，事实保留但降权。
- **导出**：`memory_identity export` 给出 JSON；`engine.exportData` 是同一份数据。
- **审计**：每次写入、修改、删除、整合都进 `audit` 表；`traces` 只保留 14 天。
- **备份是用户的责任**（Q59）：插件不做对象存储备份，也不上传任何东西。

### 安全事实（可自行复核）

这一节不是承诺，是可以一条命令验证的事实：

| 问题 | 事实 | 怎么自己查 |
| --- | --- | --- |
| 插件是否持有 API Key / Token？ | **没有。** 源码里不存在任何凭据常量 | `grep -nE "api[_-]?key\|secret\|password\|bearer" lib/index.js` → 只命中**脱敏正则**与情绪词表，无凭据值 |
| 是否会外联？ | **不会。** 没有任何 `fetch` / `node:http` / `node:https` / `WebSocket` / 原生 socket 调用 | `grep -nE "fetch\(\|node:http\|node:https\|WebSocket" lib/index.js` → 无输出 |
| 是否有遥测 / 上报？ | **没有。** 不加载任何统计 SDK，全文不含 `http` 字样 | `grep -n "http" lib/index.js` → 无输出 |
| 会写磁盘的哪些位置？ | **只有你配置的那一个 SQLite 文件**（以及 SQLite 自己生成的 `-wal` / `-shm`） | `grep -n "writeFileSync\|mkdirSync" lib/index.js` → 只有建目录那行 |
| LLM 调用走哪里？ | **走 DSH 宿主**（`ctx.get("llm", false)`，宿主没提供就降级为纯规则模式），插件不接触凭据、不代理请求 | `grep -n 'ctx.get("llm"' lib/index.js` |
| 库文件是否加密？ | **不加密。** 是明文 SQLite，任何能读该文件的人都能读全部对话 | 用任意 SQLite 客户端打开 `loom.db` 即可 |
| 落盘前会过滤敏感信息吗？ | **会。** `redactSecrets()` 在写入前把访问密钥、`Bearer xxx`、`password=`/`token:` 这类赋值串、手机号、身份证号、银行卡号替换成 `[redacted ...]` | `grep -n "SECRET_PATTERNS" -A 30 lib/index.js` |

关于脱敏要说清边界：它是**保守的正则匹配**，防的是「你不小心把密钥粘进对话」，不是 DLP 系统。自由叙述格式的敏感信息（比如身份证号中间夹了空格以外的写法、自定义格式的内部编号）不一定拦得住。

两条由此推出的操作建议：

1. **别把 `loom.db` 放进网盘/公开同步目录**，也别提交进任何 git 仓库（`.gitignore` 已拦截 `*.db`）。
2. **威胁模型是「本机文件权限」**，不是「服务端泄露」——因为没有服务端。你要防的是别人拿到这台机器或这个文件。

如果你在别人的分支/PR 里看到 `loom.db`、`.env`、带真实对话的 `.jsonl`，那一定是误提交，不要 merge。

### ⚠️ 备份提醒：这是唯一需要你自己动手的事

这个插件的全部记忆只有**一个 SQLite 文件**，没有云端副本、没有第二份。库文件丢了，记忆就没了——这一点插件替你兜不了。

**要备份什么**

| 文件 | 是否必需 | 说明 |
| --- | --- | --- |
| `loom.db` | ✅ 必需 | 全部记忆：原始对话、事实、事件、自我叙事、索引与整理版正文 |
| `loom.db-wal` | ⚠️ 存在就必须一起拷 | 最近尚未合并回主库的写入。只拷 `loom.db` 会丢掉最近这段对话 |
| `loom.db-shm` | 可忽略 | 只是共享内存索引，会自动重建 |
| `diary/` | 可选 | v0.2.9 起的日记 Markdown 镜像。**它是只读导出，不是真相来源**：启动时会把最近 14 天重写一遍，更早的日子不会自动回来（库里的条目本身还在）。所以不必单独备份；只有当你把它当成唯一阅读副本时才需要一起拷 |

**在哪**

配置项 `path`，默认由 bundle patch 设为 `dshHomePath('memory', 'loom.db')`，也就是 DSH 主目录下的 `memory/loom.db`：

- Linux / macOS：`~/.dsh/memory/loom.db`
- Windows：`%USERPROFILE%\.dsh\memory\loom.db`
- 若设置了环境变量 `DSH_HOME`，则在其下面同样位置
- 你自定义过 `path`，就按你配置的路径

不确定的话，直接在 DSH 里问：*「memory 插件的 path 配置是什么？」* 或让它调 `memory_identity export` 导出一份 JSON 作旁证。

**怎么备**

最稳的是停掉 DSH 再拷，三个文件一起拷：

```bash
# 停掉 DSH 之后
cp "$DSH_HOME/memory/loom.db"* ~/backup/loom-$(date +%F).db   # 连同 -wal/-shm
```

不停 DSH 也能拷，但要一次拷齐三个文件；或者用 SQLite 的一致性备份，避免拷到半写入状态：

```bash
sqlite3 "$DSH_HOME/memory/loom.db" ".backup '$HOME/backup/loom-$(date +%F).db'"
```

**多久备一次**

看你对「丢最近几天」的容忍度：记忆是持续累积的，越晚备丢得越多。日常每天一次、大改配置或换机器前手动备一次即可。库很小（纯文本，一万轮对话量级在几十 MB），不需要增量方案。

**怎么恢复**

停掉 DSH，把备份文件放回 `path` 指向的位置并命名为 `loom.db`，删掉同目录残留的 `-wal` / `-shm`，再启动。

**注意**

- 备份文件里是**未脱敏的完整对话**（脱敏只作用于写入前的敏感字段替换，不是加密）。别放到公开的同步目录或仓库里。
- `memory_identity erase` 后来删掉的人，其数据在旧备份里仍然存在。备份是时间点快照，删除不会回溯。

---

## 8. 已知边界

这些是刻意没做、或明知差距但暂时不动的，不是遗漏。逐条的原因、代价与切入点见 [`docs/design.md`](docs/design.md) §13。


| 项                   | 现状                                    | 原因                                   |
| ------------------- | ------------------------------------- | ------------------------------------ |
| 向量 / embedding 检索   | 用 CJK 二元分词 + FTS5 BM25                | 离线、无密钥、中文子串可召回；语义相近但用词不同的情况会漏        |
| 相册（Q22）             | 未实现                                   | 图片记忆需要单独的相似度通道与存储，留作扩展点              |
| 对话历史去重（Q45）         | 未做 `in_conversation` 标记               | 记忆块与对话历史由宿主分别管理，重复内容靠模型读上下文消解        |
| 主观层配额的动态下调（Q30/Q31） | 固定 25%                                | 需要跨轮统计命中率；当前每轮独立计算                   |
| 备份（Q58/Q59）         | 不做                                    | 按 Q59，备份责任在用户                        |
| 48 小时整合兜底（Q2）       | 用 5 分钟空闲触发替代                          | 到期判定是「有未整合轮次 + 空闲满 5 分钟」，比 48h 严格更早；两者本来跑在同一个 tick 上，替换不引入新漏点 |
| 单条消息上限              | 默认不限制（`0`），可设 `l0.maxCharsPerMessage` | 0.1.x–0.2.0 曾硬编码 8000 字截断且无提示，现在整条落库 |
| 正文无语义检索             | 只能顺钩子/编号取回；入口是模型自己调 `memory_expand`，找不到时先用 `memory_search` 按关键词定位 | 设计而非缺陷：想起来的是钩子，细节主动去捞。`memory_search` 走 FTS5，不受 16 条钩子限制，所以「不在索引里」不等于「找不回来」 |
| 钩子密度受整合质量约束         | 规则模式下技术对话抽不出事实、事件标题近似重复               | 索引层已做同名折叠缓解；根治需提升整合层                 |
| 日记不计权（Q63，v0.2.9 已定稿） | 日记不参与排序、也不计入叙事证据；改为每天导出一个 Markdown 到 `diary/` 目录 | 日记是写给助手自己的，加权重不会让人更愿意看它；给一个能点开的入口比调系数有用 |
| 语气标注未做离线评估（Q64，v0.2.9 已收口） | 事件行尾按 `valence`/`arousal` 标一句「（语气偏冲）」，不做独立注入通道 | 用户的实际要求只是「读记忆时看得见当时的语气」；阈值映射已够用，对照实验需真模型 + 语料 + judge，见 §13.2 |
| 评估集与指标（Q39）          | 用仓库内自建场景与探针替代                    | 它衡量机制正确性（指针没断、分页无损、删除会级联），不衡量记忆质量，见 §13.3 |

---

## 9. 目录

本仓库**以构建产物发布**：没有 `src/`，`lib/index.js` 就是完整可运行的插件本体（约 6170 行，保留可读格式与注释，不是压缩代码）。原 TypeScript 源工程未随仓库放出，因此「改一行再构建」这条路暂时不通；反馈问题时请附 `lib/index.js` 的行号，定位是一致的。

```
lib/
  index.js           完整插件（dsh 适配层 + 钩子索引 + 引擎，单文件 bundle）
  index.d.ts          对外类型：Config、HookIndex、sliceByTokens 等
test/
  selftest.mjs        钩子索引层自测，30 项（npm test）
docs/
  design.md           设计与 Q1–Q66 对照
loom-e2e/             端到端脚手架（不在 npm 包内，仅供仓库内验证）
  harness.mjs         用假 cordis context 跑真插件
  scenario-work.mjs   工作类：写代码 + 表格两条线（18 项断言）
  scenario-merged.mjs 融合后完整链路（22 项）
  scenario-limit.mjs  极限类：上下文打满后是否正常（17 项）
  scenario-l0cap.mjs  长消息不截断的存储代价（15 项）
  scenario-diary.mjs  日记镜像与语气标注（17 项，v0.2.9）
  scenario-cost.mjs   分页预算四档实测（产出 token 表）
  probe-config.mjs    schema / indexDefaults / 引擎配置三方对齐
  probe-ceiling.mjs   驻留上限与取回成本是否相关
  probe-recall.mjs    掉出候选池的事件能否靠 FTS5 找回
  probe-audit.mjs     分页边界（emoji/越界/无损拼接）、脱敏性能、非本机路径、并发
  probe-audit2.mjs    配置项是否真的生效（整合开关 / 通配符转义 / ownerName / locale）
  probe-audit3.mjs    驻留预算上限、挂载不存在的编号、驻留快照稳定性
  REPORT.md           上述场景的断言矩阵与结论
cordis.patch.yml      bundle patch：把插件挂进 profile
.env.example          环境变量示例（本插件不需要任何密钥）
```

`lib/index.js` 内部分区（按行号大致顺序）：`Config` schema → SQLite schema 与迁移 → 文本层（CJK 分词、脱敏、预算）→ 存储层（L0–L3 SQL）→ 抽取/整合 → 召回/渲染 → `HookIndex` 钩子索引层 → dsh 适配（事件绑定、prompt 注入、工具注册）。

`loom-e2e/` 单独跑需要 `npm install`（它复用父目录的 `node_modules`），运行方式：

```bash
node loom-e2e/scenario-merged.mjs   # 单个场景
node loom-e2e/probe-config.mjs      # 配置三方对齐
```

