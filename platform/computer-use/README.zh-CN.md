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

`maka-computer-use` 通过会话独占的独立 JavaScript REPL（`cua_repl` 与 `cua_reset`）操控原生桌面应用和浏览器标签页，不依赖 Code Mode 开关。完整对象接口见 [`src/api.zh-CN.md`](src/api.zh-CN.md)，操作范式见内置技能 [`skills/maka-cua/SKILL.md`](skills/maka-cua/SKILL.md)。

每个会话各自维护 REPL 上下文、目标绑定与最近一次无障碍树/截图观测；权限校验与底层驱动则由 Host 实时把关。跨轮次保留 JS 对象引用不会延续旧授权，REPL 内也不暴露 Node、文件系统或任意网络 API。

```js
const state = await cua.getState();
const app = await cua.getApp("Calculator");
```

## 浏览器扩展连接

除直接配置 CDP 端点外，Computer Use 支持通过 Chrome / Chromium 原生消息通道接入浏览器扩展（`cua.listBrowsers()`、`cua.getBrowser({ id })`）：

- **ChatGPT 扩展按需接管** — 若本机 Chrome 或 Chromium 已安装 ChatGPT 扩展，Maka 会自动发现（默认优先 Chrome）并在实际调用时临时租用连接，轮次结束、会话关闭或调用 `await browser.release()` 后自动归还原生宿主注册。若需显式指定扩展 ID 或切换 Chromium，可执行 `maka browser install --provider chatgpt --extension-id <EXTENSION_ID> --on-demand [--browser chromium]`；异常断电遗留的租约可通过 `maka browser restore` 恢复。
- **内置 Maka Chrome 扩展注册** — 将扩展源码导出到空目录并在 Google Chrome 开发者模式加载后，绑定其扩展 ID：

```sh
maka browser extension --output /absolute/path/maka-browser-extension
maka browser install --provider maka --extension-id <EXTENSION_ID>
```

卸载原生宿主注册使用 `maka browser uninstall --provider maka|chatgpt`。

会话新建的临时标签页默认在轮次结束时自动关闭；调用 `markDeliverable()` 可留给用户查看，调用 `markHandoff()` 可跨轮次保留。

## 原生编译与 WSL 桥接

`maka-cli` 默认开启 `native-desktop` Cargo feature，macOS 需安装 Xcode Command Line Tools，Linux 需安装 X11 开发库。

在 WSL 中，`just run` 默认跳过 Linux 本地驱动编译并将目标切到宿主机 Windows 桌面（可通过 `MAKA_CUA_BUILD_MODE=auto|native|bridge` 覆盖）。源码开发时需指向同版本 Windows 编译出的 `maka.exe`：

```sh
MAKA_CUA_WINDOWS_EXECUTABLE=/mnt/c/path/to/maka.exe just run
```

系统输出音频录制默认关闭，需在 Host 配置中显式开启 `audio: true`（仅采集系统播放输出，绝不采集麦克风）。
