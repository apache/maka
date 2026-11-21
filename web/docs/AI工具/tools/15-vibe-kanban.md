# 15 · vibe-kanban：已经谢幕，但形态永生

> 编排控制层（看板形态） ｜ Stars ~28.0k（2026-09-04） ｜ Rust ｜ Apache-2.0 ｜ [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) ｜ ⚠️ 官方宣布 sunsetting（见仓库顶部与官方博客）
> 学习目标：即使不采用，也要读懂"agent 看板"这个形态的最小实现——它是理解 Multica/Orca 的前置课。

## 一、为什么存在（以及为什么离开）

它曾是"agent 看板"最完整的开源实现：看板 issue 规划任务 → 每个 workspace 给 agent 一条分支、一个终端、一个 dev server → diff 行内评论回传 agent → 一键开 PR。`npx vibe-kanban` 一条命令起全家桶，支持 10+ 编码 agent。

2026 年它官宣 sunsetting。**这条消息本身就是教材**：一个形态正确、star 可观的产品也会退场（赛道拥挤 + 商业化未走通的行业背景）。本篇保留的原因：形态不会死——它的接力者正是 Multica、Orca 这些商业驱动项目。读它是为了懂形态，不是选型它。

## 二、快速入门（仅供研究环境）

```bash
npx vibe-kanban
```

前提是你本机已装并登录至少一个支持的编码 agent。第一次跑通：建一个看板 → 建 issue → 指派给某个 agent → 观察 workspace（分支+终端+dev server）的创建 → 在 diff 上写行内评论 → 看它如何回到 agent。

## 三、熟练掌握（研究目标）

| 概念 | 一句话 |
| --- | --- |
| 看板 issue | 任务的规划单位，状态列即工作流 |
| Workspace | agent 的工位：分支 + 终端 + dev server 三件套 |
| 行内 diff 评论 | 人的审阅意见结构化回流给 agent |
| PR 闭环 | 从 issue 到 merge 的完整链路 |
| 多 agent 切换 | 10+ agent 即插即用 |

核心洞察：它把 Orca 的"worktree 隔离"和 Multica 的"看板流转"各取了一半，做成单机自托管版——这就是为什么懂了它，那两个商业产品对你不再神秘。

## 四、架构设计

Rust 后端（`crates/`）+ Web 前端（`packages/`）+ `npx-cli/`（一条命令的分发壳）+ `shared/`（前后端共享类型）。

最值得解剖的机制是 **workspace 生命周期管理**：从"创建 issue"到"git worktree 建立 → 终端会话拉起 → dev server 探活 → diff 收集 → 清理回收"，这是一整套资源状态机，任何编排层产品都要解这道题。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `crates/` | Rust 后端各模块（workspace/终端/git/agent 适配） |
| `packages/` | 前端与公共资源 |
| `npx-cli/` | npx 分发入口 |
| `shared/` | 前后端共享类型定义 |

建议顺序：`shared/` 的类型定义（形态的骨架）→ `crates/` 里 workspace 状态机 → agent 适配层。带着问题读："一个 issue 的状态变更如何触发 workspace 的资源操作？"

## 六、自测清单

- [ ] 在研究环境跑通"issue → workspace → diff 评论 → PR"全链路
- [ ] 画出 workspace 的资源状态机
- [ ] 能说出它与 Orca/Multica 各自重合的半边
- [ ] 能对别人解释它为什么退场以及这说明什么

## 七、参考

- 仓库（含 sunset 公告链接）：<https://github.com/BloopAI/vibe-kanban>
- 官方博客：<https://www.vibekanban.com/blog/shutdown>
