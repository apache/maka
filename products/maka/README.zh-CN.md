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

# Maka 产品组装

[English](README.md)

`products/maka/` 将底层 [platform](../../platform/README.zh-CN.md) 与业务 [plugins](../../plugins/README.zh-CN.md) 组装为最终交付的 `maka` CLI、ACP 服务以及终端/桌面工作台。

| 目录 | Crate / 包名 | 职责 |
| --- | --- | --- |
| [`bundle/`](bundle/README.zh-CN.md) | `@maka-agent/product` | 选取内置插件包并生成默认 Host 与 UI 部署组合 |
| [`native/`](native/src/lib.rs) | `maka-product-native` | 汇总并注册编译进二进制的原生 Rust `HostService` 工厂 |
| [`client/`](client/src/lib.rs) | `maka-app-client` | 面向公开 Host 服务的强类型 Rust 客户端封装 |
| [`workbench/`](workbench/package.ts) | `maka-workbench` | 终端与桌面共用的 TSX/NSH 界面包（`app/App.tsx`）及原生绑定（`src/bindings.rs`） |
| [`terminal-shell/`](terminal-shell/src/lib.rs) | `maka-terminal-shell` | 在终端内渲染并驱动 NSH 工作台（支持字符网格与终端像素协议） |
| [`desktop-shell/`](desktop-shell/src/main.rs) | `maka-desktop-shell` | 在独立原生窗口运行同一套 NSH 工作台（macOS AppKit、Windows Direct2D、Linux GTK） |
| [`acp/`](acp/src/lib.rs) | `maka-acp` | 通过 Agent Client Protocol 向外部编辑器与客户端暴露会话服务 |
| [`cli/`](cli/src/main.rs) | `maka-cli` | 构建 `maka` 主程序：默认终端入口、`host serve`、`desktop` 启动器、`acp`、`sandbox`、`browser` 及 `application` 管理命令 |

## Windows 剪贴板历史

启用快捷启动器和「剪贴板历史」后，输入 `cb` 可以搜索最近复制的文本、图片、PDF 和文件列表。选中一项即可将它复制回剪贴板。历史只保存在内存中，跳过来源应用标记为私密的内容。插件设置可调整条数或清空历史。

## 主动发现

在 Bot 顶部打开**主动发现**。留空调查方向进行广域探索，填写主题后做专题调查。新建的间隔计划默认在每轮运行结束后等待 30 分钟。编辑器也支持固定间隔、立即检查、暂停和恢复。

选择**只读工具**或**普通会话工具**，通过**查看具体工具**核对清单。两种模式都只读原工作区。调查会在状态根目录下的 `discovery/staging/<topic_id>/` 中准备草稿、diff 或核对清单。点击档案中的附件即可预览或复制。

每四次广域定期调度会从冷门来源独立探索一次；专题调查和文件变动则跟进已知主线。在 Bot 或档案微对话中说明哪些主题要跳过、何时再提醒，调查会把这些指示保存在本机的 `discovery/preferences.md`。

通过**查看调查过程**打开原调查会话。选中并引用 Bot 回复里的文字，可以把反馈关联到这轮调查。

## 运行与定向测试

在仓库根目录执行：

```sh
just setup
just run                      # 启动终端工作台（默认连接 ~/.maka/application/host）
just build --release          # 编译 maka 与 maka-desktop-shell（macOS 同步打包 Maka.app）
target/release/maka desktop   # 打开原生桌面端窗口
```

无论 Debug 还是 Release，`maka-cli` 编译时都会自动打包并内嵌当前插件集与 NSH 工作台；NSH 源码位于 [`third-party/nsh`](../../third-party/nsh/SOURCE.md)，随 Cargo 一并编译。

常用定向测试命令：

```sh
# 工作台前端逻辑与原生绑定单测
node --test products/maka/workbench/tests/*.test.mjs
cargo nextest run -p maka-workbench

# 终端 CLI 入口参数与边界检查
cargo nextest run -p maka-cli --no-default-features --test integration -E 'test(terminal_shell::)'

# 桌面端离屏原生渲染集成测试（macOS / Windows，或直接执行 `just test-desktop`）
cargo nextest run --locked -p maka-cli --no-default-features --features desktop-tests --test native-desktop -E 'test(terminal::desktop_new_session::)'
```

## Computer Stage

会话中的实时卡片显示已授权的 Computer 目标。可将前卡拖到四角、选择后卡将其置前，或使用 Pin/Follow 固定和跟随目标。前卡呈现原先绑定的原生窗口或浏览器窗口，由 OS 处理交互；点击裸露的 Maka 内容会将 Maka 置前，小卡保留在所选角落。Hide/Show 只控制 viewer，不停止 producer。

预览保持只读、有界、临时。呈现使用独立 client mutation；UI 不转发截图坐标、不合成键盘输入，也不能自选 PID/window/tab。
