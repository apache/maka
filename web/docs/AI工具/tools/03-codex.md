# 03 · codex：OpenAI 的 Rust 引擎

> 引擎层 ｜ Stars ~121.2k（2026-09-04） ｜ Rust ｜ Apache-2.0 ｜ [openai/codex](https://github.com/openai/codex)
> 学习目标：跑通它；理解 Rust workspace 组织一个 agent 引擎的方式，以及"订阅即用量"的商业模式设计。

## 一、为什么存在

OpenAI 官方的本地编码 agent，与 claude-code 同型：终端里跑 agent 循环、改代码、执行命令。差异点有三：核心用 Rust 写（性能与分发友好，单二进制）；登录 ChatGPT 账号即可按订阅用量使用（不强制 API key）；同一个品牌下有完整矩阵——CLI、IDE 扩展（VS Code/Cursor/Windsurf）、桌面 `codex app`、云端 Codex Web。本仓库只覆盖本地侧（CLI + SDK）。

## 二、快速入门

Windows（PowerShell）：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"
```

macOS/Linux：

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
# 或 npm install -g @openai/codex
# 或 brew install --cask codex
```

第一次跑通：运行 `codex`，选 **Sign in with ChatGPT**（Plus/Pro/Business 等订阅内含用量），进项目让它改一个文件，观察它对沙箱/审批的默认策略。

## 三、熟练掌握

| 概念 | 一句话 |
| --- | --- |
| 两种认证 | ChatGPT 订阅登录（推荐）或 API key（需额外配置） |
| 沙箱模式 | 命令执行的限制级别，从只读到全权，按风险分级 |
| IDE / App / Web | 同一能力的四种交付面，本地仓库对应 CLI 与 IDE |
| sdk/ | 官方编程接入，把 codex 嵌进自己的工作流 |

熟练方向：把审批策略调到适合自己的风险水平；对比它和 claude-code 在同一任务上的 diff 风格差异。

## 四、架构设计

顶层目录直接暴露了工程决策：`codex-rs/`（Rust 核心实现，真正的引擎）、`codex-cli/`（命令入口）、`sdk/`、`docs/`、`bazel/`（构建）。

关键取舍：**用 Rust 换分发与性能**——单文件二进制、启动快、无 Node 运行时依赖，这对"装到每台开发机"是实打实的好处；代价是迭代速度与生态插件开发门槛（TypeScript 生态改一行就能发扩展，Rust 要过编译）。它和 goose（同为 Rust 引擎）是"Rust agent 引擎"的两个代表样本。

## 五、源码地图与阅读路线

| 目录 | 职责 |
| --- | --- |
| `codex-rs/` | 引擎主体（Rust workspace，按 crate 切分） |
| `codex-cli/` | CLI 入口与分发 |
| `sdk/` | 编程接入层 |
| `docs/` | 官方文档源 |
| `bazel/`、`third_party/`、`tools/` | 构建与工具链 |

建议顺序：`docs/` 里过一遍架构性描述 → `codex-rs/` 找 core crate（agent 循环与工具执行）→ 对照 `sdk/` 看对外契约。带着问题读："审批（approval）在引擎的哪一层被强制？"

## 六、自测清单

- [ ] 用 ChatGPT 订阅方式登录成功并完成一次真实修改
- [ ] 能说出沙箱/审批分级如何影响安全性
- [ ] 能解释"Rust 引擎 vs Node 引擎"在分发上的差异
- [ ] 在 `codex-rs/` 里定位到工具调用执行的代码位置

## 七、参考

- 仓库：<https://github.com/openai/codex>
- 开发者文档：<https://developers.openai.com/codex/>
