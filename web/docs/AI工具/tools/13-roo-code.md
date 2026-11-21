# 13 · roo-code：Mode 系统的代表作（并已放缓）

> IDE 集成层 ｜ Stars ~24.3k（2026-09-04） ｜ TypeScript ｜ Apache-2.0 ｜ [RooCodeInc/Roo-Code](https://github.com/RooCodeInc/Roo-Code) ｜ ⚠️ 2026-05 后推送放缓，主力贡献者分流至 Kilo
> 学习目标：掌握 Mode（角色化 agent）设计；同时把这个仓库当"如何判断项目活跃度"的活教材。

## 一、为什么存在

VS Code 里的多角色 agent（出身是 cline 的社区分支 roo-cline，扩展 ID 至今还是 `RooVeterinaryInc.roo-cline`——这本身就是教学点：**fork 产品的出身常藏在不易改的角落**）。它的招牌贡献是 **Mode 系统**：同一个引擎套不同角色皮肤——Code（日常改码）、Architect（出方案）、Ask（答疑）、Debug（排查）、Custom（自定义团队角色），不同 Mode 可绑定不同模型。

**采用前必读**：本目录多篇文档强调"stars 高 ≠ 活跃"，Roo Code 是最典型案例——24k 星，但 2026 年中后推送明显减少，社区能量已大量流向 Kilo。学习 Mode 设计不受影响；生产采用请先评估。

## 二、快速入门

VS Code 扩展市场安装（搜 Roo Code）。第一次跑通：配 API → 用 **Architect Mode** 让它为一个功能出方案 → 切到 **Code Mode** 执行方案。这个两步流是它的精髓用法。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Mode | 角色预设：系统提示 + 可用工具 + 绑定模型的组合 |
| Architect → Code | 方案与执行分离的最小实践 |
| Custom Mode | 把团队规范固化成角色（如"只写测试的 QA Mode"） |
| MCP 支持 | 外部工具接入 |

熟练建议：为你团队最重复的一类工作写一个 Custom Mode（限定工具与提示），体会"角色 = 约束集合"这个定义——Mode 不是皮肤，是权限与注意力的裁剪。

## 四、架构设计

Monorepo：`src/`（扩展核心）、`webview-ui/`（编辑器内前端）、`apps/` 与 `packages/`（周边与共享包）、`locales/`（20+ 语言）。Mode 系统在架构上是**提示层 + 工具白名单 + 模型路由**的三元组，实现成本不高但产品价值巨大——这是"用约束换质量"的又一例证。

它的分裂史也是架构课：社区分支 → 主线（Roo）→ 再分支（Kilo）。判据还是那条："引擎和宿主的接缝在哪，分叉就发生在哪。"

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `src/` | 扩展核心：agent 循环、审批、Mode 管理 |
| `webview-ui/` | 编辑器内的对话与 diff 界面 |
| `apps/`、`packages/` | 周边应用与共享包 |
| `locales/` | 多语言文案 |

建议顺序：`src/` 里找 Mode 的定义与切换逻辑 → Mode 如何过滤工具集与路由模型 → `webview-ui/` 的 diff 审批界面。带着问题读："切换 Mode 时，会话上下文是继承还是重建？"

## 六、自测清单

- [ ] 完成 Architect → Code 两步流
- [ ] 自建一个 Custom Mode 并说清它的三要素（提示/工具/模型）
- [ ] 能讲述 Roo → Kilo 的分流过程及其架构动因
- [ ] 知道判断这类项目活跃度的两个命令指标

## 七、参考

- 仓库：<https://github.com/RooCodeInc/Roo-Code>（有简体中文 README：`locales/zh-CN/`）
- 文档：<https://roocodeinc.github.io/Roo-Code/>
