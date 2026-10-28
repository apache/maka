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

# Maka plugin SDK

[English](README.md)

用于 Maka Host 服务和 NSH 工作台 UI 插件的 TypeScript 契约与辅助函数。从 `@maka-agent/plugin-sdk` 导入；guest 代码需要先打包，再交给运行时。

| 源码 | 用途 |
| --- | --- |
| [index.ts](src/index.ts) | `HostService`、`RequestContext` 和公开导出 |
| [workbench.ts](src/workbench.ts) | 共享 NSH UI 插件的激活和贡献类型 |
| [generated/runtime.ts](src/generated/runtime.ts) | Rust 协议类型与部署声明 |
| [contracts.ts](src/contracts.ts) | Host 服务契约 |
| [configurations.ts](src/configurations.ts) | 原生配置 schema |
| [native.ts](src/native.ts) | 包声明使用的原生实现定义 |

生成文件以 Rust 声明为源。修改声明后，在仓库根目录运行：

```sh
npm --workspace @maka-agent/plugin-sdk run schema:generate
npm --workspace @maka-agent/plugin-sdk run schema:check
npm --workspace @maka-agent/plugin-sdk run typecheck
```

生成过程使用 [maka-schema](../../tools/schema/README.zh-CN.md)，无需构建产品或 V8。运行时也可通过 `maka application schema` 导出目录。

UI 模块导出同步的 `activate(context)`，返回包中声明的根界面、命令、面板、设置页和工具渲染器。返回的 `UiExports` 以声明中的局部 ID 为键，各项 `kind` 必须匹配：命令提供 `run({ sessionId })`，其他贡献提供 `render(props)`。`root` 导出提供完整应用，由部署来源的 `ui: { path, id }` 选择，使用与其他 UI 贡献相同的包、激活和 NSH 组件。缺少根入口时不会回退到内置 Maka 界面。它们通过普通 NSH 组件运行在桌面和终端共用的工作台中。安装的插件视为已获用户信任，可使用客户端现有能力；`nsh.cleanup` 负责清理激活实例拥有的订阅和资源。Host 服务接收请求作用域内的导入与附件，不提供环境级 Node API。

根界面的 `render` 接收 `UiRootProps`，包含 `{ context, runtime, restored }`。可选的 `prepareReload()` 在替换共享 VM 前保存所拥有的草稿并返回 JSON。只有实例身份、贡献 ID 和包 ID 相同的根界面才能收到这份恢复状态，包括同一包的新修订；换成其他根界面时 `restored` 为 `null`。准备阶段在替换前失败时保留原界面并恢复输入；新根界面激活失败会报告错误，不回滚到原界面。UI 重载保留 Client、操作 journal 和 Host 已接受的工作；应恢复原操作，不重新提交。默认 Maka 根界面在交接前保存会话草稿；自定义根界面负责自己的草稿和私有状态交接。详见 [UI 编写指南](../../skills/maka-plugin-authoring/references/ui-plugins.md)。

客体运行时提供 `TextEncoder`、`TextDecoder`、`atob`、`URL` 和 `URLSearchParams` 进行纯文本与字节转换。可用 `Uint8Array.from(atob(value), c => c.charCodeAt(0))` 将 Base64 解码成字节；这些 API 不授予文件或网络访问权限。

TypeScript 帮助发现编写错误，运行时另外校验值、契约兼容性、资源槽位和权限。参阅[插件指南](../../plugins/README.zh-CN.md)和[可运行示例](../../skills/maka-plugin-authoring/references/quickstart.md)。
