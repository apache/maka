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

`maka-desktop-shell` 通过保留的 GPUI shell 和 QuickJS 运行时执行 [app](app/)。原生模块提供公共 Host 客户端、选定文件和系统语言；app 负责自己的视图与命令。

会话位于末尾时跟随新输出。向上滚动会暂停跟随；回到末尾或发送一条被 Host 受理的消息后恢复。发送被拒绝时保留阅读位置。

语言与当前连接的 Host 助手设置共用。app 在启动和每次打开设置时读取语言，更改经 Host 确认并读回设置后才应用。自动语言跟随 Host 的系统，未保存的语言偏好则使用 Host 配置的默认值。已受理的任务保留受理时的语言。冲突和保存失败会显示错误，不自动重试变更。外观仍保存在 app 本地。

在仓库根目录构建：

```sh
just build
# 或：just build --release
```

构建生成 CLI、shell 及可执行文件旁的完整 app。macOS 上改为在 `maka` 旁生成 `Maka.app`：shell 位于 `Contents/MacOS`，app 位于 `Contents/Resources/app`，另有 `Info.plist` 和图标（取自 `assets/logo.png`），系统因此把窗口显示为 Maka 并使用其图标。`maka desktop` 启动的是 bundle 内的 shell，所以只用 Cargo 重新构建 shell 之后，要再运行一次 `just build` 来更新它。`--target TRIPLE` 可选择其他 Rust 目标。原生包包含 `bin/maka`、`bin/maka-desktop-shell` 和 `bin/app/`，Windows 可执行文件带后缀并附带 service helper；macOS 原生包包含 `bin/maka` 和 `bin/Maka.app/`。打包的 shell 无参数启动时会从可执行文件旁（macOS 上为所在 bundle 内）找到 app，不依赖工作目录。

通过持有原始 Host 客户端的启动器运行：

```sh
/absolute/path/to/maka desktop --root /absolute/path/to/business-host
```

`--root` 必填，指向实际业务 Host Root。现有本地连接路径会将缺失的 Root 初始化为标准只读业务 Host，或重开已保存的部署。启动器根据已连接 Host 校验 discovery 的 endpoint、source 和 epoch，然后向子进程传入 `MAKA_HOST_ENDPOINT` 与 `MAKA_HOST_EPOCH`。shell 运行期间，启动器保留自己的 Host 客户端；子进程退出或启动失败时结清该客户端。退出会请求空闲关闭，其他已连接客户端仍会保留 Host。取消只停止本次启动器创建的子进程。

直接开发时，先保持一个已有 Host 可用，并提供其 endpoint，以及已知时的 epoch。shell 保留原有命令：

```sh
export MAKA_HOST_ENDPOINT=/path/to/host.sock
export MAKA_HOST_EPOCH=UUID
target/debug/maka-desktop-shell run --dir products/maka/desktop-shell/app
target/debug/maka-desktop-shell dev --dir products/maka/desktop-shell/app
target/debug/maka-desktop-shell check --dir products/maka/desktop-shell/app
```

`dev` 重新加载源码 app，使用 Host 的操作仍需相同连接环境。`check` 加载应用描述并报告诊断。`--help` 与 `--version` 不打开窗口，也不启动 Host。
