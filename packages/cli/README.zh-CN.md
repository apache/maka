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

```sh
# 正式版（发布到 @latest 后）：
npm install --global @maka-agent/cli
# 开发者 nightly 构建（非官方预览，非 ASF 发行版）：
npm install --global @maka-agent/cli@nightly
# 别名包：
npm install --global maka-agent@nightly
```

`@maka-agent/cli` 是平台分发薄封装：通过精确版本号的 `optionalDependencies` 拉取对应平台原生包（`darwin-arm64`、`linux-x64-gnu`、`linux-arm64-gnu`、`win32-x64`），并将命令行参数、标准输入输出与退出码直接透传给 Rust `maka` 可执行文件（macOS 附带 `Maka.app`，Linux/Windows 附带 `maka-desktop-shell`）。WSL 下使用 Linux 二进制配合同版本 Windows Computer Use 辅助进程。

Apache 软件基金会官方发行版为 [maka.apache.org/zh-CN/downloads](https://maka.apache.org/zh-CN/downloads/) 发布的带签名源码归档；npm 预编译包为便利分发，`@nightly` 为未经 ASF 投票的非官方开发者预览版。

## 常用命令

- `maka` / `maka terminal-shell` — 启动 NSH 终端工作台，默认连接 `~/.maka/application/host`（可用 `--root <path>` 切换目录，`--session <id>` 打开指定会话）。
- `maka desktop --root <path>` — 针对指定 State Root 打开原生桌面窗口；关闭窗口仅断开前端，后台已接纳的任务会继续跑完。
- 在 Windows 快捷方式中指定数据目录时，可以用 `maka-desktop-shell.exe --root "C:\path to\root"` 直接打开桌面窗口，全程无控制台黑窗。
- `maka update` — 检查并安装当前发布渠道的更新。
- `maka --help` — 查看 `host`、`application`、`code`、`checkpoint`、`inspect`、`sandbox` 与 `acp` 等全部子命令。

壳层结构见 [products/maka](../../products/maka/README.zh-CN.md)，部署与插件组合见 [products/maka/bundle](../../products/maka/bundle/README.zh-CN.md)。

## 打包与发布

正式版与 nightly 二进制、安装包与 npm 包统一由 [`.github/workflows/release.yml`](../../.github/workflows/release.yml)、[`.github/workflows/nightly.yml`](../../.github/workflows/nightly.yml) 与 [`scripts/rust/package-nightly.mjs`](../../scripts/rust/package-nightly.mjs) 构建发布。V8 预编译缓存与第三方许可证审计见 [scripts/rust](../../scripts/rust/README.zh-CN.md)，ASF 源码发布规范见 [.github/ASF_SOURCE_RELEASE.md](../../.github/ASF_SOURCE_RELEASE.md)。
