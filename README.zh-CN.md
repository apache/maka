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
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-4C8DFF?style=flat" alt="License: Apache 2.0" /></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20x64-4C8DFF?style=flat&logo=apple&logoColor=white" alt="macOS Apple Silicon 与 Intel" />
  <img src="https://img.shields.io/badge/Windows-preview-9BB8F0?style=flat&logo=windows&logoColor=white" alt="Windows 未签名预览" />
  <img src="https://img.shields.io/badge/Linux-preview-9BB8F0?style=flat&logo=linux&logoColor=white" alt="Linux 未签名预览" />
  <a href="https://deepwiki.com/apache/maka"><img src="https://img.shields.io/badge/DeepWiki-%E7%AC%AC%E4%B8%89%E6%96%B9%20AI%20%E6%96%87%E6%A1%A3-9BB8F0?style=flat" alt="DeepWiki：第三方 AI 生成文档" /></a>
  <a href="./README.md"><img src="https://img.shields.io/badge/English-4C8DFF?style=flat" alt="English" /></a>
</p>

<p align="center">
  <strong>Apache Maka（孵化中）是一个高性能的 Agent 工作台，并完整记录它做过的每一件事。</strong><br/>
  Agent harness 的本职就是把任务做完。衡量它的标准只有一条：完成了多少，花了多少。我们公开每一次运行：同一个模型，同一个官方验证器，逐任务的完整记录。
</p>

<p align="center">
  <a href="https://maka.apache.org/zh-CN/">官网</a> &nbsp;·&nbsp; <a href="https://maka.apache.org/zh-CN/downloads/">下载</a>
</p>

![Maka 完整记录它做过的每一件事。](./.github/assets/maka-hero.png)

> [!NOTE]
> Apache Maka (Incubating) 是一个正在 Apache 软件基金会（ASF）孵化的项目，由 Apache Incubator PMC 提供 sponsor。所有新接受的项目都必须经过孵化，直到进一步审查表明其基础设施、沟通方式和决策流程已经稳定到与其他成功的 ASF 项目一致的程度。孵化状态并不必然反映代码的完成度或稳定性，但它确实表明该项目尚未得到 ASF 的完全认可。项目当前已知的问题记录在 [DISCLAIMER-WIP](./DISCLAIMER-WIP)（以英文原文为准）。

> [!IMPORTANT]
> Maka 仍在活跃开发中。数据格式、CLI 和实验能力仍可能变化。

## 什么是 Maka

Maka 在本机运行，连接你自己的模型。模型消息、工具调用、工具结果与终止状态都会被完整记录；界面与下一次模型请求只是这份记录的视图，而非唯一副本。缩短上下文不等于删除历史，旧的工具输出可以从后续 prompt 中省略，但保存的证据始终完整保留。完整背景与设计考量参见 [Maka 官网](https://maka.apache.org/zh-CN/)。

Desktop、TUI/CLI 与 Eval 是不同的运行入口，统一通过同一个 Runtime Host 执行。Desktop 负责日常交互、文件与 Artifact 工作流、模型和权限配置；TUI 和 CLI 在当前工程目录中使用 Maka，或执行单次非交互 Turn；Eval 在 Maka 与外部 subject 之间运行可复现的基准实验。系统地图与宿主协议见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。

系统当前具备内置工具（`Read`、`Write`、`Edit`、`Bash`、`Glob`、`Grep`）、越出沙箱边界的工具审批、具备崩溃恢复与回合续跑能力的持久化执行记录、会话分支与搜索，以及按 task × repetition × subject 展开的声明式多臂评测能力。完整文档与权威来源映射参见 [docs/README.md](./docs/README.md)。

## 获取 Maka

**Apache Releases**：Maka 尚未发布过 Apache release。发布之后，带签名的源码包才是正式 release，其他渠道分发的包属于便利构建。候选契约、签名路径与验包步骤见[下载页面](https://maka.apache.org/zh-CN/downloads/)与 [`.github/ASF_SOURCE_RELEASE.md`](./.github/ASF_SOURCE_RELEASE.md)。

**Desktop Nightly**：每天从 `main` 构建，面向开发者和测试者。目前支持 Apple Silicon Mac，Windows 是未签名预览。它不是 ASF release，不适合生产使用。安装包与平台状态见[下载页面](https://maka.apache.org/zh-CN/downloads/)。

**从源码构建**：要从源码 checkout 直接构建并运行 Desktop、TUI 或 CLI，见下方的[从源码构建](#从源码构建)一节。

## 从源码构建

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

开发 Direct Peer 和 Peer Mesh 还需要 Rust stable 1.98 或更高版本及平台 linker
（macOS 使用 Xcode Command Line Tools，Windows 使用 MSVC Build Tools）。使用 Peer 开发入口，
Desktop 会在启动前构建原生 addon：

```sh
npm run dev:peer       # HMR
npm run dev:full:peer  # 完整构建
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
website/               maka.apache.org 的 Astro 源码

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
npm --workspace @maka/runtime run test:dist
npm --workspace @maka/eval run test:dist
npm --workspace @maka/desktop run test:dist
```

用 `refresh:model-metadata` 从 models.dev 获取当前目录、更新仓库内快照，并重新生成派生的 TypeScript 文件。已提交的模型、能力、provider override 或 pricing 字段消失时，refresh 会 fail closed；审查确认上游确实有意删除后，用 `npm run refresh:model-metadata -- --accept-upstream-removals` 显式确认。`sync:model-metadata` 刻意保持离线，只会从已提交快照重新生成这些文件。访问路径特有的 override 写在 `model-metadata.ts`，不要手动修改生成文件。

```sh
npm run refresh:model-metadata
npm --workspace @maka/core run test:dist
```

Desktop 的真实窗口与视觉验证：

```sh
npm --workspace @maka/desktop run e2e
npm --workspace @maka/desktop run smoke:real-window
```

提交代码前至少运行与改动范围相称的 typecheck、build 和 focused tests，并执行 `git diff --check`。

## 文档入口

- [官网](https://maka.apache.org/zh-CN/)
- [文档索引与权威来源说明](./docs/README.md)
- [后端架构总览](./ARCHITECTURE.zh-CN.md)
- [产品设计](./DESIGN.md)
- [贡献指南](./CONTRIBUTING.zh-CN.md)
- [安全政策](./SECURITY.md)

## 开源协议

Maka 使用 [Apache License 2.0](./LICENSE) 开源，归属信息见
[NOTICE](./NOTICE)。第三方组件仍分别适用其自身的许可证与声明。

Apache Maka、Maka、Apache、Apache 羽毛标志和 Apache Maka 项目标志是 Apache 软件基金会的注册商标或商标。
