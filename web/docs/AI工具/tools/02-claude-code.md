# 02 · claude-code：事实标准，以及"闭源 agent 怎么学"

> 引擎层 ｜ Stars ~143.9k（2026-09-04） ｜ CLI 闭源（仓库为文档/插件/示例） ｜ Anthropic 商业条款 ｜ [anthropics/claude-code](https://github.com/anthropics/claude-code)
> 学习目标：用熟它；同时学会一门特殊技能——**如何解剖一个读不到源码的 agent**。

## 一、为什么存在

Anthropic 官方 agent，终端优先：`claude` 一敲，理解代码库、跑命令、改文件、走 git 流程，也能在 IDE 里用、在 GitHub 上 @claude。它是整个生态的"参照系"——Orca、Multica、cc-switch 等编排工具都把它列为第一驱动对象。学它不是因为开源，是因为**整个行业的交互词汇表（斜杠命令、CLAUDE.md、hooks、subagent）是它定义的**。

注意两个事实：npm 安装方式已标记废弃（推荐官方安装脚本或 winget）；仓库本身不含 CLI 源码（GitHub 语言显示 Python 只是示例脚本所致），许可为 Anthropic 商业条款。

## 二、快速入门

Windows（PowerShell）：

```powershell
irm https://claude.ai/install.ps1 | iex
# 或 winget install Anthropic.ClaudeCode
```

macOS/Linux（Git Bash 里同样可用 curl）：

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

第一次跑通：进项目目录，运行 `claude`，登录账号，让它"总结这个仓库的结构"。然后试斜杠命令 `/help`。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| CLAUDE.md | 项目级/全局记忆，每次会话自动注入 |
| 斜杠命令 | `/help`、`/compact`（压缩上下文）等会话控制 |
| Hooks | 在工具调用前后挂你自己的脚本——闭源系统里最重要的扩展点 |
| Subagents | 派生独立上下文的子 agent，隔离爆炸半径 |
| MCP | 接外部工具的标准协议 |
| 插件 | 仓库 `plugins/` 目录提供官方插件示例 |

熟练的标志不是背命令，而是：知道什么时候该写进 CLAUDE.md、什么时候用 hook、什么时候开 subagent——即**上下文工程的三种投放位置**。

## 四、架构设计

源码不可读，架构从可观测行为学：单进程本地运行；对话与工具调用循环在本地完成，模型推理走 Anthropic API；权限模型是"每类工具首次使用需批准"，可用配置放宽或收紧。这是典型的**信任边界在本地、智能在云上**的形态。

想研究"同款架构的开源实现"，对照读本目录的 01 opencode 和 08 qwen-code；想编程化使用同一能力，看官方 Agent SDK（`anthropics/claude-agent-sdk-python`，~8k stars）。

## 五、源码地图（改为：生态解剖法）

仓库顶层只有：`plugins/`、`examples/`、`scripts/`、`.claude-plugin/` 等——没有引擎源码。所以本篇的"源码地图"换成三步解剖法：

1. **读它的插件与示例**：`plugins/` 与 `examples/` 展示官方期望的扩展姿势；
2. **读配置面**：CLAUDE.md、settings、hooks 的组合构成它的全部"可编程表面"；
3. **行为对照**：同一个任务分别丢给 claude-code 和 opencode，对比工具调用序列，反推各自的 agent 循环策略。这是研究闭源 agent 唯一可靠的方法。

## 六、自测清单

- [ ] 安装并能区别 `claude`（交互）、`claude -p`（一次性）两种用法
- [ ] 写过一个生效的 CLAUDE.md 和一个 hook
- [ ] 能说出 npm 安装为何被废弃（官方脚本管理自更新更可靠）
- [ ] 能对别人解释"为什么这个仓库 143k star 但没有引擎源码"

## 七、参考

- 仓库：<https://github.com/anthropics/claude-code>
- 官方文档：<https://code.claude.com/docs/en/overview>
- Agent SDK（Python）：<https://github.com/anthropics/claude-agent-sdk-python>
