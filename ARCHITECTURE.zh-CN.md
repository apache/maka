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

# 架构

[English](ARCHITECTURE.md)

Maka 通过插件组装应用。包声明自身提供与依赖的能力，组合（composition）选择实例并将导入绑定到导出。Host 服务持有执行、权限与持久状态；UI 插件向终端和桌面共用的工作台提供 NSH 组件。

## 代码归属

[平台](platform/README.zh-CN.md)包含包加载器、组合内核、持久化原语、执行所有者与原生渲染器。[插件](plugins/README.zh-CN.md)包含领域契约、业务功能及其声明。[Maka 产品](products/maka/README.zh-CN.md)选择包、原生工厂与启动入口。

叶目录的 `package.ts` 标识一个插件声明（`host`、`ui` 或 `composition`），Cargo crate 标识编译单元。两者不必一一对应：Agent 领域按严格单向依赖拆分为多个 crate，相关插件入口也可共用同一个原生实现 crate。

组合内核在同一份已提交配置源中描述 Host、UI 与结构性实例。`host-js` 在后台 V8 运行时中执行 JavaScript Host 服务。[工作台](products/maka/workbench/README.zh-CN.md)在桌面与终端外壳共用的 NSH VM 中运行可信 UI 模块，两种外壳注入一致的 Host 绑定。NSH 负责响应式布局、输入和渲染；原生文件快照与剪贴板资源由 [ui-support](platform/ui-support/README.zh-CN.md) 提供。

## 从包到运行中的应用

1. 包加载器校验不可变包内容并计算内容引用。
2. 组合规划器检查每个 Host、UI 或结构性节点及其配置 schema 与绑定。
3. State Root 按修订原子提交期望配置源及包内容。
4. [Host 运行时](platform/host-runtime/README.zh-CN.md)协调已启用的后台服务；工作台观察同一配置源，按需激活已启用的 UI 贡献。

安装将不可变包加入可用目录；显式组合节点决定启用哪些贡献。已安装的 UI 插件作为可信代码运行在工作台 VM 中，直接使用现有 NSH 与 Host 客户端能力，不另设 UI 插件沙箱。每次调用准入时，Host 仍实时校验调用方激活身份、方法授权、输入 schema 与实际资源托管。本地 IPC 连接仅携带启动器授予的方法与回执恢复权限。

更新配置源会保留未改变的激活及其已捕获绑定；变更或移除的实例先停止接收新请求，待已接受调用与原生资源结算后再退役。即使 UI 组件卸载或客户端断开连接，已接受的 Host 工作与变更回执仍归原所有者托管。

桌面、终端像素渲染和终端 Unicode 渲染运行同一个 TSX/NSH 工作台。UI 模块在 NSH 响应式所有者下导出 `activate(context)`，注册根界面、视图、命令、面板、设置页与工具渲染器；可选的 `prepareReload()` 在同一实例与包身份跨 VM 重载时移交 JSON 状态。

## Root 持久化、操作回执与资源托管

[EventLog](platform/event-log/README.zh-CN.md)（`maka-event-log`）持有通用 State Root 持久化底座：每个 Root 对应唯一独占系统文件锁（`RootOwner`）与单一 SQLite 数据库（`RootStore`）。单写者队列串行提交变更，独立只读通道读取已提交快照，可丢弃观察通道维护派生会话目录与 FTS 检索缓存。领域模块在同一个 `RootStore` 上注册 SQL migration，不拆分独立 Agent 数据库，也不引入分布式租约或 TTL 心跳锁。

稳定的插件数据归属于 `(Root, deployment, instance)`。包修订与激活 epoch 仅标识代码版本与实时执行代际，不会创建新的数据命名空间。

带副作用的 Host 调用采用调用方意图与提供方结算分离的两段式账本：

- **调用方意图（`CallerIntent`）**：变更进入提供方最终准入前，Host 先持久化调用方锁定的原始 `RecoveryRef`（目标部署、实例、导出、方法、操作 UUID、请求指纹与契约摘要）及调用方提供的不透明恢复描述符。实时原生所有者激活可只读反查自身 caller journal，该权限不授予任何跨提供方方法执行或恢复权。
- **独立的 `Outcome` 与 `Cleanup`**：提供方回执（`application_operations`）将业务结果认识（`NotExecuted`、`Returned`、`Unknown`）与物理资源清理（`Unconfirmed`、`Confirmed`、`Failed`）拆分为独立单调推进的状态机。
- **严格的未执行与未知边界**：调用方意图一旦落盘，提供方未见回执绝不等同于未执行；仅当调用方自身意图账本权威证明未准入，或原提供方给出封堵晚到准入的权威证明时，才记为 `NotExecuted`。传输中断或重启在途操作记为 `Unknown`，默认阻断自动重发，同时允许原提供方的迟到权威结算（`OperationResolvedLate`）入账且不改写已被后续步骤消费的历史截点。
- **同库纯状态同事务提交**：仅修改同一 Root 数据的原生状态变更与提供方 `Returned` 回执在同一个 SQLite 写事务内原子提交，事务内不执行网络或子进程 I/O。
- **证据钉住与物理清理确认**：未完结运行、未决或 `Unknown` 操作、未确认清理、活跃 Cell 与不可变历史快照各自独立钉住（pin）所依赖的内容寻址对象与回执，直至结果与物理清理双双结算。观察者掉线、流 EOF、超时或 Root 退役仅触发取消请求，绝不充当资源已清理的证明。

