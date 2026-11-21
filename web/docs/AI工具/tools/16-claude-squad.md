# 16 · claude-squad：八千行 Go 里的并行 agent 教案

> 编排控制层（终端） ｜ Stars ~8.4k（2026-09-04） ｜ Go ｜ AGPL-3.0（传染性许可，二次开发注意） ｜ [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad)
> 学习目标：跑通它；**这是本目录源码入门的第一推荐**——目录少、链路完整，一周末读透"tmux + git worktree"并行编排的全部机关。

## 一、为什么存在

终端里的"agent 小队管理器"：把多个 Claude Code / Codex / Gemini / Aider 会话放进各自隔离的 workspace（git worktree + tmux 会话），一个窗口调度，后台并行干活（支持 auto-accept 全自动模式），改完逐一 review 再合并。它是 Orca 的极简终端版——没有界面工程，只有编排本质，所以格外适合学习。

## 二、快速入门

前置依赖：`tmux` 和 `gh`（GitHub CLI）。

```bash
brew install claude-squad
ln -s "$(brew --prefix)/bin/claude-squad" "$(brew --prefix)/bin/cs"
# 或：curl -fsSL https://raw.githubusercontent.com/smtg-ai/claude-squad/main/install.sh | bash
```

第一次跑通：`cs` 启动 → 新建一个 instance（指定用哪个 agent）→ 让它在后台改点东西 → 回到主面板 review 它的 diff → 确认后合并。注意：tmux 在 Windows 原生不可用，需 WSL。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Instance | 一个 agent 会话 = worktree + tmux 窗口的组合体 |
| 后台任务 | auto-accept 模式下 agent 全自动干活 |
| Review | 合并前人工过 diff，可选择性 checkout 改动 |
| 隔离 | 每任务独立 worktree，互不冲突 |

熟练建议：同时开三个 instance 跑三个互不相关的 bug 修复，体会"并行"的真实收益与切换成本——并行 agent 的瓶颈从来不是算力，是**你的注意力带宽**。

## 四、架构设计

Go 项目，目录即架构：`app/`（应用状态）、`session/`（instance 生命周期：worktree + tmux 管理）、`daemon/`（后台状态机，追踪各会话）、`ui/`（TUI 界面）、`cmd/`（命令入口）、`web/`。

两个设计决策值得记住：**用 tmux 做会话容器**（agent 死活与面板解耦，attach/detach 自由）；**用 git worktree 做文件隔离**（同一仓库多份工作副本，不互相踩）。这两个选择就是整个"并行 agent 编排"的最小公倍数——Orca、Maka 的 Graph、vibe-kanban 本质上都在做同样的两件事，只是外面包了更贵的 UI。

## 五、源码地图与阅读路线（本目录首选源码入门）

| 目录 | 职责 | 阅读顺序 |
| --- | --- | --- |
| `cmd/` | 命令入口 | ① |
| `app/` | 应用状态与面板逻辑 | ② |
| `session/` | instance 生命周期：worktree/tmux 的创建销毁 | ③（核心） |
| `daemon/` | 后台状态机 | ④ |
| `ui/` | TUI 渲染 | ⑤ |

建议顺序就是表格顺序，总代码量小，一个周末可通读。带着问题读："一个 instance 从 `cs new` 到可交互，依次发生了哪五件事？"

## 六、自测清单

- [ ] WSL/桌面环境跑通三 instance 并行
- [ ] 画出 instance 的创建链路（涉及哪四个目录）
- [ ] 解释 tmux 与 worktree 各自负责的隔离维度
- [ ] 能说清 AGPL-3.0 对你二改分发意味着什么

## 七、参考

- 仓库：<https://github.com/smtg-ai/claude-squad>
- 文档站：<https://smtg-ai.github.io/claude-squad/>
