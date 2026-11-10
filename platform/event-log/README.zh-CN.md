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

负责 State Root 的 SQLite 数据库、物理写租约、应用记录、Session 资源和检查点发布。
Agent 事实、历史、索引和内容所有权由
[`maka-agent-state`](../../plugins/agent/state) 负责。

- [`root`](src/root.rs) 和 [`root_store`](src/root_store.rs) 将工作绑定到当前 Root，
  并协调关闭与已接纳操作的结算。
- [`connection`](src/connection.rs) 在专用线程上运行有界写队列和读取通道。
  [`writeback`](src/writeback.rs) 提交类型化语句，仅在确认提交后发布限定范围的变更提示。
- [`root_store::data`](src/root_store/data.rs) 提供 Root 和 Session 范围的 SQL 访问。
  领域状态可以与原始 Host 操作回执在同一事务中提交。
- [`applications`](src/applications.rs) 保存应用来源、部署、意图和操作结果。
- [`checkpoints`](src/checkpoints.rs) 和
  [`root_store::checkpoints`](src/root_store/checkpoints.rs) 发布不可变快照与 Workspace 对象，
  校验精确 Head，并在进程重启后结算已准备的恢复操作。历史快照由所属领域提供。
- [`schema`](src/schema.rs) 定义当前 Root schema；
  [`migration`](src/migration.rs) 校验组合后的迁移账本。
  产品在打开存储时组合 Root 与领域 migrations。

使用 `cargo nextest run -p maka-event-log` 运行已注册的测试。
`root_lease` 和 `checkpoint_restore` 独立集成测试二进制将跨进程检查与其他测试的 Root 租约隔离。
