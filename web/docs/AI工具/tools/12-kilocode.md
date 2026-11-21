# 12 · kilocode：发行版策略与"零加价"商业模式

> IDE 集成层 ｜ Stars ~27.2k（2026-09-04） ｜ TypeScript ｜ MIT ｜ [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode)
> 学习目标：理解"发行版（distribution）"策略——站在别人的代码基座上做差异化；看清零加价模型服务的商业逻辑。

## 一、为什么存在

Kilo 的路线图写的就是行业整合史：起家于 Roo Code/Cline 社区分支（VS Code 插件），2026 年与 opencode 代码基座合流（仓库里 `.opencode/`、`specs/`、`nix/` 等目录与 opencode 同构即是证据），现在以三形态交付：**VS Code、JetBrains 原生、CLI**。

它的商业差异点：聚合 500+ 模型、**按模型商原价转售、零加价**，且起步不需要自己配 API key。这回答了一个真问题——"我想用各家模型但懒得管五家账号"。

## 二、快速入门

```bash
# VS Code：扩展市场搜 Kilo Code
# CLI：
npm install -g @kilocode/cli
# 或 brew install Kilo-Org/tap/kilo
```

第一次跑通：装扩展 → 建账号 → 选一个模型（免费/自带 key 皆可）→ 提一个小需求 → 中途换另一个模型接着干，验证"任务内换模型"的连贯性。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 三形态 | VS Code / JetBrains / CLI，同一账号体系 |
| 零加价模型 | 按 provider 原价计费，Kilo 不赚差价（赚其他增值） |
| 任务内换模型 | 简单步骤用便宜模型，难点换强模型 |
| opencode 基座 | 代码结构与 opencode 对齐，可互相印证 |

熟练建议：实践"分层用模"——重构计划用旗舰模型、机械修改用便宜模型，在 Kilo 的任务流里观察省了多少、质量差多少。

## 四、架构设计

Monorepo（`packages/` 为主体，另有 `bin/`、`translations/`、`specs/`）。架构上的可学点不是某个模块，而是**发行版工程学**：

1. 基座选已验证的上游（opencode），省下引擎研发；
2. 差异化放在上游不做的层（JetBrains 原生支持、模型聚合计费）；
3. 保持与上游的结构对齐，降低长期合并成本（同构目录就是为此服务）。

代价：命脉部分握在别人手里，上游方向变化时要么跟、要么分叉——历史上它与 Roo/Cline 的分道就是先例。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `packages/` | 各包主体（与 opencode 布局对齐） |
| `bin/` | CLI 入口 |
| `translations/` | 多语言（含简体中文 README） |
| `specs/`、`docs/` | 规范与文档 |

建议顺序：先读 01 opencode 建立基线认知 → 本仓库找"同构之上的增量"（JetBrains 支持、计费聚合在哪个包）→ 对比两仓库 `specs/` 的异同。带着问题读："哪些目录是跟着上游走的，哪些是 Kilo 自有的？"

## 六、自测清单

- [ ] 三形态中任选两种各跑通一次
- [ ] 完成一次任务内模型切换并记录体验差异
- [ ] 能说出发行版策略的三个收益和一个风险
- [ ] 能指出仓库中证明"opencode 基座"的三个结构证据

## 七、参考

- 仓库：<https://github.com/Kilo-Org/kilocode>（有简体中文 README）
- 官网：<https://kilo.ai>
