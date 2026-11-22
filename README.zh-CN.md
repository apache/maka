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

<h1 align="center"><img src="assets/logo.png" alt="Maka" width="72" align="absmiddle" /> Apache Maka (Incubating)</h1>

[English](README.md)

Apache Maka (Incubating) 是一个面向终端与桌面的本地 Agent 工作台。后台由 Rust 实现的 Runtime Host 统一承载模型调用、沙箱隔离、权限控制与 SQLite 持久化，完整留存每次运行、审批与工具调用回执。

## 快速上手

环境依赖：Rust stable、Node.js 24+（CI 使用 26）、npm 与 [just](https://github.com/casey/just)。启用原生 Computer Use 时，macOS 需安装 Xcode Command Line Tools，Linux 需安装 X11 开发库。

```sh
git clone https://github.com/apache/maka.git
cd maka
just setup
just run
```

`just run` 默认启动终端工作台，并自动连接或拉起 `~/.maka/application/host` 下的本地 Host。可通过 `--root <path>` 切换 State Root，`--session <id>` 打开指定会话，或用 `just run --help` 查看全部 CLI 子命令。

构建 Release 版 CLI 与原生桌面端：

```sh
just build --release
target/release/maka desktop
```

macOS 构建会在 `maka` 同级目录生成 `Maka.app`，Windows 产物带 `.exe` 后缀。终端与桌面壳层共用同一套 NSH 工作台并连接同一个 Host——关闭窗口只是断开前端，已接纳的后台任务会继续跑完。

在 WSL 环境下，`just run` 默认不编译 Linux 本地 `native-desktop` 驱动，Computer Use 会桥接到宿主机 Windows 桌面。源码运行时需通过 `MAKA_CUA_WINDOWS_EXECUTABLE` 指定同版本 Windows `maka.exe` 的 WSL 绝对路径，详见 [Computer Use](platform/computer-use/README.zh-CN.md)。

## 目录结构

| 目录 | 职责 |
| --- | --- |
| [platform/](platform/README.zh-CN.md) | 插件内核、SQLite 事件存储、Host 运行时、V8/Python 执行环境、系统沙箱与 Computer Use |
| [plugins/](plugins/README.zh-CN.md) | Agent 核心引擎、工作区工具、技能、设置、交互及领域契约 |
| [products/maka/](products/maka/README.zh-CN.md) | 产品组装、NSH 工作台、CLI、ACP 服务及终端/桌面壳层 |
| [products/eval/](products/eval/README.zh-CN.md) | 基于 Harbor 容器环境的评测运行器 |
| [packages/plugin-sdk/](packages/plugin-sdk/README.zh-CN.md) | 供 Host 与 NSH UI 插件使用的 TypeScript 类型契约与辅助库 |
| [packages/cli/](packages/cli/README.zh-CN.md) | 分发各平台原生二进制的 `@maka-agent/cli` npm 启动器 |
| [scripts/rust/](scripts/rust/README.zh-CN.md) | 原生打包、V8 预编译缓存、许可证审计与 CI 调度脚本 |
| `website/` | 独立构建的项目官网 |

常用开发命令可通过 `just --list` 查看。延伸阅读：[系统架构](ARCHITECTURE.zh-CN.md)、[界面设计规范](DESIGN.md)、[贡献指南](CONTRIBUTING.zh-CN.md)与[安全策略](SECURITY.md)。

## 分发方式

**Apache Releases**：最新获批的正式版本是 Apache Maka `0.2.2`（孵化中）。带签名的源码包才是正式 release，下载与验包步骤见[下载页面](https://maka.apache.org/zh-CN/downloads/)与 [`.github/ASF_SOURCE_RELEASE.md`](.github/ASF_SOURCE_RELEASE.md)。

**便利构建**：`@maka-agent/cli` 只做按平台分发并启动原生二进制的薄封装，本身不包含运行时逻辑；各平台二进制由同一份经校验的源码归档构建，发布流程见 [packages/cli](packages/cli/README.zh-CN.md)。

Apache Maka 正在 Apache 软件基金会（ASF）孵化，详见 [DISCLAIMER](DISCLAIMER)、[LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
