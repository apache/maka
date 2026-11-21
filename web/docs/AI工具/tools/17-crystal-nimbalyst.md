# 17 · crystal → Nimbalyst：一次"改名重来"的产品迭代

> 编排控制层（worktree 并行会话） ｜ Stars ~3.1k（2026-09-04，原仓库已停更） ｜ TypeScript (Electron) ｜ MIT ｜ [stravu/crystal](https://github.com/stravu/crystal) → 继任者 [Nimbalyst/nimbalyst](https://github.com/Nimbalyst/nimbalyst)
> 学习目标：理解 Crystal 的"多会话 + worktree 隔离"设计；同时把这个仓库当"产品如何废弃与重生"的案例读。

## 一、为什么存在

Crystal（已废弃，2026-02）曾是一个 Electron 桌面应用：并排管理多个 Claude Code / Codex 会话，每个会话跑在独立 git worktree 里，支持对比、测试、择优合并——与 claude-squad 同思路的图形界面版，出自 Stravu 团队。

它的继续方式是**换代而非维护**：原仓库顶部明确宣布 Crystal deprecated，继任产品为 **Nimbalyst**（AI 原生工作区：agent 把编辑流式写进打开的编辑器、Markdown/表格/图表多编辑器、本地优先文件模型、扩展优先架构、仍是 Electron）。本篇两个学习对象并存：旧仓库读"并行会话管理"，新项目读"工作区产品化"。

## 二、快速入门

研究旧版：从 `stravu/crystal` releases 下载，或克隆构建（`frontend/` + `main/` 的 Electron 结构）。推荐直接跟进新版：从 <https://nimbalyst.com/> 下载 Nimbalyst，文档在 <https://docs.nimbalyst.com/>。

第一次跑通（任一版本）：新建项目 → 起两个并行会话（各自 worktree）→ 给出两个不同实现方向 → 对比结果 → 合并其一。这套"**赛马（race）工作流**"是并行会话工具的招牌用法。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 并行会话 | 多个 agent 同时开跑，互不污染 |
| Worktree 隔离 | 每会话一份独立工作副本 |
| 赛马工作流 | 同一任务多方向求解，择优合并 |
|（Nimbalyst）流式编辑 | agent 的修改实时写进你打开的编辑器 |
|（Nimbalyst）本地优先 | 文件模型基于 Markdown/JSON/CSV 等开放格式 |

熟练判断：这两个项目规模都小，掌握的标志是能向别人复述"并行会话工具 = 会话管理 + worktree 隔离 + diff 对比 + 择优合并"四件套，并指出每一件在 UI 上的落点。

## 四、架构设计

Crystal：`frontend/`（渲染进程）+ `main/`（Electron 主进程：会话调度、worktree 操作、与 claude-code 等 CLI 的进程通信）+ `shared/`（跨进程类型）。Nimbalyst 宣称的架构关键词：扩展优先（自定义编辑器/文件类型）、统一编辑器生命周期（不同编辑器共用同一套 AI 集成）。

值得学的取舍：**废弃重写 vs 长期维护**——当产品假设变化足够大（从"会话管理器"到"AI 原生工作区"），带包袱迭代可能比重写更贵。这与 OpenHands 的原地转型形成对照：两种策略没有对错，取决于引擎是否需要换血。

## 五、源码地图与阅读路线

| 目录（crystal） | 职责 |
| --- | --- |
| `main/` | Electron 主进程：会话调度与 worktree 管理——**核心** |
| `frontend/` | 渲染进程 UI |
| `shared/` | 进程间共享类型 |
| `docs/`、`tests/` | 文档与测试 |

建议顺序：`main/` 里找"创建会话 → 建 worktree → 拉起 agent CLI 子进程"的链路 → `frontend/` 的会话面板状态。代码量小，配合 16 claude-squad 对读（同一问题的 Go 终端版 vs TS 桌面版）收获最大。

## 六、自测清单

- [ ] 跑通一次双会话赛马工作流（任一版本）
- [ ] 说出并行会话四件套及各自落点
- [ ] 能对比"废弃重写"（本篇）与"原地转型"（10 OpenHands）两种策略
- [ ] 知道 Crystal 已废弃、新去处是 Nimbalyst

## 七、参考

- 原仓库（含废弃公告）：<https://github.com/stravu/crystal>
- 继任者：<https://github.com/Nimbalyst/nimbalyst> · <https://nimbalyst.com/>
