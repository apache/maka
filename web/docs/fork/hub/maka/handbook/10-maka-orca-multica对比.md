> 历史（参考调研，09-03 快照）：与 orca/multica 的对比侦察，stars、活跃度与功能均未刷新。现行入口见 [handbook/12-维护任务书](12-维护任务书.md)。

# Maka、Orca、Multica：agent 堆栈三层的三个答案

> 数据快照：2026-09-03，stars 与活跃度以当日 GitHub API 为准。三个项目迭代都很快，结论关注"定位与架构"，具体功能以各自仓库为准。

## 结论先行

三个项目名字像（都以 -a 结尾）、都谈 multi-agent、都提供 Electron 桌面端，但它们不在同一层竞争。用一句话区分：

| 项目 | 一句话定位 | 在堆栈中的层 |
| --- | --- | --- |
| **Maka** | 自带 agent 的本地工作台：自己实现 agent 运行时、沙箱、执行记录和评测框架 | agent 执行层（运行时 + 证据 + 评测） |
| **Orca** | 开发者的并行驾驶舱：把几十个第三方 CLI agent 装进一个桌面 IDE，worktree 隔离、手机盯梢 | 开发环境层（个人工作站的编排壳） |
| **Multica** | 人 + agent 团队的管理看板：把 issue 派给 agent 当同事，带 review gate 和成本核算 | 团队协作层（组织级工作流平台） |

分层视角下三者的位置：

```text
┌─────────────────────────────────────────────────────┐
│  团队协作层：issue / 看板 / review gate / 成本           │  ← Multica
├─────────────────────────────────────────────────────┤
│  开发环境层：编辑器 / 终端 / worktree / diff 审阅        │  ← Orca
├─────────────────────────────────────────────────────┤
│  agent 执行层：模型调用 / 工具沙箱 / 权限 / 执行记录 / 评测 │  ← Maka
├─────────────────────────────────────────────────────┤
│  agent 本体：Claude Code、Codex、OpenCode 等第三方 CLI   │  ← Orca/Multica 驱动它们
└─────────────────────────────────────────────────────┘
```

这个分层的推论贯穿全文：**Maka 自己就是 agent（的运行时）；Orca 和 Multica 都不带 agent，它们驱动别人的 agent**。其余所有差异——架构、状态管理、多 agent 语义、信任边界——都是从这条分界线推出来的。

## 一、事实档案

| 维度 | Maka | Orca | Multica |
| --- | --- | --- | --- |
| 仓库 | `apache/maka` | `stablyai/orca` | `multica-ai/multica` |
| 背景 | Apache 软件基金会孵化项目（Incubating） | Stably AI（YC-backed），商业公司驱动 | multica-ai，商业公司驱动 |
| 首次建仓 | 2026-05（以 apache 组织仓库计） | 2026-03 | 2026-01 |
| Stars | ~4.6k | ~60.7k | ~48.8k |
| 语言 | TypeScript（Electron + React 桌面） | TypeScript（Electron 桌面 + 移动端） | Go 后端 + Next.js 前端 + Electron/Expo 客户端 |
| 许可证 | Apache-2.0（ASF 治理） | MIT | 自定义（Apache-2.0 全文 + 托管服务/商用嵌入/品牌附加条款） |
| 交付形态 | Desktop（macOS arm64 为主，Windows 未签名预览、Linux 预览）+ TUI/CLI + npm 包 | Desktop（macOS/Windows/Linux）+ iOS/Android 伴侣 App + 无头 `orca serve` | Web + Desktop + CLI/API，自托管（Docker Compose/Helm）或云服务 |
| 是否自带 agent | **是**，第一方 agent 运行时 | **否**，驱动 30+ 第三方 CLI agent | **否**，驱动 26 个第三方 CLI agent |
| 发布节奏 | Nightly（尚无 ASF 正式发布，API 可能变化） | 每日发布，changelog 即真实功能清单 | 大部分工作日发布 |

