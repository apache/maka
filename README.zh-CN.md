<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

<h1 align="center">
  <img src="apps/desktop/assets/app-icons/sky.png" alt="Maka" width="72" valign="middle" /> Apache Maka (Incubating)
</h1>

<p align="center"><sub>正在 Apache 软件基金会孵化</sub></p>

<p align="center">
  <a href="https://github.com/apache/maka/stargazers"><img src="https://img.shields.io/github/stars/apache/maka?style=flat&label=%E2%98%85&color=4C8DFF" alt="GitHub stars" /></a>
  <a href="https://github.com/apache/maka/releases"><img src="https://img.shields.io/github/downloads/apache/maka/total?style=flat&label=downloads&color=4C8DFF" alt="GitHub downloads" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-4C8DFF?style=flat" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/macOS-arm64-4C8DFF?style=flat&logo=apple&logoColor=white" alt="macOS Apple Silicon" />
  <img src="https://img.shields.io/badge/Windows-preview-9BB8F0?style=flat&logo=windows&logoColor=white" alt="Windows 未签名预览" />
  <img src="https://img.shields.io/badge/Linux-soon-D0D4DA?style=flat&logo=linux&logoColor=6B7280" alt="Linux 尚未支持" />
  <a href="https://deepwiki.com/apache/maka"><img src="https://img.shields.io/badge/DeepWiki-%E7%AC%AC%E4%B8%89%E6%96%B9%20AI%20%E6%96%87%E6%A1%A3-9BB8F0?style=flat" alt="DeepWiki：第三方 AI 生成文档" /></a>
</p>

<p align="center">
  <a href="./README.md"><img src="https://img.shields.io/badge/English-4C8DFF?style=flat" alt="English" /></a>
</p>

<p align="center">
  <strong>一个为真实工作而生的本地优先 Agent 工作台。</strong><br/>
  Maka 在沙箱边界下阅读项目、执行工具，并把模型消息和工具调用保存为可恢复的运行事实——数据在本机，执行走同一个 Runtime Host。
</p>

![Maka——你的工作，你的 Agent。](./.github/assets/maka-hero.zh-CN.png)

> [!NOTE]
> Apache Maka (Incubating) 是一个正在 Apache 软件基金会（ASF）孵化的项目，由 Apache Incubator PMC 提供 sponsor。所有新接受的项目都必须经过孵化，直到进一步审查表明其基础设施、沟通方式和决策流程已经稳定到与其他成功的 ASF 项目一致的程度。孵化状态并不必然反映代码的完成度或稳定性，但它确实表明该项目尚未得到 ASF 的完全认可。项目当前已知的问题记录在 [DISCLAIMER-WIP](./DISCLAIMER-WIP)（以英文原文为准）。

> [!IMPORTANT]
> Maka 仍在活跃开发中。macOS Apple Silicon 桌面版是首个早期公开版本，数据格式、CLI 和实验能力仍可能变化。

## 为什么是 Maka

- **数据在你的机器上。** 会话、设置和运行记录默认保存在本机。模型由你接：云 API、本地模型或兼容网关。
- **做过的事会留下来。** 模型消息、工具调用、工具结果、这一轮怎么结束，都会记下来。界面和下一次模型请求只是这份记录的视图，不是唯一副本。
- **缩短上下文不等于删掉历史。** Maka 可以不把旧的工具输出送进下一轮提示，但不会扔掉已保存的证据。
- **Agent 只在一处跑。** 桌面、终端和 Maka 评测都走 Runtime Host。Eval 只负责实验和分数。

完整设计见 [Maka Backend Architecture](./ARCHITECTURE.zh-CN.md)。

## 运行形态

| 入口 | 适合什么 | 当前能力 |
|---|---|---|
| **Desktop** | 日常交互、文件与 Artifact 工作流、模型和权限配置 | Electron + React，支持流式会话、工具时间线、分支、搜索和恢复 |
| **TUI / CLI** | 在当前工程目录中使用 Maka，或执行单次非交互 Turn | `maka`、`maka run`，复用 Desktop 的 workspace 和模型连接 |
| **Eval** | Maka 与外部 subject 的可复现实验 | `maka eval run <spec> --out <directory>` |

## 当前能力

### Agent Runtime

- 多模型连接、流式输出、thinking、用量统计，以及更清楚的 provider 错误；
- 内置工具：`Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`。Computer Use 和目录里的 skill 是可选的，默认不开；
- 越出沙箱的工具需要批准；运行可以中止；失败会被分类；
- 有一份可恢复的执行记录，进程崩溃后可以收敛状态，中断的回合可以按需续跑。

### Desktop Workspace

- 会话创建、归档、搜索、重命名、重试、重新生成和从 Turn 分支；
- Artifact 列表与预览、工作区说明、模型和沙箱设置；
- 配置后可使用本地记忆和联网搜索；
- 聊天应用（IM bot）仍是实验能力，见 [IM 接入](./docs/architecture/bot-onboarding-runtime.zh-CN.md)。

### Evaluation

- 声明式多臂 Experiment 展开为 task × repetition × subject cell；
- 每个 cell 使用 immutable attempt，基础设施失败只替换该 cell，并选择最早有效 attempt；
- 通用结果只包含 score、normalized usage、可归因 cost、duration、status/failure reason 与 artifacts；
- Maka subject 只通过 Runtime Host 执行，外部 subject 使用 generic external subject adapter。

