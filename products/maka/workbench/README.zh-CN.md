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

Maka 各 shell 运行的 Agent 工作台：用 TSX 编写的 NSH 应用（`app/`），应用访问公共 Host 所用的原生 bindings（`src/bindings.rs`），以及原生 Markdown 组件（`src/markdown.rs`）。

构建时把 `app/App.tsx` 打包进 crate（`APPLICATION`，其导入的文件在 `ApplicationAssets` 中）。shell 连接 Host，用 `host::admit` 接入，为该连接创建 `bindings::Bindings`，在 `configuration` 的基础上补充自己的视口、环境和数据目录，再交给自己的 NSH 后端运行。[终端 shell](../terminal-shell/README.zh-CN.md) 在终端中运行它，[桌面 shell](../desktop-shell/README.zh-CN.md) 在窗口中运行它。在图形桌面上，`app/chrome.ts` 让窗口顶边的顶部栏充当标题栏，并设置应用菜单。

`cargo run -p maka-workbench --example ui_types` 输出 Markdown 模块的 TypeScript 声明。
