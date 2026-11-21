# 05 · goose：基金会治理的通用 Rust agent

> 引擎层 ｜ Stars ~53.9k（2026-09-04） ｜ Rust ｜ Apache-2.0 ｜ [aaif-goose/goose](https://github.com/aaif-goose/goose)
> 学习目标：跑通它；理解"通用 agent 与编码 agent 的分野"，以及基金会治理对公司 backing 项目的意义。

## 一、为什么存在

Block（Square 的母公司）开源的 agent，现已移交 **Agentic AI Foundation（Linux 基金会旗下）**治理。它的自我定位刻意比"编码 agent"宽：桌面 App + CLI + API 三种形态，管代码也管研究、写作、自动化、数据分析。它是"通用 agent"阵营的代表——对照本目录其余编码专用引擎，体会"工具集与默认提示向通用任务倾斜"意味着什么。

原仓库 `block/goose` 已迁至 `aaif-goose`，引用资料注意地址。

## 二、快速入门

```bash
# CLI
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash
# 桌面版从 goose-docs.ai 下载（macOS/Linux/Windows）
```

第一次跑通：`goose` 启动后按提示配 provider（15+ 家：Anthropic/OpenAI/Google/Ollama/OpenRouter/Azure/Bedrock…，也可经 ACP 用你已有的 Claude/ChatGPT/Gemini 订阅），让它做一件非编码的事（比如整理一个目录并写报告），感受通用定位。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 多 Provider | 15+ 家模型接入，API key 或订阅（ACP）皆可 |
| MCP 扩展 | 70+ 扩展，接入外部系统的主要方式 |
| 三形态 | 桌面 App / CLI / API，同一引擎 |
| 自定义发行版 | CUSTOM_DISTROS.md：预配 provider、扩展与品牌的"goose 分发" |

熟练建议：写一个自己的 MCP 扩展挂上去；再试 CUSTOM_DISTROS 思路，把"一套团队标准配置"固化成分发——这是把 agent 工程化的组织级玩法。

## 四、架构设计

Rust workspace：`crates/` 装引擎与各组件，`ui/` 桌面前端，`services/` 服务端相关，`documentation/` 文档源。

值得学的取舍：**Rust 带来的跨平台单机体验**（桌面 App 也基于同一引擎，性能与体积可控）；**基金会治理带来的中立性**——模型接入不做排他，代码路线由社区流程决定，这对"要不要把工作流绑在单一厂商 agent 上"是一种对冲。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `crates/` | Rust 引擎各 crate（agent 循环、provider 适配、扩展系统） |
| `ui/` | 桌面应用前端 |
| `services/` | 服务化组件 |
| `documentation/` | 文档源（goose-docs.ai） |
| `evals/`、`examples/`、`workflow_recipes/` | 评测、示例与工作流配方 |

建议顺序：`crates/` 里找 provider 适配层（看"多模型接入"怎么抽象）→ MCP 扩展的注册与调用路径 → `evals/`。带着问题读："同一个 agent 循环，如何同时服务桌面、CLI、API 三种宿主？"

## 六、自测清单

- [ ] CLI 与桌面版各跑通一次
- [ ] 接通过一个非 Anthropic/OpenAI 的 provider（如 Ollama）
- [ ] 能说出 ACP 在 goose 里解决的问题
- [ ] 能对别人解释"基金会治理"对用户实际意味着什么

## 七、参考

- 仓库：<https://github.com/aaif-goose/goose>
- 文档：<https://goose-docs.ai>
- 治理：<https://github.com/aaif-goose/goose/blob/main/GOVERNANCE.md>
