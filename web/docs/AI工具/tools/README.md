# AI 编码工具学习地图

> 数据快照：2026-09-04（GitHub API）。这个领域仓库改名、迁移、转型的频率以周计——学**架构与模式**，别背**路径与版本号**。
>
> 三层堆栈模型的完整论证见姊妹篇：[Maka、Orca、Multica 对比](../../../work/hub/maka/guide/10-maka-orca-multica对比.md)。本目录把同样的分层视角铺到整个生态，每个工具一篇，从快速入门读到源码地图。
>
> **先读 [00 · 本质层](00-harness本质.md)**：18 篇文章讲"每个工具是什么"，00 讲"所有工具共同服从什么"——Harness 七条第一性原理 + 全场记分卡。没有它，下面 18 篇只是碎片清单。

## 一、四层模型：先把地图装进脑子

分析任何一个 AI 编码工具，第一个问题永远是：**干活的 agent 是谁家的？它在堆栈的哪一层？**

```text
┌──────────────────────────────────────────────────────────┐
│ 团队协作层：issue 派发 / 看板 / review gate / 成本核算        │  ← 目前开源无强者，Multica 领跑
├──────────────────────────────────────────────────────────┤
│ 编排控制层：多 agent 调度 / worktree 隔离 / 自动化 / 看板     │  ← OpenHands、cc-switch、claude-squad…
├──────────────────────────────────────────────────────────┤
│ IDE 集成层：编辑器内对话 / 行内 diff / 模式切换               │  ← Cline、Kilo、Roo Code
├──────────────────────────────────────────────────────────┤
│ agent 引擎层：模型调用循环 / 工具执行 / 会话状态 / 终端 TUI    │  ← opencode、claude-code、codex、goose…
└──────────────────────────────────────────────────────────┘
```

两个贯穿全目录的判据：

1. **自带引擎的**（opencode、goose、codex）对执行过程负责，能承诺可恢复、可审计；**驱动别家 CLI 的**（cc-switch、claude-squad）只承诺自己看得见的部分。
2. **2026 年的大趋势是向上爬层**：Cline 长出了 CLI 和 Kanban，OpenHands 转型为控制中心，Kilo 直接采用 opencode 的代码基座。今天的分层是快照，不是定局——这正是读源码比记功能更有价值的原因。

## 二、总表：18 个工具一览

| # | 工具 | 层 | Stars | 语言 | 许可 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 01 | [opencode](01-opencode.md) | 引擎 | 203.5k | TypeScript | MIT | 活跃（生态头牌） |
| 02 | [claude-code](02-claude-code.md) | 引擎 | 143.9k | 闭源（仓库存文档与插件） | Anthropic 商业条款 | 活跃（事实标准） |
| 03 | [codex](03-codex.md) | 引擎 | 121.2k | Rust | Apache-2.0 | 活跃 |
| 04 | [gemini-cli](04-gemini-cli.md) | 引擎 | 106.8k | TypeScript | Apache-2.0 | 活跃 |
| 05 | [goose](05-goose.md) | 引擎 | 53.9k | Rust | Apache-2.0 | 活跃（Linux 基金会治理） |
| 06 | [aider](06-aider.md) | 引擎 | 48.7k | Python | Apache-2.0 | ⚠️ 2026-05 后放缓 |
| 07 | [crush](07-crush.md) | 引擎 | 27.9k | Go | 自定义（见 LICENSE） | 活跃 |
| 08 | [qwen-code](08-qwen-code.md) | 引擎 | 27.6k | TypeScript | Apache-2.0 | 活跃（fork 演化样本） |
| 09 | [openclaw](09-openclaw.md) | 引擎（边界案例） | 388.8k | TypeScript | 自定义（见 LICENSE） | 活跃（个人助理，非编码） |
| 10 | [OpenHands / Agent Canvas](10-openhands.md) | 跨层（引擎+编排） | 86.1k | TypeScript | MIT | 活跃（beta，转型期） |
| 11 | [cline](11-cline.md) | IDE（向上爬层中） | 67.4k | TypeScript | Apache-2.0 | 活跃 |
| 12 | [kilocode](12-kilocode.md) | IDE | 27.2k | TypeScript | MIT | 活跃（opencode 同构） |
| 13 | [roo-code](13-roo-code.md) | IDE | 24.3k | TypeScript | Apache-2.0 | ⚠️ 2026-05 后放缓 |
| 14 | [cc-switch](14-cc-switch.md) | 编排（配置管理） | 130.9k | Rust (Tauri) | MIT | 活跃 |
| 15 | [vibe-kanban](15-vibe-kanban.md) | 编排（看板） | 28.0k | Rust | Apache-2.0 | ⚠️ 官方宣布 sunsetting |
| 16 | [claude-squad](16-claude-squad.md) | 编排（终端） | 8.4k | Go | AGPL-3.0 | 活跃（源码入门首选） |
| 17 | [crystal → Nimbalyst](17-crystal-nimbalyst.md) | 编排（worktree） | 3.1k | TypeScript | MIT | 已废弃，继任者 Nimbalyst |
| 18 | [claude-task-master](18-claude-task-master.md) | 周边（任务中间件） | 28.0k | JavaScript | MIT + Commons Clause | 活跃 |

