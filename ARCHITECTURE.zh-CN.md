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

# 系统架构

[English](ARCHITECTURE.md)

Maka 按职责切分为三层：

- **[Platform](platform/README.zh-CN.md)** — 插件包加载器、组合规划器、SQLite 事件存储（`maka-event-log`）、Host 服务生命周期、V8/Python 运行时、系统沙箱、Computer Use 以及 NSH 原生客户端支撑。
- **[Plugins](plugins/README.zh-CN.md)** — 业务领域实现（`agent`、`workspace`、`skills`、`settings`、`interactions`）及对外协议契约。
- **[Products](products/maka/README.zh-CN.md)** — 原生工厂注册、默认产品组装、共享 NSH 工作台、CLI、ACP 服务以及终端/桌面壳层。

插件包（`package.ts`）是部署与组合单元（`host`、`ui` 或 `composition`），Cargo crate 则是 Rust 编译边界，两者不必一一对应：Agent 领域按单向依赖拆成多个 crate，而体量较小的相关插件可以共用同一个原生实现 crate。

## 插件组合与 UI 运行时

1. 包加载器校验不可变的 `.maka-plugin` 字节流并计算内容摘要。
2. 组合规划器校验各 Host、UI 与组合节点的配置 schema 及导入导出契约。
3. State Root 以递增版本号原子提交目标部署描述与插件包字节。
4. `maka-host-runtime` 在后台按目标状态调谐 Host 服务；NSH 工作台监听同一份部署源并按需挂载启用的 UI 扩展。

安装插件只是把包写入本地不可变仓库，是否生效完全由组合图决定。热更新组合时，未变更的服务实例保持运行并保留已有绑定；变更或移除的实例先停止接纳新请求，待在途调用与底层资源全部结清后再退役。

桌面端窗口、终端像素渲染与终端字符网格运行同一套 TSX/NSH 工作台代码。可信 UI 模块通过 `activate(context)` 注册应用根节点、嵌入式视图、命令、面板、设置页与工具卡片；可选的 `prepareReload()` 用于在工作台热重载时向同一实例平滑移交 JSON 状态。

## State Root 与两阶段操作日志

[maka-event-log](platform/event-log/README.zh-CN.md) 负责单个 State Root 的持久化：一把操作系统级独占文件锁（`RootOwner`）配一个 SQLite 数据库（`RootStore`）。写入走单队列串行提交，读取走独立快照连接，另有一条可随时重建的后台通道维护对话摘要与全文检索索引。各业务领域直接在 `RootStore` 上注册 SQL migration，不单独拆库。

插件持久化状态归属于 `(Root, deployment, instance)`；升级包版本或重启服务实例不会切换数据命名空间。

带副作用的 Host 调用采用“调用方意图 + 提供方回执”两阶段账本：

- **调用方意图（`CallerIntent`）** — 变更进入目标服务前，Host 先落盘调用方的 `RecoveryRef`（目标实例、方法、操作 UUID、请求指纹与契约摘要）。断线重连或进程重启后，调用方先查意图账本核对原操作，而不是盲目重发。
- **业务结果与资源清理分离** — 服务回执表（`application_operations`）将业务结果 `Outcome`（`NotExecuted`、`Returned`、`Unknown`）与物理资源清理 `Cleanup`（`Unconfirmed`、`Confirmed`、`Failed`）分开记录，各自单调推进。
- **显式保留未知态** — 一旦记录了调用意图，缺失回执绝不等同于“未执行”。在途中断会落为 `Unknown`，阻止自动重放，同时允许晚到的权威结算（`OperationObserved`）归档而不篡改已消费的历史切面。
- **同库状态原子提交** — 同一 Root 内的纯状态变更与其 `Returned` 回执在同一个 SQLite 写事务内原子提交，锁内不做网络或子进程 I/O。
- **证据钉住（Pinning）** — 未完结的 Run、`Unknown` 操作、未确认清理的资源、活跃 Code Mode 单元及历史快照各自钉住关联的内容寻址对象，直到业务结果与物理清理双双结清。

## Agent 持久执行与中断恢复

[Agent 领域](plugins/agent/README.zh-CN.md)沿单向 crate 边界逐层解耦：

- **`facts`、`api`、`ports`** — 持久化事实结构、公开协议契约与抽象执行接口，不持有任何运行时句柄。
- **`state`** — SQLite 表结构迁移、事实追加，以及同事务内的确定性状态折叠（并发运行前沿、水平触发等待、Code Mode 单元、`SessionData`、附件、历史快照、会话目录、用量统计与 Recall 索引）。
- **`engine`** — 统一的确定性调谐器（Reconciler）与执行驱动。在线对话、工具审批、模型退避重试、上下文压缩以及冷启动恢复，全部走同一套状态前沿推进循环。
- **`authority`、`native`** — 持有活跃实例租约与单驱动声明，求交初始 `RunSpec` 与当前工作区权限，绑定模型、工具与外部执行器并调度就绪任务。

核心执行不变量：

- **稳定的 `RunId`** — 一次逻辑运行在跨越工具审批、重试、上下文压缩与 Host 重启时始终保持同一个 `RunId`，内部划分为稳定的 `StepId` 与真实上游请求 `ModelAttempt`。运行失败或取消后的手动续跑，会基于已校验的历史切面开启新的 `RunId`。
- **并发义务前沿（Obligation Frontier）** — 流式工具调用、用户交互与后台单元构成显式义务集合。恢复时优先核对原始回执；一旦某个副作用结果无法确认，Run 直接以明确诊断失败并封锁后续推进，绝不换新 ID 静默重跑。
- **Code Mode（`Cell` 与 `SessionData`）** — 持久化单元生命周期、嵌套工具调用绑定以及随单元成功原子发布的键值存储 `SessionData`。Maka 不做 V8/Python 堆快照，恢复时也绝不重放脚本。
- **外部执行器** — 内置的 Claude Code、Codex 与 Antigravity 适配器在原工作区由 `TaskOwner` 托管子进程并留存证据；独立的 ACP 服务适配器（`acp-executor`）则在隔离工作区运行并通过 Host 发布变更。

## 构建、SDK 生成与 CI

`maka-schema`（`tools/schema`）无需编译 V8 或完整产品即可直接从 Rust 契约生成 [`@maka-agent/plugin-sdk`](packages/plugin-sdk/README.zh-CN.md)。CLI 构建产物内嵌默认产品包与工作台代码，用户安装的插件则从不可变包仓库动态加载。本地 `just` 命令与 GitHub Actions 复用 [`scripts/ci.mjs`](scripts/ci.mjs) 中的变更路由与 `cargo nextest` 归档执行逻辑。