## 快速开始

### Release 与下载

Apache Maka 目前还没有发布过 Apache release。当前从本仓库或包管理器分发的一切内容，都是在进入孵化器之前或孵化期间产生的，不是 Apache 软件基金会的 release，也没有经过 Incubator PMC 审查和投票。

在 Apache release 出现之后，官方 release 指的是由 ASF 发布、并经 podling PPMC 和 Incubator PMC 批准的源码 release。由该源码构建并通过其他渠道分发的包，例如包管理器中的包或 Desktop 安装程序，属于 convenience artifact，本身不是 release，并且只有在由获批源码 release 构建时才有效。候选契约、签名路径和验包步骤见 [`.github/ASF_SOURCE_RELEASE.md`](./.github/ASF_SOURCE_RELEASE.md)。

在获批源码 release 出现之前，本 README 不推荐任何预构建下载，请按下文从源码构建并运行 Maka。Desktop 目前面向 Apple Silicon Mac（`arm64`）。暂不支持 Intel Mac 和 Linux。[Windows](docs/windows-support.md) 是未签名预览，不是正式支持的发布层级。

### 环境要求

- Node.js 22.19 或更高（CI 使用 Node.js 24）；
- npm（仓库 lockfile 和 scripts 以 npm 为准，`packageManager` 当前为 npm 11）；
- Git；
- `ripgrep`，供 Runtime 的 `Grep` 工具使用。

### 启动 Desktop

```sh
git clone https://github.com/apache/maka.git
cd maka
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

公共 npm 包的安装和使用方式请查看 [CLI 中文指南](./packages/cli/README.zh-CN.md)。下面的命令
用于从源码 checkout 运行开发版 CLI。

先构建 workspace：

```sh
npm run build
```

然后可以启动 TUI 或执行单次 Turn：

```sh
npm run cli:dev
npm run cli:dev -- run "总结当前仓库并指出最重要的风险"
npm run cli:dev -- run --graph "并行实现两个切片，完成集成，然后独立审查"
npm run cli:dev -- --help
```

TUI 同时支持 `/graph on`、`/graph off` 和 `/graph <任务>`。非交互
`--graph` 会等待持久化 Graph 真正结束，再输出 supervisor 的最终结果。
Graph 的 implementation operator 使用隔离的 Git worktree，因此源项目必须是干净的
Git worktree。

仓库 CLI 使用与开发版 Desktop 构建相同的 `Maka Dev` profile；发布版 `maka` 二进制仍使用
`Maka` profile，二者不会自动复制或同步。评测 spec 和 adapter 位于 [`packages/eval`](./packages/eval)。

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
apps/desktop/          Electron main / preload / React renderer

packages/core/         Session、Event、Permission、Connection 等纯 contracts
packages/storage/      SQLite 运行状态、配置与 payload stores
packages/mcp/          与提供商无关的 Model Context Protocol 客户端集成
packages/runtime/      AgentRun、模型适配、工具、上下文和恢复
packages/runtime-host/ 单一所有者的 Runtime Host 生命周期、协议和客户端启动
packages/eval/         Experiment cell、attempt、result 与 executor/subject adapter
packages/computer-use/ Computer Use 后端选择、Host 生命周期和协议适配
packages/cli/          TUI 和非交互 CLI
packages/ui/           共享对话、Markdown、Artifact 与 UI primitives

docs/                  架构、产品、安全、隐私和测试契约
scripts/               Build hygiene、视觉检查、smoke 和 release helpers
```

## 本地数据与恢复

Workspace 数据默认放在 Electron `userData` 下：

```text
<Electron userData>/workspaces/default/
  runtime.sqlite
  connection-catalog.json
  credential-vault.json
  settings.json
  artifacts/
```

- API key 一类的秘密是本地明文文件（`credential-vault.json`），只有你的系统账号能读。界面进程拿不到明文。
- 写文件、跑 Shell 的工具必须先过沙箱边界。
- `runtime.sqlite` 是当前活记录。更早的 JSONL transcript 和 Electron `safeStorage` 凭据不会导入；升级后会话可能是空的，那些凭据需要重新填写。
- 中断回合的续跑默认关闭。只有设置 `MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1` 才会打开 Desktop **安全恢复**、CLI `/resume` 和启动时自动续跑——这些路径会打模型、消耗 token。

细节见 [SECURITY.md](./SECURITY.md)、[隐私](./docs/workspace-privacy-context.md)、[续跑](./docs/architecture/runtime-resume-architecture.zh-CN.md)。

## 开发与验证

提交改动前请先阅读 [CONTRIBUTING.zh-CN.md](./CONTRIBUTING.zh-CN.md)。

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

用 `refresh:model-metadata` 从 models.dev 获取当前目录、更新仓库内快照，并重新生成派生的 TypeScript 文件。已提交的模型、能力、provider override 或 pricing 字段消失时，refresh 会 fail closed；审查确认上游确实有意删除后，用 `npm run refresh:model-metadata -- --accept-upstream-removals` 显式确认。`sync:model-metadata` 刻意保持离线，只会从已提交快照重新生成这些文件。访问路径特有的 override 写在 `model-metadata.ts`，不要手动修改生成文件。

```sh
npm run refresh:model-metadata
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

Apache Maka、Maka、Apache、Apache 羽毛标志和 Apache Maka 项目标志是 Apache 软件基金会的注册商标或商标。
