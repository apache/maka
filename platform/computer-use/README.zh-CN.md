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

# Computer Use

[English](README.md)

通过独立 JavaScript REPL 提供 Maka 原生应用和浏览器 API。关闭 Code Mode 后，`cua_repl` 与 `cua_reset` 仍可使用。固定的 Cua 驱动版本见[工作区配置](../../Cargo.toml)，对象 API 见 [src/api.md](src/api.md)。

Session 管理 REPL 变量、目标绑定和观察，Host 管理权限检查与原生驱动。每次操作使用当前权限，保留 JavaScript 对象不会保留授权。REPL 不提供环境级 Node、文件系统或任意网络 API。

原生嵌入方为 `Session::invoke` 传入可信 `InvocationContext`。HTTP(S) 页面读取和输入需要其中的 `BrowserAuthorization`，导航则检查目标站点。未提供回调的原始 Session 会拒绝受保护的站点访问。回调使用 Host 的真实调用身份和权限体系，不能由 REPL 命令提供。

新 REPL 先选择入口，阅读自动输出的状态后再操作：

```js
const app = await cua.getApp("Calculator");
```

后续调用使用该观察中的索引。`cua.getState()` 列出可用界面，应用与标签页观察会自动输出。内置 [maka-cua skill](skills/maka-cua/SKILL.md)说明目标选择、截图和输入用法。

## 桌面与浏览器配置

`desktop` 默认为 `auto`：WSL 中选择 Windows 主机，其他环境选择本地桌面。`local` 在 WSL 中选择 Linux，`windows` 要求 Windows helper。原生分发通过经过验证的缓存准备匹配版本的 helper。此模式需要 WSL 互操作及交互式 Windows 桌面。

浏览器提供方包括使用已有 profile 的显式 CDP 连接，以及已连接的 Extension 浏览器提供方。先用 `cua.listBrowsers()` 获取完整 ID，再用 `cua.getBrowser({id})` 选择。精确 provider ID 优先；没有精确匹配时，才用 `maka` 和 `chatgpt` 短名选择唯一的当前 Extension 端点；存在多个端点时须使用完整 ID。direct CDP profile 保留配置的 ID。缺少提供方不会重启浏览器或开启远程调试；仍可通过 `getApp` 操作原生浏览器窗口。

配置 Maka 或 ChatGPT Extension 提供方时，须在 Google Chrome 所在操作系统、以同一用户运行启用 `native-desktop` 的 Maka。安装命令注册 Chrome 的当前用户扩展宿主，不经 WSL Windows 桥转发。Linux 和 macOS 下，Chrome 的默认用户配置目录须已存在。注册还会在选定 Maka 可执行文件旁写入安装元数据，这些位置需要可写。

使用 Maka 时，先将内置 Chrome 连接扩展源码导出到绝对路径的空目录，其父目录须已存在：

```sh
maka browser extension --output /absolute/path/maka-browser-extension
```

在 Chrome 扩展管理界面加载并启用该目录，再用实际扩展 ID 注册：

```sh
maka browser install --provider maka --extension-id ACTUAL_MAKA_EXTENSION_ID
```

使用已安装的 ChatGPT 扩展时，改为显式选择对应适配器：

```sh
maka browser install --provider chatgpt --extension-id ACTUAL_CHATGPT_EXTENSION_ID
```

这些命令为同一个可执行文件选择不同的注册方式。扩展宿主安装拒绝覆盖冲突注册，重新导出扩展时也拒绝覆盖修改过的源码。安装命令不安装扩展、不修改浏览器策略，也不授予站点访问权限。Maka 使用 `maka browser uninstall --provider maka`，ChatGPT 使用 `maka browser uninstall --provider chatgpt`，移除匹配的 扩展宿主注册；此操作不卸载扩展或删除导出源码。

Extension 提供方通过 `browser.user` 提供用户标签页发现和取得入口。[API 说明](src/api.zh-CN.md)涵盖其权限规则、`tab.ax` 门面、Playwright、剪贴板和下载。Host 的 `browserPreparation` 默认为 `popup: false`、`requestHeaders: []`；非空 headers 也会启用有效的 popup 采用与 relay。这些设置不授予站点访问权限，也不证明 ChatGPT 页面 hooks 已关闭，详见[类型化配置](../../plugins/workspace/api/src/computer.rs)。

定制 Maka 连接扩展可从 [facade.js](src/facade.js)、[protocol.rs](src/protocol.rs) 中的类型化命令及 [browser.rs](src/browser.rs) 派发入手。ChatGPT 和原版 OpenCLI 按实际能力尽力兼容。OpenCLI 可在创建或认领标签页前回退到唯一可用的提供方；精确 ID 和已有句柄仍绑定原提供方。

录制计算机输出音频需要 Host 显式配置 `audio: true`，默认关闭。启用后提供 `cua.computer.start_audio_recording`、`stop_audio_recording` 和 `nodeRepl.emitAudio`；仅录制输出音频，不选择麦克风。macOS 还需要单独的音频 Session 授权。重置和 Session 清理会丢弃其录音。

## 原生与 WSL 开发构建

CLI 默认启用 Cargo feature `native-desktop`，包含 Linux、macOS 或 Windows 的本地驱动及游标渲染器。原生依赖在 macOS 上需要 Xcode Command Line Tools，在 Linux 上需要 X11 开发库。

`just run` 在 WSL 中自动关闭该 feature，保留 Windows 桥接且无需编译 Linux 桌面驱动。可将 `MAKA_CUA_BUILD_MODE` 设置为 `auto`（默认）、`native` 或 `bridge`，显式选择开发构建。例如 `MAKA_CUA_BUILD_MODE=native just run` 会在 WSL 中编入 Linux 驱动。运行时仍由 `desktop` 配置选择目标；桥接构建拒绝 `local`，`auto` 需要在 WSL 中才能选择 Windows。

源码构建需要由同一份源码、使用默认原生 feature 构建的 Windows `maka.exe`。在 Windows 上构建后，提供 WSL 可见的绝对路径：

```sh
MAKA_CUA_WINDOWS_EXECUTABLE=/mnt/c/path/to/maka.exe just run
```

直接使用 `cargo run -p maka-cli` 保留原生默认值。直接构建桥接版本可用 `cargo run --locked -p maka-cli --no-default-features -- ...`。Cargo 会合并所选包的 feature，若同时选择的其他包启用了 `native-desktop`，便会恢复原生依赖。`just build` 和发布打包保留完整原生产品；Linux 桌面 shell 自身仍需要 Linux GUI 开发库。

## 生命周期

临时标签页由所属 Session 持有。Turn 结束时，未标记保留的标签页关闭；`markDeliverable()` 为用户保留标签页，`markHandoff()` 则保留至后续 Turn。重新使用保留的标签页需要当前授权。重置和断开连接会请求清理，并保留标签页标记。导航和窗口变化可能使观察失效。结果不确定的输入不会自动重放。

原生 Computer Use 需要交互式桌面，Linux 原生方法需要 X11。Windows 中提供截图 ID 时使用图像坐标，省略 ID 时使用窗口逻辑视口。浏览器上传支持已授权的普通文件，不支持目录上传或子框架文件选择器。浏览器宿主退出时仍被选择的文件不会自动回收。
