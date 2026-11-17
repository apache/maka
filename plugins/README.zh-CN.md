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

# 插件层（Plugins）

[English](README.md)

`plugins/` 下每个叶子 `package.ts` 声明一个可部署插件包（`application.host`、`application.ui` 或 `application.composition`），定义其配置 schema、依赖导入与服务导出。Cargo crate 仅代表 Rust 编译单元：复杂领域可拆成多个 crate，而一组轻量插件也可以共用同一个原生 crate。

| 目录 | 负责范围 |
| --- | --- |
| [`agent/`](agent/README.zh-CN.md) | 会话与 Room、模型协议适配、持久化执行引擎、Code Mode、MCP 客户端、Goal 与定时调度 |
| `workspace/` | 受沙箱约束的文件工具（`Read`、`Write`、`Edit`、`ApplyPatch`、`Glob`、`List`）、后台进程/PTY、网页抓取与搜索、Computer Use 绑定及 Decisions API |
| `settings/` | 模型连接、凭据管理、Token 用量统计与全局偏好设置 |
| `skills/` | 本地、远端与内置 `SKILL.md` 的发现、分页读取与安装 |
| `interactions/` | 向用户发起的结构化提问（`AskUserQuestion`）与权限审批交互 |
| `application/` | 运行时插件安装、部署检视与在线组合编辑 |
| `shared/` | 跨包共享的 TypeScript 契约辅助工具 |

## Host 与 UI 插件机制

- **Host 服务（`usePackage: "host"`）** — 可绑定可执行文件内置的 Rust 工厂，或在后台 V8 运行时加载打包好的 JavaScript `HostService`，仅持有组合图中显式授予的能力句柄。
- **UI 扩展（`usePackage: "ui"`）** — 在终端与桌面共用的 NSH 工作台 VM 中运行。模块入口 `activate(context)` 返回 `{ exports, prepareReload? }`，可贡献完整应用根节点（`root`）、带类型契约的嵌入式视图（`UiRuntime.renderView`）、命令、面板、设置页或工具结果卡片。`context.services` 与 `context.operations` 自动绑定该实例声明的后端服务与操作回执账本。
- **组合模板（`usePackage: "composition"` / `base.package`）** — 封装可复用的实例拓扑。默认安装通过 `base.package` 锁定产品基线，再叠加用户的增量 `overrides`（如 `configurationFields`、`remove`）与独立 `instances`，升级基线时不会破坏既有实例的状态命名空间；详见 [products/maka/bundle](../products/maka/bundle/README.zh-CN.md)。

## 单独构建与接入产品

在仓库根目录单独打包并检查某个插件：

```sh
node scripts/plugins/build.mjs --plugin plugins/workspace/workspace-web --output /tmp/maka-web-bundle
maka application inspect-package --package /tmp/maka-web-bundle/packages/workspace-web
```

若要将插件纳入默认 Maka 发行包：将路径加入 [`products/maka/bundle/package-inputs.json`](../products/maka/bundle/package-inputs.json)，在 [`products/maka/bundle/src/composition.ts`](../products/maka/bundle/src/composition.ts) 中声明实例与绑定；若包含新的原生 Rust 服务，还需在 [`products/maka/native/src/lib.rs`](../products/maka/native/src/lib.rs) 注册工厂。

编写独立插件可参考 [`@maka-agent/plugin-sdk`](../packages/plugin-sdk/README.zh-CN.md) 及内置技能 [`maka-plugin-authoring`](../skills/maka-plugin-authoring/SKILL.md)。
