# 07 · crush：Charm 出品的最美终端 agent

> 引擎层 ｜ Stars ~27.9k（2026-09-04） ｜ Go ｜ 许可证为自定义文本（GitHub 未标注 SPDX，商用前读 LICENSE） ｜ [charmbracelet/crush](https://github.com/charmbracelet/crush)
> 学习目标：跑通它；把它当 Go 项目组织样本（`internal/` 单目录架构）与 LSP 增强上下文的案例读。

## 一、为什么存在

Charm（bubbletea 等著名 TUI 库的作者）的编码 agent。卖点三连：**颜值**（Charm 生态的审美一脉相承）、**LSP 增强**（用语言服务器给模型补上下文，像你自己用 IDE 那样）、**会话中换模型不断上下文**。支持 macOS/Linux/Windows/Android/BSD 几乎所有终端。它证明了一件事：引擎层的功能趋同后，体验与上下文质量是差异化主战场。

## 二、快速入门

Windows：

```powershell
winget install charmbracelet.crush
# 或 scoop install crush（先加 charm bucket）
```

macOS/Linux：

```bash
brew install charmbracelet/tap/crush
npm install -g @charmland/crush
```

第一次跑通：项目目录运行 `crush`，按提示配一个 OpenAI/Anthropic 兼容 API，让它改一个函数；中途用会话内命令切另一个模型，验证上下文保留。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| Multi-Model | 自选或自接 OpenAI/Anthropic 兼容 API |
| 会话中换模型 | 上下文不丢，随时换脑子 |
| Session | 每项目多会话、多上下文并存 |
| LSP 增强 | 语言服务器提供符号/类型上下文，超出纯文本检索 |
| MCP | http/stdio/sse 三种方式接外部工具 |

熟练建议：在一个 TypeScript 项目里体会 LSP 增强与"纯 grep 派"（aider 的 repo map 是另一条路）的差别——这是**上下文工程两条路线**的实地对比。

## 四、架构设计

Go 项目，顶层只有 `internal/`、`docs/`、`scripts/`。所有实现都在 `internal/` 里按包切分——Go 社区典型的"不导出即不承诺"风格：对外只有一个二进制，内部结构随时重排。

取舍：TUI 直接构建在 Charm 自家生态（bubbletea/lipgloss）上，体验一致性极强；代价是深度绑定自家栈，社区贡献者需要先熟悉 Charm 全家桶。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `internal/` | 全部实现：agent 循环、LSP 集成、会话、provider、TUI |
| `docs/` | 文档 |
| `scripts/` | 构建发布 |

建议顺序（Go 入门友好，代码量适中）：TUI 入口 → 会话状态管理 → **LSP 集成代码**（最有学习价值）→ provider 抽象。带着问题读："LSP 的符号信息以什么形式、什么时机进入 prompt？"

## 六、自测清单

- [ ] 跑通并在会话中完成一次模型切换
- [ ] 能说出 LSP 增强与 grep/repo map 两条上下文路线的优劣
- [ ] 能解释 Go 的 `internal/` 惯例对本项目意味着什么
- [ ] 在 `internal/` 里定位到 MCP 工具的注册点

## 七、参考

- 仓库：<https://github.com/charmbracelet/crush>
- Charm 生态：<https://charm.sh>
