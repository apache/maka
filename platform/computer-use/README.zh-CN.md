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

导出的 Maka 源码也是定制 Chrome 连接扩展的入口。自定义浏览器对象 API 从 [facade.js](src/facade.js)、[protocol.rs](src/protocol.rs) 中的类型化命令及 [browser.rs](src/browser.rs) 派发入手，保留 Host 授权和资源所有权。这是源码开发入口，不是动态浏览器协议插件注册接口。ChatGPT 和原版 OpenCLI 按实际能力尽力兼容，注册任意扩展 ID 不会增加其协议支持。原版 OpenCLI 当前缺少浏览器会话所需的接口；没有精确 provider ID 或扩展实例选择时，`cua.getBrowser({id: "opencli"})` 会在创建或认领标签页前选择唯一可用的已有提供方，没有匹配或匹配多个时拒绝选择。精确 ID 和已有句柄始终固定到原连接，无需安装修改版 OpenCLI 扩展。安装及浏览器操作仍须使用匹配的 Maka CLI/Host 构建在各目标平台进行集成验证；仅发现连接不能证明操作行为。

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

临时标签页由创建它的 Session 持有，并归当前使用它的 Turn 管理，Turn 完成时关闭；其他 Session 无法列出或取得这些标签页。重置清除本 Session 的绑定并关闭其临时标签页，保留用户应用和原有标签页。导航、窗口变化和新观察可能使原输入目标失效。取消或超时后需要重置，结果不确定的动作不会自动重放。关闭流程等待已接受的原生工作完成清理。

输入与捕获行为应在目标桌面验证；REPL 单元测试不能证明原生焦点或无障碍行为。

当前 checkpoint 已将平台专用的 `cua.computer` 接口及 `tab.dom_cua.get_visible_dom()` 接入 Host 授权与资源清理，但尚未实现完整的 LCU 行为对齐。原生 Windows 滚动仍不可用；Windows 截图坐标生命周期、macOS 焦点／键盘／粘贴行为，以及部分浏览器上传和边界语义尚未补齐。本 checkpoint 的 Windows、macOS 桌面集成尚未验证。
