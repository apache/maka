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

`maka-desktop-shell` 在独立窗口中运行[工作台](../workbench/README.zh-CN.md)：macOS 使用 NSH AppKit 后端，Windows 使用 NSH Direct2D 后端，Linux 使用 GTK。它运行的就是[终端 shell](../terminal-shell/README.zh-CN.md) 所运行的应用，编译在可执行文件内。在图形桌面上，工作台的顶部栏即窗口的标题栏，应用菜单提供工作台的命令及其快捷键。

在仓库根目录构建：

```sh
just build
# 或：just build --release
```

构建生成 CLI 和 shell。macOS 上在 `maka` 旁生成 `Maka.app`：shell 位于 `Contents/MacOS`，另有 `Info.plist` 和图标（取自 `assets/logo.png`），系统因此把窗口显示为 Maka 并使用其图标。`maka desktop` 启动的是 bundle 内的 shell，所以只用 Cargo 重新构建 shell 之后，要再运行一次 `just build` 来更新它。`--target TRIPLE` 可选择其他 Rust 目标。原生包包含 `bin/maka` 和 `bin/maka-desktop-shell`，Windows 可执行文件带后缀并附带 service helper；macOS 原生包包含 `bin/maka` 和 `bin/Maka.app/`。

`Maka.app` 默认使用临时签名，macOS 会把每次构建都当成新应用，屏幕录制和辅助功能授权随之失效。要在重新构建后保留授权，创建一个代码签名证书（Xcode 里的 Apple Development 证书，或在钥匙串访问中自签名），构建时把 `MAKA_CODESIGN_IDENTITY` 设为证书名称；用它第一次构建后，运行 `tccutil reset ScreenCapture org.apache.maka.desktop` 和 `tccutil reset Accessibility org.apache.maka.desktop` 清掉旧授权。

通过启动器启动：

```sh
/absolute/path/to/maka desktop
# 或指定其他 Host Root：
/absolute/path/to/maka desktop --root /absolute/path/to/business-host
```

`--root` 可选，指定业务 Host Root，默认使用 `~/.maka/application/host`。启动器把缺失的 Root 初始化为标准只读业务 Host，或重开其已保存的部署；随后对照已连接 Host 的端点、来源和 epoch 校验发现信息，并把 `MAKA_HOST_ROOT`、`MAKA_HOST_ENDPOINT` 和 `MAKA_HOST_EPOCH` 传给 shell，同时用 `MAKA_LAUNCHER` 传入启动器自身的路径。shell 以与终端 shell 相同的方式接入该 Host，并把客户端数据保存在该 Root 下。

从访达、程序坞或文件管理器直接打开时，shell 拿不到这些变量。它会运行所在目录里的 `maka desktop`（macOS 上是 `Maka.app` 旁边，其他平台是 shell 旁边），然后退出；由这个启动器为默认 Root 打开窗口。

关闭窗口只会隐藏窗口，并保留唯一的 UI 引擎和 Host 客户端；托盘的“打开”可以重新显示窗口。Linux 上如果没有能显示托盘的面板，关闭窗口会直接退出；面板离开时，已隐藏的窗口会重新显示。通过托盘、应用菜单或退出快捷键退出时，桌面和启动器会关闭各自的会话。最后一个客户端退出时，临时 Host 会停止并收尾它持有的工作。共享或受管的 Host 继续为其客户端服务。

Linux GTK 窗口从 Root 的 `clients/desktop-window.json` 恢复普通窗口大小以及全屏或最大化状态；桌面合成器负责窗口位置与显示器选择。GTK 提供原生菜单、文件拖放、剪贴板、目录选择器与系统通知。UI 重载会暂停物理输入，排空已接收的编辑，并在取消或完成后恢复输入。构建依赖见 [NSH Linux 指南](../../../third-party/nsh/docs/dev/linux.md)。

