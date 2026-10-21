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

<h1 align="center"><img src="assets/logo.png" alt="Maka" width="72" /> Apache Maka (Incubating)</h1>

[English](README.md)

Apache Maka (Incubating) 是一个高性能 Agent 工作台，完整记录它做过的每一件事。

Maka 提供插件组合定义的终端产品和原生桌面 shell。Runtime Host 统一管理执行、权限和持久状态，模型提供商、工具与业务能力通过公共插件接口接入。

## 从源码运行

需要 Rust stable、Node.js 24 LTS、npm 11.19.0 和 [just](https://github.com/casey/just)。原生 Computer Use 在 macOS 需要 Xcode Command Line Tools，在 Linux 需要 X11 开发库。

```sh
git clone https://github.com/apache/maka.git
cd maka
just setup
just run
```

`just run` 打开终端产品，首次确认当前工作目录并安装内置工具与技能，后续重开已保存的应用。`just run --help` 查看 CLI 命令。`just build --release` 生成 `target/release/maka`、`maka-desktop-shell` 及相邻的 `app/` 目录，Windows 可执行文件使用 `.exe` 后缀，macOS 上桌面 shell 和 app 放在 `Maka.app` 中。构建入口支持 `--release` 和 `--target`。Node.js 在构建时为 CLI 打包提供商 SDK，CLI 在内嵌 V8 中运行 JavaScript，桌面 shell 通过 QuickJS 执行 app。用 `just run application run --root PATH --deployment UUID --connections FILE` 启动已校验的终端组合，编写和安装方式见[普通 Agent 产品](products/maka/bundle/README.zh-CN.md)。

在 WSL 中，`just run` 构建不含本地 `native-desktop` 能力及其 Linux X11 依赖的 CLI，Computer Use 默认选择 Windows 桌面。源码构建需通过 `MAKA_CUA_WINDOWS_EXECUTABLE` 指定匹配的 Windows `maka.exe`，使用 WSL 可见的绝对路径。`MAKA_CUA_BUILD_MODE=auto|native|bridge` 控制开发构建选择，设置方法见 [Computer Use](platform/computer-use/README.zh-CN.md)。`just build` 和发布打包仍构建完整原生产品，包含桌面 shell 及其 Linux GUI 依赖。

通过 `target/release/maka desktop --root HOST_ROOT` 启动桌面，显式选择实际业务 Host Root。启动器初始化或重开 Host，并在 shell 运行期间保留其客户端。产物布局和开发命令见 [desktop-shell](products/maka/desktop-shell/README.zh-CN.md)。

## 目录

| 目录 | 用途 |
| --- | --- |
| [platform/](platform/README.zh-CN.md) | 应用内核、Host/UI owner、JavaScript 执行适配器和原生渲染器 |
| [plugins/](plugins/README.zh-CN.md) | 插件声明、业务实现及共享领域契约 |
| [products/maka/](products/maka/README.zh-CN.md) | 原生工厂选择、产品组合、CLI 和桌面入口 |
| `tools/schema/` | 无需构建完整产品的契约与 schema 导出 |
| `packages/plugin-sdk/` | JavaScript 插件的 Host、组件与原生呈现契约，由规范定义生成 |
| `packages/cli/` | 启动各平台 Rust 可执行文件的 npm 薄封装 |
| `scripts/rust/` | 内嵌 SDK 打包与绑定源码的 npm 分发 |
| `website/` | 独立构建的项目官网 |

通过 `just --list` 查看开发命令。参阅[贡献指南](CONTRIBUTING.zh-CN.md)、[架构](ARCHITECTURE.zh-CN.md)和[安全策略](SECURITY.md)。

## 分发

npm 启动器选择匹配的原生平台包，自身不包含 Agent 运行时。原生预览包从同一份源码归档构建并验证，流程见 [packages/cli](packages/cli/README.zh-CN.md)。

Apache Maka 正在 Apache 软件基金会孵化。参见 [DISCLAIMER-WIP](DISCLAIMER-WIP)、[LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
