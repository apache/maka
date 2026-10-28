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
| [workbench-views.ts](src/workbench-views.ts) | 会话、输入区和设置视图契约 |
| [composer-view.ts](src/composer-view.ts) | 输入区参数与常驻会话投影 |
| [workspace-view.ts](src/workspace-view.ts) | 工作区预览契约、操作与视图句柄 |
| [generated/runtime.ts](src/generated/runtime.ts) | Rust 协议类型与部署声明 |
| [generated/methods.ts](src/generated/methods.ts) | Host 服务方法的输入与输出类型 |
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

UI 模块导出同步的 `activate(context)`，返回 `UiActivation`：`{ exports, prepareReload? }`。其中 `exports` 以包声明中的局部 ID 为键，各项 `kind` 必须匹配，支持根界面、嵌入视图、命令、面板、设置页和工具渲染器。`root` 渲染完整应用，由部署来源的 `ui: { path, id }` 选择；`UiRootProps` 包含 `{ context, runtime }`。这些贡献通过普通 NSH 组件运行在桌面和终端中。安装的插件可使用客户端现有的可信能力；`nsh.cleanup` 释放激活实例拥有的资源。Host 服务接收请求作用域内的导入与附件，不提供环境级 Node API。

使用 `context.application`，让应用调用经过 UI 实例声明的服务绑定。它是原生应用客户端，保留 Client、journal 和原始 receipt。`context.services[importName][index]` 选择具体的绑定提供者，也支持有多个提供者的导入；`context.operations` 恢复该实例的原始 mutation receipt。可信 UI 代码仍可使用完整的 `context.host` 和 `maka/host` 客户端，包括根界面与目录集成。控制器应持有所属激活实例的应用客户端。

嵌入视图声明 `{ kind: 'view', contract: 'shared.contract.id' }`，并返回具有 `render({ context, runtime, input })` 的匹配实现。用 `defineUiViewContract<Input>(id)` 定义共享输入类型。消费方选择 `UiTarget`（`{ path, id }`），调用 `runtime.renderView(target, contract, input)`；`runtime.view(target, contract)` 解析贡献并检查其声明的种类与契约。目标可以来自插件配置，让其他已安装 UI 实例提供该界面。`workbench-views.ts`、`composer-view.ts` 和 `workspace-view.ts` 中的契约覆盖会话导航、会话界面、会话预览、输入区、设置和工作区预览；它们定义输入及所有权回调，不向消费方暴露提供者的私有状态。

命令实现 `run({ sessionId, argument? })` 和可选的 `enabled(context)`。声明提供 `title`，以及可选的 `description`、`shortcut`、`order`、`trigger`、`takesArgument` 和 `hint` 元数据；接受参数的命令必须声明触发词。根界面可以查看贡献目录，用 `runtime.commandEnabled(...)` 判断可用性，通过 `runtime.invoke(...)` 执行命令。

共享业务状态由所属激活实例持有。在替换共享 VM 前，可选的 `prepareReload()` 保存所拥有的编辑并返回 JSON。同一实例身份和包 ID 可通过 `context.restored` 收到该值，包括同一包的新修订；新实例收到 `null`。准备阶段失败时保留现有界面并恢复输入。UI 重载保留 Client、操作 journal 和 Host 已接受的工作；应恢复原操作，不重新提交。详见 [UI 编写指南](../../skills/maka-plugin-authoring/references/ui-plugins.md)。

客体运行时提供 `TextEncoder`、`TextDecoder`、`atob`、`URL` 和 `URLSearchParams` 进行纯文本与字节转换。可用 `Uint8Array.from(atob(value), c => c.charCodeAt(0))` 将 Base64 解码成字节；这些 API 不授予文件或网络访问权限。

TypeScript 帮助发现编写错误，运行时另外校验值、契约兼容性、资源槽位和权限。参阅[插件指南](../../plugins/README.zh-CN.md)和[可运行示例](../../skills/maka-plugin-authoring/references/quickstart.md)。