状态判读：**stars 高 ≠ 活跃**。aider、Roo Code 星数可观但近月无 push；vibe-kanban 已官宣谢幕。采用前先看 `pushed_at`，命令：`curl -s https://api.github.com/repos/OWNER/REPO | grep pushed_at`。

## 三、三条学习路径（按目标选，别按顺序硬读）

无论选哪条，00 是共同的第一站；读完每篇后用 00 的七条原理回问一遍（每篇文章该问什么，00 第七节给了示范）。

**路径 A · 使用者：先跑起来再说**
02 claude-code（事实标准，先建立手感）→ 01 opencode（开源平替，理解可换模型的价值）→ 14 cc-switch（管理所有工具的供应商配置）→ 16 claude-squad（终端里并行开干）。读完你就覆盖了 90% 的日常场景。

**路径 B · 架构研究者：看引擎怎么造、怎么演化**
04 gemini-cli（Google 的规范实现）→ 08 qwen-code（同一个代码基座如何 fork 出独立方向——最好的 fork 演化样本）→ 05 goose（Rust 引擎 + 基金会治理）→ 10 OpenHands（引擎与控制中心集于一身的转型现场）。最后回到[对比文档](../../../work/hub/maka/guide/10-maka-orca-multica对比.md)看 Maka 如何把"执行记录"做成一等公民。

**路径 C · 源码初学者：从小仓库读到大仓库**
16 claude-squad（Go，八个目录读完一个产品）→ 07 crush（Go，`internal/` 单目录架构）→ 06 aider（Python，单包 + 独立 benchmark）→ 03 codex（Rust workspace）。引擎层的巨型 monorepo（opencode、gemini-cli）放最后。

## 四、每篇文章的统一结构

所有文章遵循同一个骨架，方便对照阅读：

1. **为什么存在**——它解决什么问题，不解决什么问题；
2. **快速入门**——真实安装命令（Windows/Git Bash 优先标注），30 分钟跑通；
3. **熟练掌握**——核心概念表 + 日常工作流；
4. **架构设计**——怎么实现的，关键取舍是什么；
5. **源码地图**——真实顶层目录的职责与建议阅读顺序（目录来自当日 GitHub API，职责标注为推断时以仓库内文档为准）；
6. **自测清单**——达到"掌握"的可验证标准；
7. **参考**——官方文档与仓库链接。

## 五、维护说明

- stars、状态均为 2026-09-04 快照，刷新只需对每个仓库打一次 `api.github.com/repos/{owner}/{repo}`。
- 仓库迁移高发：opencode（sst → anomalyco）、goose（block → aaif-goose）、OpenHands（All-Hands-AI → OpenHands）。链接失效先搜组织名。
- 每篇文章的事实边界：安装命令与功能清单以当日 README 为准；"源码地图"的目录职责凡未经仓库文档证实的，均标注为推断。
