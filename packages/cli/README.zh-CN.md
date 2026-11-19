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

# `@maka-agent/cli`

[English](README.md)

**`rust-preview` 为独立发布的实验性预览渠道，并非 Apache 软件基金会（ASF）官方发行版，未经 ASF 批准、背书或支持。**

```sh
npm install --global @maka-agent/cli@rust-preview
```

`@maka-agent/cli` 是平台分发薄封装：通过精确版本号的 `optionalDependencies` 拉取对应平台原生包（`darwin-arm64`、`linux-x64-gnu`、`win32-x64`），并将命令行参数、标准输入输出与退出码直接透传给 Rust `maka` 可执行文件（macOS 附带 `Maka.app`，Linux/Windows 附带 `maka-desktop-shell`）。WSL 下使用 Linux 二进制配合同版本 Windows Computer Use 辅助进程。

`latest` 标签（含独立的 `maka-agent` 包）保持为空占位包，不含 CLI、运行时、依赖或安装脚本；占位包源码见 [`placeholder/`](placeholder/README.md)，预览构建仅发布到 `rust-preview`。

## 常用命令

- `maka` / `maka terminal-shell` — 启动 NSH 终端工作台，默认连接 `~/.maka/application/host`（可用 `--root <path>` 切换目录，`--session <id>` 打开指定会话）。
- `maka desktop --root <path>` — 针对指定 State Root 打开原生桌面窗口；关闭窗口仅断开前端，后台已接纳的任务会继续跑完。
- `maka --help` — 查看 `host`、`application`、`code`、`checkpoint`、`inspect`、`sandbox` 与 `acp` 等全部子命令。

壳层结构见 [products/maka](../../products/maka/README.zh-CN.md)，部署与插件组合见 [products/maka/bundle](../../products/maka/bundle/README.zh-CN.md)。

## 构建与发布预览包

先从已提交版本生成源码归档（`just source <version>`），基于同一份归档分别构建三个平台的原生包后执行汇总、离线验收与发布：

```sh
just package <source.tar.gz> <target> <build-id> native-preview

just release-prepare native-preview
just release-check native-preview
just publish native-preview
```

`release-check` 会在各目标平台上离线安装打包产物并跑通冒烟校验。发布流程按“先上传各平台原生包、再发布启动器”的顺序推进并核验 dist-tag；中途中断可由同一发布者幂等重试同一批产物。

非官方 `rust-preview` 渠道仅在个人仓库 `M4n5ter/maka-agent` 的 `npm-rust-preview` 环境显式开启 `publish=true` 时发布，绝不从 `apache/maka` 仓库直接发包。V8 预编译缓存与第三方许可证审计见 [scripts/rust](../../scripts/rust/README.zh-CN.md)，ASF 源码发布规范见 [.github/ASF_SOURCE_RELEASE.md](../../.github/ASF_SOURCE_RELEASE.md)。