## 持久 Agent 执行与中断恢复

[Agent 插件族](plugins/agent/README.zh-CN.md)沿单向 crate 依赖切分规范事实、确定性存储折叠、收敛决策与实时 Host 能力：

- **`facts`、`api` 与 `ports`**：定义规范持久记录、公共服务契约与执行端口接口，不持有实时 Host 句柄。
- **`state`（`maka-agent-state`）**：管理 `RootStore` 上的 Agent SQL migration、规范事实追加，以及同写事务内的确定性投影折叠（并发运行前沿、电平触发等待集、Code Mode Cell、会话持久数据、产物清单、不可变历史快照、会话目录、用量统计与 Recall 索引）。`state` 不决定下一步动作，不调度任务，也不签发实时权限。
- **`engine`（`maka-agent-engine`）**：实现唯一的强类型持久收敛器与驱动器。正常在线轮次、工具审批与表单交互、模型退避重试、语义上下文压缩与冷重启恢复共用同一套前沿收敛主干。
- **`authority` 与 `native`（`maka-agent-authority`、`maka-agent-native`）**：持有实时 `Activation` 托管与单驱动认领栅栏（driver claim），将开局 `RunSpec` 权限上限与工作区实时策略求交集，适配模型、工具与外部执行器并按索引驱动就绪或到期运行。

核心执行契约：

- **稳定运行身份，无物理接力链**：单次逻辑运行在审批等待、退避重试、上下文压缩与进程重启间保持同一稳定 `RunId`，内部由稳定 `StepId` 与真实上游生成尝试 `ModelAttempt` 组成（本地驱动重启不新建 `ModelAttempt`）。对已进入 `Failed` 或 `Cancelled` 终态的运行执行手动续接时，基于校验通过的历史源截点创建全新 `RunId`。
- **并发义务前沿与 `Unknown` 风险裁决**：流式模型工具调用、本地与服务工具派发、用户交互与后台 Cell 构成显式并发义务集。任何结果处于 `Unknown` 的副作用均进入强类型阻塞（`TypedBlocker`），禁止模型更换调用 ID 隐式重试变更；人工风险裁决以独立控制事实记录，永不伪造或覆盖原操作回执。
- **Code Mode（`Cell` 与 `SessionData`）**：持久化 `Cell` 生命周期（`CellStarted`、`CellCompleted`、`CellInterrupted`）、嵌套子效果绑定、动态加载工具集及会话键值数据（`SessionData` 在 Cell 完成被接纳的同一事务内原子发布）。中断的 Cell 须先对账其名下全部已准入嵌套效果后方可进入重规划；恢复过程不做 V8/Python 堆内存快照，也不重放任意脚本。
- **外部执行器**：内置的 Claude Code、Codex 和 Antigravity CLI 在原工作区使用原生完整权限执行，`TaskOwner` 托管进程并记录执行证据。独立的 ACP 服务适配器（`acp-executor`）仍使用私有工作区，经 Host 发布接纳的改动。历史记录、元数据与工作区快照不赋予任何执行或权限授权。Host 正常退出时会关闭它持有的原始进程组。Host 丢失后，恢复流程读取原始证据，证据不足时保留结果未知的状态。
- **上层 Agent 协同**：普通父子会话、`Assistant`（Bot）、`Goal` 与 `Scheduler` 均通过公共 Session 契约、持久预算统计与稳定 `RunId` 协同运行。

## 开发、CI 与分发

每次 CLI 构建嵌入产品 bundle，每次工作台构建嵌入其 TSX 应用。UI 插件源码与资源通过不可变包存储加载，安装或更新 UI 插件无需重新构建客户端；重新编译可执行文件也不会覆盖已有安装已提交的组合配置。

Rust 契约通过 [maka-schema](tools/schema/README.zh-CN.md) 生成 [`@maka-agent/plugin-sdk`](packages/plugin-sdk/README.zh-CN.md)，无需构建 V8 或完整产品。`just` 与 GitHub Actions 共用 [`scripts/ci.mjs`](scripts/ci.mjs) 中的套件路由、`cargo nextest` 归档打包与独立目录重放定义。npm 包 [`@maka-agent/cli`](packages/cli/README.zh-CN.md) 仅负责启动对应平台的原生可执行文件。
