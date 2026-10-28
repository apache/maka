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

# Maka 桌面 shell

[English](README.md)

`maka-desktop-shell` 通过 NSH 的 GPUI 后端，在独立窗口中运行[工作台](../workbench/README.zh-CN.md)，支持 macOS、Windows 和 Linux。它运行的就是[终端 shell](../terminal-shell/README.zh-CN.md) 所运行的应用，编译在可执行文件内。在图形桌面上，工作台的顶部栏即窗口的标题栏，应用菜单提供工作台的命令及其快捷键。

在仓库根目录构建：

```sh
just build
# 或：just build --release
```

构建生成 CLI 和 shell。macOS 上在 `maka` 旁生成 `Maka.app`：shell 位于 `Contents/MacOS`，另有 `Info.plist` 和图标（取自 `assets/logo.png`），系统因此把窗口显示为 Maka 并使用其图标。`maka desktop` 启动的是 bundle 内的 shell，所以只用 Cargo 重新构建 shell 之后，要再运行一次 `just build` 来更新它。`--target TRIPLE` 可选择其他 Rust 目标。原生包包含 `bin/maka` 和 `bin/maka-desktop-shell`，Windows 可执行文件带后缀并附带 service helper；macOS 原生包包含 `bin/maka` 和 `bin/Maka.app/`。

通过启动器启动：

```sh
/absolute/path/to/maka desktop
# 或指定其他 Host Root：
/absolute/path/to/maka desktop --root /absolute/path/to/business-host
```

`--root` 可选，指定业务 Host Root，默认使用 `~/.maka/application/host`。启动器把缺失的 Root 初始化为标准只读业务 Host，或重开其已保存的部署；随后对照已连接 Host 的端点、来源和 epoch 校验发现信息，并把 `MAKA_HOST_ROOT`、`MAKA_HOST_ENDPOINT` 和 `MAKA_HOST_EPOCH` 传给 shell，同时用 `MAKA_LAUNCHER` 传入启动器自身的路径。shell 以与终端 shell 相同的方式接入该 Host，并把客户端数据保存在该 Root 下。

关闭窗口、应用菜单的退出项和退出快捷键都会关闭窗口；shell 随后与 Host 断开并退出。启动器同样只断开连接，因此 Host 会完成已接受的工作，在没有客户端后停止。取消启动器只会停止它启动的 shell。

窗口会在上次关闭时所在的显示器上打开，位置、大小以及全屏或最大化状态都与当时相同；这些记录在 Root 的 `clients/desktop-window.json` 里。那个显示器已断开时，窗口在主显示器上居中打开；窗口顶边留在显示器上的部分不够拖动时，窗口在那个显示器上居中打开。

窗口打开期间如果 Host 停止（崩溃，或在仍有客户端时被强制退役），shell 会在几秒内察觉，连接该 Root 的下一个 Host（没有运行中的 Host 时像 `maka desktop` 一样经由启动器启动），并在同一个窗口里重新加载工作台。工作台从头开始，与打开桌面时相同；停止的 Host 正在执行的那一轮显示为已停止。连上下一个 Host 之前，窗口保留原来的工作台，其中的操作都会失败；shell 按逐步拉长的间隔重试，最长 30 秒。只有当它打开的那个 Root 仍在原路径时才会重连：被移走或删除的 Root 不会被重新初始化。