三个项目都是 2026 年诞生、当月仍在活跃推送的年轻项目。差异不在成熟度，而在"造的是哪一层"。

## 二、最根本的分界：agent 是谁家的

看懂三个项目的第一步，是问一个它们 README 里都写明了的问题：**你打开它之后，干活的那个 agent 是哪来的？**

**Maka 的 agent 是自己写的。** 它内置 `Read`/`Write`/`Edit`/`Bash`/`Glob`/`Grep` 工具、模型适配层、权限审批、沙箱边界、执行记录、崩溃恢复。模型本身是外接的（BYOM：云 API、本地模型或兼容网关），但"循环读上下文→调工具→落盘证据"的整个 agent 循环由 Maka 的 Runtime Host 实现。你给它的不是 Claude Code，而是一个 API key。

**Orca 和 Multica 的 agent 是别人的。** 两者的前置条件一样：你的机器上必须先装好并登录至少一个第三方 agent CLI（Claude Code、Codex 等）。它们不实现 agent 循环，而是负责"这个循环发生在哪、谁给它派活、结果谁来审"。区别在于它们把这层管理放在了不同的组织尺度上——Orca 放在个人工作站，Multica 放在团队。

这条分界线的下游推论：

- Maka 能对**执行过程本身**负责：工具调用被写成不可变的执行事实（Runtime Event Log），崩溃后能恢复、能续跑。因为它拥有运行时，所以它能承诺这些。
- Orca/Multica 对执行过程的承诺止于它们能看到的部分：Orca 看到的是终端输出，Multica 看到的是 daemon 上报的执行日志。agent 循环内部（上下文怎么剪、工具怎么重试）是第三方 CLI 的黑盒。

## 三、逐个解剖

### 3.1 Maka：单一执行权威 + 可恢复的执行事实

Maka 的架构文档（`ARCHITECTURE.md`）第一句话就是它的核心决策：**全系统只有一个执行权威 Runtime Host**。Desktop、TUI、CLI、bot、评测客户端都只是 Runtime Host 的客户端，没有任何一个入口拥有第二套运行时。

```text
Desktop / TUI / CLI / Bot → Runtime Host → SessionManager → AgentRun
                                                ↓
                          Model + Tool Runtime → Runtime Event Log（不可变执行事实）
                                                ↓
                          Context / Session / UI / Recovery 投影
```

三个值得注意的设计：

1. **日志是唯一事实，上下文是投影。** 模型消息、工具调用、工具结果、轮次终止方式全部写入 Runtime Event Log。上下文裁剪和压缩只改"下一次喂给模型的输入"这个投影，不删历史。这就是它 README 里那句"Shorter context is not deleted history"——这是三者中最显式的 Context Engineering 设计。
2. **多 agent 走依赖调度。** Agent Graph 控制平面用子 Session 调度有依赖关系的工作，所有激活都回到同一个 Runtime；实现型算子用隔离的 git worktree。`maka run --graph "实现两个独立切片，集成，然后审查"` 就是一条真实命令。
3. **自带评测框架。** `@maka/eval` 把声明式实验展开成 task × repetition × subject 的 Cell，attempt 不可变、最早有效者权威、不允许人工挑结果；Maka 自身作为 subject 只能走公共协议边界，外部竞品作为通用 external subject 接入。也就是说，Maka 是三者中唯一能**系统性测量 agent 表现**（A/B、成本、失败原因）的项目。

适用画像：想把"agent 干活的每一步"变成可核验、可恢复、可评测的执行事实的个人或研究者；重视数据本地、自己带模型接入的操作系统型用户。

### 3.2 Orca：把 30 个终端 agent 装进一个工作台

Orca 自称 ADE（Agent Development Environment），产品假设是"你不会只雇一个 agent"。它的能力清单全部围绕一个动作展开：**同时跑一队 CLI agent，并让你管得住**。

