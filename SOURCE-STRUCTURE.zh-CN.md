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

# Maka 源码结构

这份文档说明仓库里每个目录做什么。运行时如何分层、谁拥有 Session 和 State Root，见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。

仓库是一个 npm workspace。TypeScript 包在 `packages/` 和 `apps/`，Rust 程序在 `native/`。执行权威在 Runtime Host：Desktop、CLI、TUI 和 Eval 都经过 Host，不为同一份状态再写一套 Runtime。

## 顶层

| 目录 | 做什么 |
|---|---|
| `apps/` | 产品入口。目前只有 Electron 桌面端。 |
| `packages/` | 可复用的 TypeScript 包：协议、存储、执行、Host、界面、CLI、评测。 |
| `native/` | Rust 程序。补 Node 不适合做的 Git 读取、Windows 进程监管和点对点连接。 |
| `scripts/` | CI、发布、许可证头、架构门禁和本地构建脚本。 |
| `docs/` | 架构、协议和功能说明。根目录的 `ARCHITECTURE*.md` 是总览，细节多在这里。 |
| `website/` | 用 Astro 做的项目网站，也负责生成 README 里的首屏图。 |
| `experiments/` | 不进入产品构建的试验。目前是 Windows sandbox 冒烟脚本。 |
| `skills/` | 给编码代理用的仓库内 Skill。目前是架构文档的写作约定。 |
| `patches/` | `npm ci` 时打到依赖上的补丁。 |
| `release/` | 发布用的 ASF 材料，不是运行时代码。 |

根目录还有 `package.json`（workspace 脚本和依赖）、`tsconfig.base.json`、`biome.jsonc`（格式和 lint）、`knip.json`（未使用导出检查）、`deny.toml`（Rust 依赖策略）、`LICENSE`、`NOTICE`、`CONTRIBUTING*.md`、`SECURITY.md`、`CHANGELOG.md` 和 `README*.md`。

## `packages/`

依赖大致是：`core` 没有运行时；`storage`、`mcp`、`runtime` 使用 `core`；`runtime-host` 把它们收成唯一的执行入口；`cli` 和 `apps/desktop` 再去连 Host。

| 包 | npm 名 | 做什么 |
|---|---|---|
| `core` | `@maka/core` | 纯类型和契约：Session、事件、权限、模型连接、协议编解码。不启动进程，不写数据库。 |
| `storage` | `@maka/storage` | 交互状态的存储：SQLite、凭证、执行记录、Goal、工件。不拥有评测结果。 |
| `runtime` | `@maka/runtime` | 真正跑一轮对话：SessionManager、模型适配、工具、沙箱、上下文预算和恢复。 |
| `runtime-host` | `@maka/runtime-host` | 唯一的 hosted 执行权威。公开协议、客户端、服务进程、准入和 Peer Mesh。 |
| `mcp` | `@maka/mcp` | MCP 客户端管理，把外部工具服务接到 Runtime。 |
| `ui` | `@maka/ui` | 桌面端和 TUI 共用的界面组件，基于 Astryx。不含 Electron。 |
| `cli` | `maka-agent` | `maka` 命令：TUI、`maka run`，以及对外的 `maka eval`。 |
| `eval` | `@maka/eval` | 评测实验：subject、task、重复次数、cell、attempt 和结果选择。执行仍交给 Host。 |
| `computer-use` | `@maka/computer-use` | 让模型操作本机界面的循环和证据契约。 |
| `acp-executor-plugin` | — | 外部 Agent 的 ACP 传输和生命周期。子插件只提供适配器。 |
| `antigravity-acp-plugin` | — | Antigravity 的薄适配：可执行文件路径、启动环境和初始模型。进程和 Session 仍由 ACP 插件拥有。 |

## `apps/desktop/`

Electron 应用，产品名是 Maka。`npm run dev` 从这里启动。

| 目录 | 做什么 |
|---|---|
| `src/main` | 主进程：窗口、IPC、把桌面能力接到 Runtime Host。 |
| `src/preload` | 预加载脚本。渲染进程只能通过这里暴露的桥访问主进程。 |
| `src/renderer` | 界面：AppShell、会话、输入框、设置。功能按 `features/<name>/{model,controller,ui,ports}` 切开。 |
| `src/shared` | 主进程和渲染进程共用的投影与契约。 |
| `src/overlay` | 光标覆盖层，给 Computer Use 用。 |
| `scripts/` | 开发启动、打包和桌面端自己的检查。 |

渲染进程不能直接调用 `window.maka` 里的桥，除非代码在平台适配层。功能模块通过 `ports` 描述需要的服务，由 `src/renderer/platform/desktop/` 接上真实桥。

## `native/`

| 目录 | 产物 | 做什么 |
|---|---|---|
| `gitoxide-helper` | `maka-gitoxide-helper` | 用 gitoxide 读取仓库并导入工作区。不调用系统 `git`。Node 用 JSON 经标准输入输出跟它说话，并限制文件大小和目录深度。 |
| `runtime-host-windows-task-launcher` | `maka-runtime-host-task-launcher` | 只在 Windows 上拉起 `runtime-host serve`。`--supervise` 会在异常退出后重启，并用 Job Object 让启动器退出时带走整棵进程树。 |
| `runtime-host-peer` | `maka_runtime_host_peer.node` | Node 原生模块。用 libp2p 做 Host 之间的发现、打洞和身份校验。桌面端的 Peer Mesh 和 CLI 的远程 Host 加载它。 |

## `scripts/`、`docs/`、其余

`scripts/` 是仓库级工具，不是产品功能。常见的几类：

- CI 选择要跑哪些测试（`ci-test-plan.mjs`）以及 workflow 策略测试。
- 许可证头、第三方声明、源码发布包（`asf-*.mjs`）。
- 渲染进程架构棘轮和 AppShell hook 清单（`check-renderer-architecture.mjs`、`check-app-shell-hooks.mjs`）。
- 桌面端 e2e、Storybook 冒烟、图标和 Astryx 主题漂移检查。

`docs/architecture/` 放 Runtime Host 和 Peer Mesh 的架构说明。`docs/blogs/` 是面向读者的长文。其余文件是单个功能的契约或验收记录。

`website/` 是独立的 Astro 站点。`experiments/windows-sandbox/` 只含本机试验脚本。`skills/maka-architecture-docs/` 约束架构文档怎么写，不参与应用构建。`patches/` 里的补丁在安装依赖时应用。`release/asf/` 放 ASF 发布所需的附加材料。
