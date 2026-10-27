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

Maka 各 shell 运行的 Agent 工作台：用 TSX 编写的 NSH 应用（`app/`），以及应用访问公共 Host 所用的原生 bindings（`src/bindings.rs`）。Markdown 由 `app/MarkdownBody.tsx` 使用 `nsh/base` 的 `TextView` 渲染。

构建时把 `app/App.tsx` 打包进 crate（`APPLICATION`，其导入的文件在 `ApplicationAssets` 中）。shell 连接 Host，用 `host::admit` 接入，为该连接创建 `bindings::Bindings`，在 `configuration` 的基础上补充自己的视口、环境和数据目录，再交给自己的 NSH 后端运行。[终端 shell](../terminal-shell/README.zh-CN.md) 在终端中运行它，[桌面 shell](../desktop-shell/README.zh-CN.md) 在窗口中运行它。在图形桌面上，`app/chrome.ts` 让窗口顶边的顶部栏充当标题栏，并设置应用菜单。

[真实 Host 测试 fixture](../terminal-shell/tests/support/mod.rs) 对实际的 `maka/host` registry 调用 `nsh_core::element::declarations`，将 `host.d.ts` 写入 `MAKA_NSH_EVIDENCE` 指定的目录。可在仓库根目录运行 CI 同样选取的模型搜索测试来收集它：

```sh
MAKA_NSH_EVIDENCE=/tmp/maka-nsh-evidence cargo nextest run --locked --workspace \
  -E 'package(=maka-cli) & binary(=terminal_real_host) & test(=keyboard::connection_filter_preserves_model_search_focus_and_keyboard_selection)'
```

这会运行真实 Host 测试，不是独立的类型生成器，也不对应用做 TypeScript 类型检查。
