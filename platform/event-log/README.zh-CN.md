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

# maka-event-log

[English](README.md)

`maka-event-log` 管理单个 State Root 的底层存储：操作系统级独占进程锁（`RootOwner`）、SQLite 数据库（`RootStore`）、两阶段 Host 操作账本，以及不可变检查点（Checkpoint）发布。上层 Agent 事实表与索引由 [`maka-agent-state`](../../plugins/agent/state/src/lib.rs) 通过组合迁移挂载到同一个 `RootStore` 上。

## 核心模块

- [`root.rs`](src/root.rs) 与 [`root_store.rs`](src/root_store.rs) — 持有 State Root 独占锁，并在停机时等待已接纳的在途操作结清。
- [`connection.rs`](src/connection.rs) 与 [`writeback.rs`](src/writeback.rs) — 独立线程运行单写者 FIFO 队列与并发只读快照通道，仅在事务确认提交后广播缓存失效信号。
- [`root_store/data.rs`](src/root_store/data.rs) — 提供按 Root 或 Session 隔离的 SQL 执行接口，支持原生服务将业务状态变更与 Host 操作回执放在同一写事务内原子提交。
- [`applications.rs`](src/applications.rs) — 存储部署源、调用方意图（`CallerIntent`）以及区分业务结果与物理清理的操作回执。
- [`checkpoints/`](src/checkpoints.rs) — 工作区与对话历史的内容寻址快照发布、Head CAS 推进以及崩溃后恢复结算。
- [`schema.rs`](src/schema.rs) 与 [`migration.rs`](src/migration.rs) — 基础表结构定义与多领域组合迁移校验。

## 检查点仓库（Checkpoint Repository）

`checkpoints::repository` 将不可变对象存储与逻辑会话绑定、Head CAS 提交解耦：

- **默认本地模式（`RootStore::open`）** — Head 表保存在当前 Root 库内，已校验的私有暂存文件经目录 `fsync` 后直接硬链接晋升，避免重复拷贝。
- **外部仓库模式（`RootStore::open_with_checkpoint_storage`）** — 注入自定义 `Storage` 实现。`FileRepository::open` 提供了独立于工作 Root 的本地多进程参考实现，用独立 SQLite 仲裁并发进程并用文件系统保存不可变对象。

`Storage::checkout_exact` 在检出当前 Head 前会完整校验对象摘要、工作区闭包以及逻辑会话绑定来源，且仅提供只读数据检出，不授予任何执行权限。

## 测试

```sh
cargo nextest run -p maka-event-log
```
