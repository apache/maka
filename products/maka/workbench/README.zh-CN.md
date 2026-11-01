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

[真实 Host 测试 fixture](../terminal-shell/tests/real_host/support.rs) 对实际的 `maka/host` registry 调用 `nsh_core::element::declarations`，将 `host.d.ts` 写入 `MAKA_NSH_EVIDENCE` 指定的目录。可在仓库根目录运行 CI 同样选取的模型搜索测试来收集它：

```sh
MAKA_NSH_EVIDENCE=/tmp/maka-nsh-evidence cargo nextest run --locked --workspace \
  -E 'package(=maka-cli) & binary(=integration) & test(=terminal::keyboard::connection_filter_preserves_model_search_focus_and_keyboard_selection)'
```

这会运行真实 Host 测试，不是独立的类型生成器，也不对应用做 TypeScript 类型检查。

输入框上方的任务、计算机访问和队列消息共用一个可折叠详情区。收起时保留摘要，数据更新不会自动展开或切换当前查看的内容；切换详情保留尚未提交的队列编辑。待处理审批和未确认操作的恢复入口保持独立。已完成的操作反馈会在四秒后消失。检查原操作只会读取其回执；仍无法确认结果时，可以忽略提示，原始记录会保留，操作不会因此被取消或重新执行。

在会话操作菜单中选择 **置顶会话**，会话会出现在列表顶部的 **已置顶** 分组；选择 **取消置顶** 可恢复普通列表位置。Host 持久化这一选择，并在不同界面和重启后保持一致的分页顺序。

**设置 → 技能**可从 GitHub `owner/repository`、Git URL、GitHub 子目录 URL，或所连接 Host 上的目录发现技能。选择技能后，可安装到全局或项目的 `.agents/skills`、`.maka/skills`。同名技能按项目 `.maka`、项目 `.agents`、全局 `.maka`、全局 `.agents` 的顺序整体覆盖；卡片保留每个位置的实例并标明是否生效。删除高优先级实例后，下一层自动生效。

只有通过 Maka 安装的技能显示更新按钮。更新从登记的来源替换整个目录及其资源，并覆盖本地修改。四个标准目录中的其他技能同样可以查看和删除。来源登记保存在 Host 数据库中，不创建 npx lockfile 或另一套私有技能副本。

**设置 → MCP 服务器**通过命令和 HTTP 表单管理上述四个目录的 `mcp.json`，保留其他条目和自定义字段。选择项目无需创建会话。下载、文件修改和来源登记均在所连接的 Host 上完成；保存项目 MCP 配置不会自动授予信任。

**设置 → 连接与模型** 将提供商登录、连接信息和模型列表放在一起。新建或修改连接后，可以一次完成保存并登录。设备登录会打开浏览器，对话框保留验证码、复制和取消操作。登录成功后，获取模型失败可以单独重试。高级连接与模型选项折叠显示；已保存的连接可以重新加载外部更改，返回时会确认是否放弃未保存的编辑。
