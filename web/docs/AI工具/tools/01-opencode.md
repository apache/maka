# 01 · opencode：开源编码 agent 的头牌

> 引擎层 ｜ Stars ~203.5k（2026-09-04） ｜ TypeScript ｜ MIT ｜ [anomalyco/opencode](https://github.com/anomalyco/opencode)
> 学习目标：跑通它；理解"client/server 架构的 agent"与"单体 TUI agent"的本质区别。

## 一、为什么存在

官方一句话：The open source AI coding agent。它存在的意义是给"闭源订阅制 agent"一个开源对照物：模型随便接（任何 OpenAI/Anthropic 兼容 API、本地模型）、代码随便读、TUI 与桌面端随便挑。原仓库名 `sst/opencode`，2026 年已迁至 `anomalyco` 组织——**引用它的资料时先确认仓库地址还有效**。

它不解决的问题：不替你管团队流程（那是 Multica/看板层的事），不提供模型账号。

## 二、快速入门

Windows（Git Bash/PowerShell 皆可）：

```bash
# 官方脚本
curl -fsSL https://opencode.ai/install | bash

# 或 npm / scoop / choco
npm i -g opencode-ai@latest
scoop install opencode
```

第一次跑通：

```bash
cd 你的项目
opencode          # 进入 TUI
# 按提示配置 provider（API key 或本地模型），然后直接对话让它改一个文件
```

也有桌面 App（BETA，releases 页下载 dmg/exe），和 TUI 连的是同一套服务端。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Provider | 模型接入配置，随时切，不绑一家 |
| Session | 一次会话的完整上下文，可分享、可回放 |
| TUI / Desktop | 两个前端，同一个 agent 服务 |
| 自定义 | AGENTS.md、自定义命令、MCP 工具接入 |

日常工作流建议：先在单人项目里用它完成"提需求 → 审 diff → 提交"完整循环；再试接一个本地模型（Ollama），体会"引擎与模型解耦"到底是什么手感。

## 四、架构设计

从仓库结构能读出它的核心决策：**agent 做成服务（server），界面只是客户端**。`packages/` 下同时存在 TUI、console、web、desktop 等多个前端，`sdks/` 提供编程接入，`specs/` 存放协议规范。

这样设计的收益：换界面不换引擎、第三方可以基于 SDK 造工具、会话状态集中在服务端一处。代价：部署面比单体 CLI 大一点，进程间协议成为长期维护对象。

对比记忆：claude-code 是"单体进程"思路，opencode 是"client/server"思路。两者是引擎层最值得对照的两种形态。

## 五、源码地图与阅读路线

目录来自 2026-09-04 仓库顶层：

| 目录 | 职责（部分为推断，以仓库内文档为准） |
| --- | --- |
| `packages/` | 各产品包：TUI、console、web、desktop 等 |
| `sdks/` | 供第三方编程接入的 SDK |
| `specs/` | 协议/接口规范——**先读这里**，是理解全局的钥匙 |
| `infra/` | 部署与基础设施 |
| `nix/`、`script/`、`patches/` | 构建与发布工程 |

建议顺序：`specs/` → `packages/` 里挑一个最薄的前端 → 服务端会话管理代码。带着问题读："一次对话的消息与工具调用存在哪？谁有权改它？"

## 六、自测清单

- [ ] 能不查文档说出 opencode 的安装与启动命令
- [ ] 能解释 client/server 架构给 opencode 带来的两个好处和一个代价
- [ ] 接通过至少一个云 API 和一个本地模型
- [ ] 能在 `specs/` 里找到它的协议定义并说出一条

## 七、参考

- 仓库：<https://github.com/anomalyco/opencode>（有简体中文 README）
- 官网与文档：<https://opencode.ai>
