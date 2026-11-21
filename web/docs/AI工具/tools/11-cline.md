# 11 · cline：从 VS Code 插件长成平台的爬层样本

> IDE 集成层（正在向上爬到编排层） ｜ Stars ~67.4k（2026-09-04） ｜ TypeScript ｜ Apache-2.0 ｜ [cline/cline](https://github.com/cline/cline)
> 学习目标：跑通插件与 CLI 两种形态；观察一个 IDE agent 如何长出 CLI、Kanban、SDK——"平台化"的现场直播。

## 一、为什么存在

VS Code 上最成功的开源编码 agent 之一（曾用名 Claude Dev）。它把"人在环里逐步放权"做到了教科书级：每一步工具调用都要你点批准，diff 逐块审，checkpoint 随时回退。2026 年的动向比历史更重要：仓库首页把 **CLI**（`npm i -g cline`，可 headless 跑 CI/CD）和 **Kanban**（看板管理 agent 任务）并列为门面——它正在复制"引擎 → IDE → 编排"的完整爬层路线，和 OpenHands 的转型互相印证。

## 二、快速入门

```bash
# 方式一：VS Code 扩展市场搜 Cline 安装（最常用）
# 方式二：CLI
npm i -g cline
```

第一次跑通（扩展形态）：侧栏打开 Cline → 配模型 API → 给一个小任务 → **逐步批准它的每个动作**，重点观察：它申请权限时的理由陈述、diff 的呈现方式、任务结束时的 checkpoint。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Plan / Act 两模式 | 先规划后执行，规划阶段不碰代码——最重要的习惯 |
| 逐步审批 | 每个工具调用需人批准，权限粒度可调 |
| Checkpoints | 每步可回退的快照，大胆放权的底气 |
| MCP Marketplace | 一键装外部工具 |
| CLI headless | 同一引擎进 CI/CD 与脚本 |
| Kanban | 任务看板（新）：编排层动作 |

熟练建议：严格用"Plan 模式出方案 → 人改方案 → Act 模式执行"跑一个真实需求，体会"规划与执行分离"对结果质量的影响。

## 四、架构设计

Monorepo：`apps/`（VS Code 扩展、CLI、Kanban 等各产品）、`sdk/`（对外编程接口）、`evals/`、`docs/`。

架构故事与 08 qwen-code 同款：**一个引擎核心，多个宿主形态**。VS Code 扩展是原生宿主，CLI 与 Kanban 是新宿主——读代码时找"引擎与宿主的接缝"（扩展怎么把会话状态传给 CLI？），那里是这个仓库最有价值的部分。

## 五、源码地图与阅读路线

| 目录 | 职责（部分为推断，以仓库文档为准） |
| --- | --- |
| `apps/` | 各产品：编辑器扩展、CLI、Kanban 等 |
| `sdk/` | 对外的编程接口与协议 |
| `evals/` | 评测 |
| `docs/` | 文档源 |

建议顺序：`apps/` 里挑扩展宿主读会话建立 → 审批流（人的每次点击在代码里如何拦截 agent 循环）→ `sdk/` 的对外契约 → `evals/`。带着问题读："审批等待时，agent 循环停在哪一行？"

## 六、自测清单

- [ ] 扩展与 CLI 两种形态各跑通一次
- [ ] 完整走一遍 Plan → Act 流程并说出它为什么省 token
- [ ] 解释 checkpoint 与 git commit 两种回退机制的区别
- [ ] 能描述 cline 正在进行的爬层动作及对应目录

## 七、参考

- 仓库：<https://github.com/cline/cline>
- 文档：<https://docs.cline.bot>