- **并行 worktree 扇出**：一个 prompt 撒给五个 agent，各自在独立 git worktree 里干活，比较结果、合并胜者。这是它最具标志性的机制。
- **工作台本体**：Ghostty 级别的终端分屏（WebGL 渲染、重启后 scrollback 保留）、VS Code 式编辑器、文件拖入 prompt、Chromium 内嵌浏览器 + Design Mode（点 UI 元素把 HTML/CSS/截图直接送进 prompt）。
- **审阅闭环**：GitHub/Linear 原生集成，AI diff 上逐行批注并回传给 agent。
- **规模化手段**：SSH worktree（agent 跑在远程大机器上）、账号切换与用量/限流追踪、iOS/Android 伴侣 App（agent 完成即推送，手机上追发指令）、`orca serve` 无头模式。
- **可脚本化**：`orca worktree create` / `snapshot` / `click` / `fill`，agent 也能反过来驱动 Orca。

架构上是典型的"厚客户端壳"：Electron 桌面管理 PTY/终端进程，每个被驱动的 agent CLI 保留自己的会话状态，Orca 不拥有也不替代那些状态。移动配对依赖仓库内 `cloud/` 下的 relay 服务。

适用画像：单人或小团队的"百倍工程师"玩法——同时开多个 agent 并行攻克不同任务，需要 worktree 级隔离、diff 审阅和手机盯梢。

### 3.3 Multica：把 agent 变成看板上的同事

Multica 的单位不是"会话"或"worktree"，而是 **issue**。它的假设是：agent 应该像同事一样出现在看板上——被指派、领活、汇报、抛出阻塞、交回 review。名字里的 Multica 是 *Multiplexed Information and Computing Agent*，致敬 Multics 的分时系统：现在来分时的既有真人也有机器。

围绕 issue 这个单位，它补齐了一整套"团队制度"：

- **指派即派活**：把 agent 设为 assignee，它在你的 daemon 上领活、边干边评论、完成后把 issue 移入 review。
- **Squads 与路由**：人和 agent 编进一个队伍，leader 负责路由工作。
- **Autopilots**：cron 驱动的站会、审计、报告，没人提醒也不会漏。
- **Skills**：把解决过的问题固化成所有 agent 可复用的 playbook。
- **可观测与治理**：执行日志逐条回放（工具调用、命令、错误，带时间戳）、按 agent/issue 的 token 成本、review gate（成果只进 review 不进 main）、Inbox、失败自动重试、角色与访问范围。
- **部署与集成**：Docker Compose/Helm 全自托管；GitHub/GitLab/Gitea/Forgejo 皆可；Slack/Lark/钉钉/企业微信/Telegram 触发。

架构上是三者中唯一的标准 C/S 结构：Go 后端（Chi + WebSocket）+ PostgreSQL 17 协调全局，agent daemon 跑在你自己的机器上、贴着代码生成 CLI 子进程——"agent 的工位是你的机器，代码不出机器"，但协调面在天上（云或自托管服务器）。

适用画像：要把 agent 纳入团队流程的工程组织——有看板制度、需要 review gate 和成本核算、关心自托管和审计。

## 四、逐维度对比

### 4.1 单位工作：Turn、Worktree、Issue

| | Maka | Orca | Multica |
| --- | --- | --- | --- |
| 一等工作单位 | Turn / Session（+ Graph 的子 Session） | Worktree 里的终端任务 | Issue |
| 生命周期归属 | Runtime Event Log，跨崩溃可恢复 | 各 CLI agent 自己的会话 | 平台数据库，绑定 issue 全历史 |
| "做完"的定义 | 轮次终止，记录进日志 | diff 可合并、人工拍板 | issue 流转到 review，人工放行 |

单位决定语义。Maka 的 Turn 是执行语义单位（所以它能定义"续跑"）；Orca 的 worktree 是隔离语义单位（所以它能定义"比较与合并"）；Multica 的 issue 是组织语义单位（所以它能定义"指派、阻塞、放行"）。

### 4.2 执行位置与信任边界