AppKit 或 Linux 窗口打开期间如果 Host 停止（崩溃，或在仍有客户端时被强制退役），shell 会在几秒内察觉，连接该 Root 的下一个 Host（没有运行中的 Host 时像 `maka desktop` 一样经由启动器启动），并在同一个窗口里重新加载工作台。工作台从头开始，与打开桌面时相同；停止的 Host 正在执行的那一轮显示为已停止。AppKit 的旧界面会停止接收操作，所有授权设置窗口随之关闭；Linux 保留旧工作台，但其中的操作会失败。shell 按逐步拉长的间隔重试，最长 30 秒。只有当它打开的那个 Root 仍在原路径时才会重连：被移走或删除的 Root 不会被重新初始化。

在 macOS 上，AppKit 窗口把窗口框架保存在应用的 defaults 里，而不是 `clients/desktop-window.json`，也不保存全屏状态。它会按上文所述跟随 Host 重连。需要重载界面的插件改动会在 Host 上生效，但窗口在重新打开前仍显示旧界面。AppKit 输入框没有 `tokens`，输入框里补全的 skill 引用只能逐字删除。窗口不发送系统通知。

## 电脑权限设置

Linux 和 Windows 保留内联授权流程；独立设置窗口目前仅支持 macOS。

AppKit 把系统权限设置放在独立、可调整大小的窗口里，按原始 Host 来源和请求去重；再次打开同一请求时聚焦已有窗口。关闭窗口或按 Escape 只退出设置，不取消原交互；取消始终由界面的明确操作完成。关闭主工作台也会关闭它的设置窗口。

在 macOS 的 AppKit 后端，经过验证的本机应用会显示系统实际图标，并可作为文件 URL 拖入系统设置。UI 和组件属性都不能指定拖出的路径。每次鼠标手势只启动一个拖放会话；取消或未能启动拖放不会关闭窗口，下一次手势仍可重试。设置窗口复用主工作台的客户端存储和外观设置，但其绑定仍指向请求原始的 Host 服务范围，包括远程来源。Host 更换时，会先销毁旧的设置界面，再加载新的工作台。AppKit 只将权限窗口置为浮动层，并停靠在当前屏幕右上方的可见工作区内，避免被系统设置覆盖；再次聚焦同一请求不会改变用户调整过的位置，主工作台不会置顶。


## Windows Direct2D

在普通 PowerShell 终端中，从仓库根目录执行：

```powershell
npm ci
cargo build -p maka-cli -p maka-desktop-shell
.\target\debug\maka.exe desktop --root "$env:USERPROFILE\.maka\direct2d"
```

Windows Rust/MSVC 环境要求见[原生构建工具](../../../scripts/rust/README.zh-CN.md)和 [NSH Windows 指南](../../../third-party/nsh/docs/dev/windows.md)。构建前须安装 lockfile 中的 JavaScript 依赖：否则缺失的 npm 包可能成为生成插件包中的未解析运行时导入。补齐不完整的依赖安装后，需要重新构建 CLI 内嵌的 UI 包。

Windows 桌面只使用 Direct2D。原生目录选择器运行在独立的 COM apartment 线程上。窗口在整个生命周期内连接已获准的 Host；Host 停止后不自动重连。UI 重载和系统通知请求会被明确拒绝。独立的系统权限设置窗口暂不支持，工作台因此保留内联授权流程。窗口前台状态由 Win32 激活消息驱动，字号改动立即生效，工作台退出命令会关闭原生窗口。

## 验证

```powershell
cargo test -p maka-desktop-shell
cargo test --manifest-path third-party/nsh/Cargo.toml -p nsh-platform-windows --lib
cargo clippy --manifest-path third-party/nsh/Cargo.toml -p nsh-platform-windows --all-targets -- -D warnings
```

性能对比须采用相同 release 配置、Host 可执行文件、窗口尺寸和初始数据。桌面壳启动与 Host 接入分别计时，不应将错误边界页面与完整加载的工作台进行比较。
