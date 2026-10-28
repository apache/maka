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

# Maka 工作台

共享 NSH 客户端运行时与 Maka 默认 UI 包。原生 bindings（`src/bindings.rs`）将可信 UI 代码连接到公共 Host。[package.ts](package.ts) 声明普通包 `maka.workbench`，其 `root` 贡献由 `app/App.tsx` 实现。Markdown 使用 `nsh/base` 的 `TextView` 渲染。

crate 只打包通用加载器 `app/Bootstrap.tsx`。shell 连接 Host，用 `host::admit` 接入，为该连接创建 `bindings::Bindings`，通过 `configuration` 提供视口、环境和数据目录。bootstrap 加载部署来源通过 `ui: { path, id }` 选择的完整 UI。默认产品选择 Maka 根界面，使用其他 UI 插件共用的不可变包构建流程，将它编译为包中的 `app/App.js`。自定义根界面拥有自己的导航、布局和交互；缺少根入口时不会加载 Maka。[终端 shell](../terminal-shell/README.zh-CN.md) 和[桌面 shell](../desktop-shell/README.zh-CN.md) 使用相同的加载器与原生运行时。在图形桌面上，默认根界面使用 `app/chrome.ts` 让顶部栏充当标题栏，并设置应用菜单。

已安装 UI 作为可信代码运行在共享 NSH VM 中，可使用动态 JavaScript 求值与原型扩展，以及 NSH 支持的 HTTP 方法、WebSocket、剪贴板、文件选择器、打开 URL、已注册的 Host 函数、完整 Maka 原生客户端和声明的服务。原始 TCP、进程、文件系统和环境访问遵循 NSH 原生 API 的规则。

在新目录中生成当前 NSH 和原生 Host 的声明，然后用 TypeScript 检查实际应用：

```sh
cargo run --locked -p maka-workbench --example ui_types -- /tmp/maka-workbench-types
tsc -p /tmp/maka-workbench-types/tsconfig.json --noEmit --skipLibCheck false
```

该 example 从 UI 包使用的同一份 NSH 源码和原生 registry 生成声明。生成的 TypeScript 项目包含 `Bootstrap.tsx`、`App.tsx` 和 Computer 权限组件，也检查它们实际导入的文件。它不会连接 Host 或打开桌面。请使用尚不存在的输出目录，以及与当前 `nsh check` 工具链兼容的 TypeScript 编译器。

[真实 Host 测试 fixture](../terminal-shell/tests/support/mod.rs) 对实际的 `maka/host` registry 调用 `nsh_core::element::declarations`，将 `host.d.ts` 写入 `MAKA_NSH_EVIDENCE` 指定的目录。可在仓库根目录运行 CI 同样选取的模型搜索测试来收集它：

```sh
MAKA_NSH_EVIDENCE=/tmp/maka-nsh-evidence cargo nextest run --locked --workspace \
  -E 'package(=maka-cli) & binary(=terminal_real_host) & test(=keyboard::connection_filter_preserves_model_search_focus_and_keyboard_selection)'
```

这会运行真实 Host 测试，不是独立的类型生成器，也不对应用做 TypeScript 类型检查。