| | Maka | Orca | Multica |
| --- | --- | --- | --- |
| 执行发生在哪 | 本机，单机内闭环 | 本机或 SSH 远程机 | 你的机器（daemon），协调面在服务器 |
| 数据去向 | 默认全本地，BYOM | 本地为主，遥测可关，移动需 relay | 代码不出 daemon 机器，issue/日志/成本在服务器（可自托管） |
| 越界控制 | 沙箱边界 + 工具审批 + 运行中止 | 依赖各 CLI 自身的确认机制 | review gate + 角色访问范围 + 安全模型文档 |

三个都讲"代码在你机器上"，但含义不同：Maka 是单机内的运行时控制（沙箱+审批），Orca 是工作站上的进程编排（几乎无服务端），Multica 是有服务端的分布式系统（控制面/数据面分离）。

### 4.3 上下文与状态（Context Engineering 视角）

- **Maka 自己管上下文**：裁剪与压缩是事件日志上的投影，历史不可删。这是唯一一家把上下文策略当作运行时一等公民来设计的。
- **Orca 把上下文留给 CLI**：它做的输入增强（拖文件、Design Mode 抓取页面、repo 预览）是 prompt 侧的加料，不拥有会话状态。
- **Multica 把上下文挂在工作项上**：Projects 挂仓库和文档、Skills 沉淀 playbook、评论承载意图，跨 run、跨天、跨 agent 复用。它管理的是组织级上下文，不是单轮上下文。

一句话：Maka 管"这一轮喂给模型什么"，Orca 管"这一屏给开发者看什么"，Multica 管"这件事的前因后果给谁看"。

### 4.4 多 agent 的三种语义（Agentic Engineering 视角）

三者都说 multi-agent，说的不是一件事：

| | 语义 | 编排者 | 典型形态 |
| --- | --- | --- | --- |
| Maka（Agent Graph） | **依赖调度**：任务间有依赖关系，子 Session 按图调度，同一 Runtime 内闭环 | 运行时控制平面 | `--graph "A、B 独立实现→集成→审查"` |
| Orca（并行 worktree） | **并行扇出**：同一任务多副本独立求解，横向比较、择优合并 | 人（比较与合并靠人拍板） | 一个 prompt 撒给五个 agent |
| Multica（Squads/Autopilots） | **组织路由**：按团队结构和日程把工作分派给不同 agent | 队伍 leader / cron | agent 按排班领 issue |

值得注意的汇合点：Maka 的 Graph 算子和 Orca 的并行任务都用 git worktree 做隔离，但语义不同——Maka 把 worktree 当运行时内部的执行隔离，Orca 把 worktree 当用户面前的比较单元。

### 4.5 可验证性：只有 Maka 有"测量"

- Maka 内置 eval 框架：声明式多臂实验、不可变 attempt、最早有效选择、归因成本与失败原因，且能把外部竞品作为 subject 来测。
- Orca 有用量/限流追踪（账号级运营数据），没有实验语义。
- Multica 有按 run/agent/issue 的成本核算（账单数据），也没有实验语义。

运营数据回答"花了多少"，实验框架回答"哪个更好、为什么失败"。前者两者都有雏形，后者目前只有 Maka 做。

### 4.6 人在环里的位置

- **Maka**：人在环内做**审批**（工具越界要批准）和**复盘**（看执行记录），交互以对话和 timeline 为主。
- **Orca**：人在环内做**审阅与合并**，交互以 IDE/终端/diff 为主——它假设你是全职的 agent 管理员。
- **Multica**：人在环内做**指派与放行**，交互以看板/评论/收件箱为主——它假设你是管着几个 agent 的团队成员。

### 4.7 架构风格与代价

