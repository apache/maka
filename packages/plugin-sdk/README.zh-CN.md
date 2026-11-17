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

# `@maka-agent/plugin-sdk`

[English](README.md)

面向 Maka Host 服务与 NSH 工作台 UI 插件的 TypeScript 类型契约与辅助库。插件代码需先打包为独立模块再交由运行时加载。

| 模块 | 内容 |
| --- | --- |
| [`src/index.ts`](src/index.ts) | `HostService`、`RequestContext` 与顶层公共导出 |
| [`src/workbench.ts`](src/workbench.ts) | NSH UI 插件 `activate(context)` 入口、贡献声明、`UiContext` 与 `UiRuntime` |
| [`src/workbench-views.ts`](src/workbench-views.ts) | 侧栏导航、会话流、预览与设置页的共享视图契约 |
| [`src/composer-view.ts`](src/composer-view.ts) | 可替换输入框（Composer）视图契约与常驻会话控制器接口 |
| [`src/workspace-view.ts`](src/workspace-view.ts) | 工作区文件/差异预览契约与操作句柄 |
| [`src/generated/runtime.ts`](src/generated/runtime.ts) | 由 Rust 协议自动生成的传输类型与部署结构 |
| [`src/generated/methods.ts`](src/generated/methods.ts) | 强类型 Host 服务方法入参与返回值定义 |
| [`src/contracts.ts`](src/contracts.ts) | 由 [`tools/schema`](../../tools/schema/Cargo.toml) 导出的完整 JSON Schema 目录 |

## UI 扩展与热重载状态移交

- **服务绑定** — `context.services[importName][index]` 调用当前 UI 实例声明绑定的后端服务，`context.operations` 查询并恢复该实例的两阶段写操作回执；可信 UI 代码也可直接访问完整的 `context.host`。
- **嵌入式类型视图** — 用 `defineUiViewContract<Input>(id)` 定义共享视图协议，通过 `runtime.renderView(target, contract, input, options?)` 动态校验并挂载目标组件。
- **命令注册** — 实现 `run({ sessionId, argument? })` 与可选的 `enabled(context)`，支持配置标题、快捷键与命令触发前缀。
- **热重载移交** — 实现可选的 `prepareReload()` 可在工作台 VM 重载前返回 JSON 快照；相同 `(instance, packageId)` 的新实例会通过 `context.restored` 接手该状态，底层 Host 连接与在途操作账本保持不断。

## 重新生成契约

修改 Rust 端协议结构后，无需编译 V8 或完整 CLI，直接通过 [`maka-schema`](../../tools/schema/Cargo.toml) 更新并校验 SDK：

```sh
npm --workspace @maka-agent/plugin-sdk run schema:generate
npm --workspace @maka-agent/plugin-sdk run schema:check
```

完整开发示例见 [plugins](../../plugins/README.zh-CN.md) 与内置技能 [`maka-plugin-authoring`](../../skills/maka-plugin-authoring/SKILL.md)。
