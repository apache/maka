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

## Checkpoint 仓库装配

[`checkpoints::repository`](src/checkpoints/repository.rs) 将不可变对象与逻辑 Session
身份、Head CAS、原提交回执分开。Session/agent 绑定持久保存，Root/scope/native Session
保留为来源信息。缺省 expected revision 表示仅当 Head 不存在时创建；冲突不自动改用
新 Head 重试。精确读取验证对象字节与 Workspace 依赖闭包，并拒绝验证期间已移动的
Head；历史格式与语义校验仍由原生历史所属领域负责。

现有发布与读取路径实际使用这些接口。`RootStore::open` 默认使用本地适配和原 Head 表。
可信装配层可以在打开 Host 前，通过 `RootStore::open_with_checkpoint_storage` 注入
`Storage`。`FileRepository::open` 提供独立于 worker Root 的持久参考实现：SQLite
仲裁独立进程，对象文件保存不可变内容。初始化需放在物理 I/O 线程；首版支持 Unix
本地文件系统，不提供网络文件系统或分布式数据库租约保证。

共享模式的 Root 只保留捕获与恢复记录，不写本地 Head。仓库同时提交 Head 与原回执；
响应丢失时查询原操作，不重新捕获。对象读取的临时故障保留已准备发布的可恢复状态；
缺失或非法材料不能推进 Head。读取 Head 不会认领新的来源 scope。
启动必须装配同一仓库、对象库和 agent 绑定。
已有本地发布需要显式迁移才能切换 authority。参考仓库目录必须私有且位于捕获的
Workspace 之外。对象尚无 GC；流式发布先生成独立临时副本，再确认持久化。

`Storage::checkout_exact` 可在源 Root 消失后读取逻辑 Session，但不授予执行权。
共享加载/恢复、Activation 租约、跨 Root 接管和具体云端传输仍是后续工作。
本地恢复及归档导出保持原行为，当前 operator CLI 不提供外部仓库配置入口。
checkpoint 未增加凭据、运行镜像或完整辅助 Agent 状态。

使用 `cargo nextest run -p maka-event-log` 运行已注册的测试。
`root_lease`、`checkpoint_restore` 和 `checkpoint_repository` 独立集成测试二进制将跨进程检查与其他测试的 Root 租约隔离。
