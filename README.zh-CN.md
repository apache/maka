# Maka

[![CI](https://github.com/Maka-Agent/maka-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/Maka-Agent/maka-agent/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![docs](https://img.shields.io/badge/docs-English-blue?logo=googletranslate&logoColor=white)](./README.md)

![Maka——你的工作，你的 Agent。](./.github/assets/maka-hero.zh-CN.png)

**一个为真实工作而生的本地优先 Agent 工作台。**

Maka 不只回答问题。它可以在受控权限下阅读项目、执行工具、生成产物，并把模型消息和工具调用保存为可恢复的运行事实。桌面应用、终端 TUI、非交互 CLI 和 Maka 评测 subject 都通过 Runtime Host 执行。

> [!IMPORTANT]
> Maka 仍在活跃开发中。macOS Apple Silicon 桌面版是首个早期公开版本，数据格式、CLI 和实验能力仍可能变化。

## 为什么是 Maka

- **本地优先，而不是云端托管优先**：会话、设置和运行记录默认保存在本机；模型连接由你配置，可以使用云 API、本地模型或兼容网关。
- **Log is the Runtime**：模型消息、Tool Call、Tool Result 和终止事实进入 Runtime Event Log，Session、UI、模型上下文和恢复逻辑从日志生成投影。
- **上下文不是历史本身**：Tool Result prune 和 LLM Compaction 只改变下一次推理看到什么，不把已记录的证据当作上下文垃圾删除。
- **唯一执行 authority**：Runtime Host 拥有 Session、Turn、agent lifecycle、continuation、tools 和 events；Eval 只拥有实验语义与结果。

完整设计见 [Maka Backend Architecture](./ARCHITECTURE.zh-CN.md)。

## 运行形态

| 入口 | 适合什么 | 当前能力 |
|---|---|---|
| **Desktop** | 日常交互、文件与 Artifact 工作流、模型和权限配置 | Electron + React，支持流式会话、工具时间线、分支、搜索和恢复 |
| **TUI / CLI** | 在当前工程目录中使用 Maka，或执行单次非交互 Turn | `maka`、`maka run`，复用 Desktop 的 workspace 和模型连接 |
| **Eval** | Maka 与外部 subject 的可复现实验 | `maka eval run <spec> --out <directory>` |

## 当前能力

### Agent Runtime

- 多模型连接、流式输出、thinking、usage 和 provider error normalization；
- `Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep` 等本地工具；
- Tool schema validation、动态 availability、permission policy、watchdog、abort 和错误分类；
- Runtime Event Log、AgentRun ledger、启动恢复、Turn Evidence、active tool prune 与 history compaction。

### Desktop Workspace

- 会话创建、归档、搜索、重命名、重试、重新生成和从 Turn 分支；
- Artifact 列表与预览、workspace instructions、模型与权限设置；
- 本地记忆、联网搜索和机器人入口；
- 不同集成需要单独配置，并非所有实验入口默认可用。

### Evaluation

- 声明式多臂 Experiment 展开为 task × repetition × subject cell；
- 每个 cell 使用 immutable attempt，基础设施失败只替换该 cell，并选择最早有效 attempt；
- 通用结果只包含 score、normalized usage、可归因 cost、duration、status/failure reason 与 artifacts；
- Maka subject 只通过 Runtime Host 执行，外部竞品使用 generic external subject adapter。

## 快速开始

### 下载 macOS 桌面版

已签名并完成 Apple 公证的桌面应用可从 [GitHub Releases](https://github.com/Maka-Agent/maka-agent/releases/latest) 下载，目前仅支持 Apple Silicon Mac（`arm64`）。

1. 下载 `Maka-<version>-mac-arm64.dmg`；
2. 打开 DMG，将 Maka 拖入“应用程序”；
3. 执行 `brew install ripgrep`，启用 Runtime 的 `Grep` 工具；
4. 启动 Maka，在`设置 → 模型`中配置自己的模型连接。

首个公开版本不包含 Computer Use，暂不支持 Intel Mac、Windows 和 Linux 安装包。

### Windows x64 预览版

Windows 目前仍是未签名预览版，不属于正式支持的平台。当某个 release 包含 Windows 资产时，
请先阅读 [Windows 预览版安装与校验指南](docs/windows-support.md#安装-windows-x64-预览版)，再运行
`Maka-<version>-win-x64.exe`。SmartScreen 会将安装包显示为未知发布者；只有从同一 release 下载
并确认 SHA-256 与发布的校验文件一致后，才应选择绕过该提示。

### 环境要求

- Node.js 22（当前 CI 基线）；
- npm（仓库 lockfile 和 scripts 以 npm 为准，`packageManager` 当前为 npm 11）；
- Git；
- `ripgrep`，供 Runtime 的 `Grep` 工具使用。

### 启动 Desktop

```sh
git clone https://github.com/Maka-Agent/maka-agent.git
cd maka-agent
npm ci
npm run dev
```

`npm run dev` 启动带 HMR 的 Desktop 开发环境。需要先完整构建再启动 Electron 时使用：

```sh
npm run dev:full
```

如果安装时设置过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，启动前需要补装 Electron 平台二进制：

```sh
node node_modules/electron/install.js
```

### 第一次运行

Maka 不内置共享模型账号。第一次打开时：

1. 进入 `设置 → 模型`；
2. 添加一个 API、本地模型或已经接通的账号连接；
3. 测试连接并选择默认模型；
4. 返回工作台开始任务。

应用会根据真实连接状态区分“已配置”“可发送”和“实验入口”，不会把没有接入 Runtime 的账号展示成可用模型。

## 使用终端入口

先构建 workspace：

```sh
npm run build
```

然后可以启动 TUI 或执行单次 Turn：

```sh
npm --workspace maka-agent exec -- maka
npm --workspace maka-agent exec -- maka run "总结当前仓库并指出最重要的风险"
npm --workspace maka-agent exec -- maka run --graph "并行实现两个切片，完成集成，然后独立审查"
npm --workspace maka-agent exec -- maka --help
```

TUI 同时支持 `/graph on`、`/graph off` 和 `/graph <任务>`。非交互
`--graph` 会等待持久化 Graph 真正结束，再输出 supervisor 的最终结果。
Graph 的 implementation operator 使用隔离的 Git worktree，因此源项目必须是干净的
Git worktree。

CLI 读取 Desktop 写入的同一份模型连接和 workspace 配置。评测 spec 和 adapter 位于 [`packages/eval`](./packages/eval)。

## 架构

Maka 后端可以用一条主线概括：

```text
Desktop / TUI / CLI → Runtime Host → SessionManager → AgentRun
                                             ↓
                         Model + Tool Runtime → Runtime Event Log
                                             ↓
                              Context / Session / UI projections

Experiment → Cells → Attempts → Results
                    ↓
       Runtime Host 执行 Maka subjects
```

从 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md) 开始阅读。它提供总体架构图、代码边界、按问题组织的阅读路径，以及六篇中英双语深度文章。

## 仓库结构

```text
apps/desktop/       Electron main / preload / React renderer

packages/core/      Session、Event、Permission、Connection 等纯 contracts
packages/storage/   File-backed stores 与 run ledgers
packages/runtime/   AgentRun、模型适配、工具、上下文和恢复
packages/eval/      Experiment cell、attempt、result 与 executor/subject adapter
packages/cli/       TUI 和非交互 CLI
packages/ui/        共享对话、Markdown、Artifact 与 UI primitives

docs/               架构、产品、安全、隐私和测试契约
scripts/            Build hygiene、视觉检查、smoke 和 release helpers
```

## 本地数据与安全边界

Maka 默认把 workspace 数据放在 Electron `userData` 下：

```text
<Electron userData>/workspaces/default/
  llm-connections.json
  credentials.json
  settings.json
  sessions/
```

需要明确的当前边界：

- 会话和连接元数据保存在本地文件系统；
- API key、bot token、proxy password 等运行凭据当前保存在本地 plaintext `credentials.json`，依赖 OS 账号边界，并在 POSIX 上强制目录 `0700`、文件 `0600`；
- 订阅 OAuth token（Claude、Codex、GitHub Copilot、xAI 以及 Antigravity preview）统一存放在同一份 `credentials.json`，它是 Runtime Host client 的唯一凭据权威；历史 Electron `safeStorage` 凭据/token 文件不会被导入，仅保留这些历史副本的用户需要重新登录；
- Renderer 不接收明文凭据；文件写入、Shell 和危险工具调用需要经过 permission engine；
- Eval 不构造 Runtime，也不读取 Runtime storage；Maka subject 连接已有 Runtime Host。

安全问题请阅读 [SECURITY.md](./SECURITY.md)，当前隐私和 sandbox contract 见 [docs/README.md](./docs/README.md)。

## 实验性 Runtime 恢复开关

RuntimeEvent 现在始终以 `runtime.sqlite` 为 canonical store。首次写入时，Maka
会批量、幂等导入 legacy RuntimeEvent JSONL，且不会改写旧文件；在首次写入前，
仅包含 legacy 数据的 workspace 仍可由只读检查路径读取。

Runtime continuation 仍需显式开启：

- `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1` 会开启 Desktop 中断横幅的“安全恢复”按钮、
  CLI/TUI 的 `/resume` 命令和 Desktop 启动时自动续跑。这些路径都可能调用已配置的模型 provider 并消耗 token，
  只应在你明确需要这一行为时开启。

Phase 2 交付的是 durable 写侧边界和 fail-closed 的 safe-boundary continuation。
Phase 3 针对不确定工具副作用的 reconcile 尚未实现；结果不明的工具调用会 park，
不会被盲目重试。

## 开发与验证

常用仓库级命令：

```sh
npm run build
npm run typecheck
npm test
npm run check:release
```

针对单个 workspace：

```sh
npm --workspace @maka/runtime test
npm --workspace @maka/eval test
npm --workspace @maka/desktop test
```

用以下命令从 models.dev 更新 `packages/core/src/model-metadata.generated.ts`，并运行相关测试。访问路径特有的 override 写在 `model-metadata.ts`，不要手动修改生成文件。

```sh
npm run sync:model-metadata
npm --workspace @maka/core test
```

Desktop 的真实窗口与视觉验证：

```sh
npm --workspace @maka/desktop run e2e
npm --workspace @maka/desktop run smoke:real-window
```

提交代码前至少运行与改动范围相称的 typecheck、build 和 focused tests，并执行 `git diff --check`。

## 文档入口

- [文档索引与权威来源说明](./docs/README.md)
- [后端架构总览](./ARCHITECTURE.zh-CN.md)
- [产品设计](./DESIGN.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [安全政策](./SECURITY.md)

## 开源协议

Maka 使用 [Apache License 2.0](./LICENSE) 开源，归属信息见
[NOTICE](./NOTICE)。第三方组件仍分别适用其自身的许可证与声明。
