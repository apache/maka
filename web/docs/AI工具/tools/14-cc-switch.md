# 14 · cc-switch：130k 星的"配置管理" Nickname 冠军

> 编排控制层（配置与供应商管理） ｜ Stars ~130.9k（2026-09-04） ｜ Rust + Tauri 2 ｜ MIT ｜ [farion1231/cc-switch](https://github.com/farion1231/cc-switch)
> 学习目标：跑通它；理解"agent 时代的新痛点——配置与供应商碎片化"，以及 Tauri 2 桌面应用架构。

## 一、为什么存在

痛点很具体：你同时用 Claude Code、Codex、Gemini CLI、OpenCode、OpenClaw……每家有自己的配置文件、API 端点、key 格式；在国内还要在官方与各种中转服务之间切换。**CC Switch 把这些工具的供应商配置统一管理、一键切换**，覆盖 Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw、Hermes Agent。

注意它的层：它不编排任务、不派活，只管"这些 agent 连谁、用什么 key"——是编排层里最薄也最刚需的一刀。它的 README 满口中转服务商赞助，恰是这个痛点商业价值的证明。

## 二、快速入门

从 [releases](https://github.com/farion1231/cc-switch/releases) 下载对应平台安装包（Windows/macOS/Linux）。第一次跑通：打开 → 添加 Claude Code 的两个供应商配置（比如官方 + 一个中转）→ 一键切换 → 回终端验证 `claude` 确实走了新配置。整个过程不碰任何配置文件。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 供应商配置集 | 每个工具的多套端点+key 预设 |
| 一键切换 | 改写目标工具的配置文件并生效 |
| 全家桶覆盖 | 主流 agent CLI 皆在支持列表 |
| 配置备份 | 切换不丢历史配置 |

熟练建议：切换后去翻各工具的真实配置文件位置（`~/.claude` 等），核对它改了什么——这一步让你永久记住**每个 agent 的配置落在哪**，比读十篇教程都牢。

## 四、架构设计

Tauri 2 应用：`src-tauri/`（Rust 后端：配置读写、文件操作、系统集成）+ `src/`（Web 前端界面）+ `flatpak/`（Linux 打包）。

值得学的两点：**Tauri 2 路线**——对比 Electron（本目录桌面工具多为 Electron），Tauri 用系统 WebView 换来小体积与低内存，代价是前端环境一致性；**"管配置不碰进程"**——它不启动、不监控 agent，只改文件，因此几乎不会与任何 agent 版本冲突。这是最小侵入设计的胜利：痛点越小刀越薄，普及越快。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `src-tauri/` | Rust 核心：各工具配置文件的读写与切换逻辑 |
| `src/` | 前端界面 |
| `tests/`、`docs/`、`flatpak/` | 测试、文档、Linux 打包 |

建议顺序：`src-tauri/` 里找"某工具配置文件路径与改写规则"的定义表（这是全仓库最有信息量的数据结构）→ Tauri 的前后端通信命令 → 前端状态管理。代码量不大，Go/Rust 初学者友好。

## 六、自测清单

- [ ] 成功为一个工具配置两套供应商并来回切换
- [ ] 手动核对该工具配置文件被改写的内容
- [ ] 能说出 Tauri 与 Electron 的取舍各一项
- [ ] 能解释"只管配置不碰进程"为什么让它几乎零冲突

## 七、参考

- 仓库：<https://github.com/farion1231/cc-switch>（有中文 README）
- 官网：<https://ccswitch.io>