```text
Maka：内核式                    Orca：厚壳式                   Multica：C/S + daemon
Desktop/TUI/CLI/Bot            Electron 桌面                  Web/Desktop
      ↓                              ↓ (PTY)                        ↓ WS
Runtime Host（唯一权威）        终端×N + 编辑器 + 浏览器         Go 后端 + PostgreSQL
      ↓                              ↓                             ↓
Event Log + 投影 + Eval        第三方 CLI agent（自带状态）      agent daemon（你的机器）
                                                                    ↓
                                                              第三方 CLI agent
```

- **内核式（Maka）**：换来的是单一事实源、崩溃恢复、可评测和稳定的协议边界；代价是所有 agent 能力都要自建，演进速度受 ASF 孵化流程约束（目前只有 Nightly，无正式发布）。
- **厚壳式（Orca）**：换来的是极快的迭代（不需要重造 agent，新 CLI 出来当天就能跑）和最轻的部署面；代价是执行过程是黑盒，会话状态、上下文策略、安全边界都受制于被驱动的 CLI。
- **C/S + daemon（Multica）**：换来的是团队级共享状态（看板、成本、权限、审计）和自托管能力；代价是运维面最大——要跑后端和数据库，移动端 iOS 还未上 App Store。

## 五、相同点与重叠区

诚实列出重叠，避免"完全不同"的过度声明：

1. **都是 Electron 桌面应用**，都在做"多 agent 一屏管理"的入口体验，界面层会有持续的同质化竞争。
2. **都讲 multi-agent**，只是语义不同（4.4 节）；如果只看营销页，三者听起来几乎一样。
3. **都在快速吃掉邻近层**：Orca 加了 GitHub/Linear 任务流（往 Multica 方向），Multica 加了桌面端和 Skills（往 Orca/开发工具方向），Maka 的 Graph 加了 worktree（往并行执行方向）。三层的边界是当前快照，不是永久事实。

**互补关系是真实存在的**：Maka 的 TUI 是一个标准 CLI，Orca 的口号是"能在终端跑的 agent 就能在 Orca 跑"——把 Maka 当作舰队中的一员是成立的；而 Maka 的 eval 框架恰好可以拿 Orca/Multica 背后的那些 CLI agent 作为外部 subject 来测。Multica 目前需要 CLI 在其 26 个支持列表内，`maka` 尚不在列。

## 六、选型决策

按你的真实问题选，不按功能清单选：

| 你的问题 | 选择 |
| --- | --- |
| 我要一个自己掌控的编码 agent：数据本地、可恢复、过程可审计、可做 A/B 评测 | **Maka** |
| 我一个人同时开多个 agent 干活，要 worktree 隔离、diff 审阅、手机盯梢 | **Orca** |
| 我的团队要把 issue 派给 agent，要 review gate、成本核算、自托管 | **Multica** |
| 我要测量/对比各家 agent 的真实表现 | **Maka（eval）**，其他两家无此能力 |
| 我要给 agent 排班、做定时审计和站会 | **Multica（Autopilots）** |
| 我要一个 prompt 多副本并行求解再合并 | **Orca（worktree 扇出）**；Maka 的 `--graph` 适合有依赖的拆解 |

两个风险提示：

- Maka 处于孵化期，README 明言数据格式、CLI 命令可能变化，且尚无 ASF 正式发布——生产采用需预期破坏性变更。
- Multica 的许可证不是纯 Apache-2.0，附加了托管服务与商用嵌入条款，商用前读 `LICENSE`。

## 七、一句话收束

Maka 造的是**发动机**（agent 运行时 + 行车记录仪 + 测试台架），Orca 造的是**驾驶舱**（一个人同时开一队车），Multica 造的是**车队调度系统**（让车和司机同一个看板排班）。三者可以同框：调度系统派活给车队，车队里可以有一台 Maka 发动机的车，而测试台架负责给整个车队测圈速。

## 参考

- apache/maka：<https://github.com/apache/maka>（本仓库 `ARCHITECTURE.md`、`README.md`）
- stablyai/orca：<https://github.com/stablyai/orca> · <https://www.onorca.dev/>
- multica-ai/multica：<https://github.com/multica-ai/multica> · <https://www.multica.ai/>
