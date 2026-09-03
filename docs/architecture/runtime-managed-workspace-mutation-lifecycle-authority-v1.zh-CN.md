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

# Managed Mutation Lifecycle Authority v1

## 1. 交付边界

本切片只证明一个主要不变量：

> 从 managed Write/Edit 的 T1 持久化开始，到可信 terminal state 为止，同一个 workspace instance
> 只能存在一个 durable mutation owner；成功 outcome、successor workspace version 与 canonical head
> 必须同时可见或同时不可见；T1 以后 Runtime 不得静默回退到 generic T2。

本切片是后续 Git candidate 与 Write/Edit 生产接线的 persistence/runtime authority。它不创建 managed
worktree、不执行文件写入、不引入 Git 或 npm 数据面，也不向 Desktop/CLI 开放新模式。没有直接产品消费者
不是本切片的 correctness 缺陷；后续消费者必须通过这里的 internal capability，而不能复制写入逻辑。

## 2. Owner

| 事实或能力 | 唯一 owner | 代码约束 |
| --- | --- | --- |
| immutable T1 与 managed mutation identity | `SqliteRuntimeStore.commitToolPrepared()` | T1 与 reservation 在同一 SQLite transaction 中提交 |
| active mutation ownership | SQLite reservation projection | `workspace_instance_id` 主键跨进程仲裁；投影可从 RuntimeEvents 重建 |
| accepted successor 与 canonical head | workspace successor authority writer | 只消费 repository owner 验证后的 opaque candidate capability；generic writer 不能写 reserved fact |
| live provider result | `ToolRuntime` | 在 operation 返回边界生成 bounded strict-JSON immutable snapshot |
| no-effect terminal proof | managed mutation owner | 先签发 opaque no-effect capability；Storage verifier 还原并逐字段绑定 terminal identity，普通 outcome 无权释放 reservation |
| terminal durable proof | managed admission owner | Runtime 只 adopt 已提交的 exact outcome envelope，不代写 managed T2 |

`RuntimeEvents` 是 durable truth；workspace head 与 reservation 表只是可删除、可重建的投影。internal writer
通过未导出的 registration/capability seam 暴露，不能依靠注释约束调用者。

当前切片没有生产消费者，在线 authority 校验继续直接读取 immutable RuntimeEvents，避免为了尚未确定的
生产查询形状提前增加 SQLite schema/index 合同。接入真实 Write/Edit consumer 前，必须基于实际访问模式
引入不依赖可重建 projection 的有界索引读取；完整 rebuild 仍以 RuntimeEvents 为唯一事实源。

## 3. T1 冻结内容

`toolDispatch.managedMutation` 在 T1 前一次性冻结：

- repository/workspace/epoch/instance identity；
- base workspace version、accepted event、head revision、commit/tree；
- 与 durable Write/Edit `args.path` 完全相同的单一 canonical path；
- Gitoxide path policy v3；
- Runtime 固定的 managed transform/profile digest；该 digest 绑定一份 canonical profile spec，结果预算等运行时限制直接读取同一 spec，不能作为孤立标签修改；
- v2 当前唯一支持的 SHA-1 object format。

Storage 在同一个 T1 transaction 内重新比较 function call path 与授权 path，caller 不能自报另一组路径。
完整路径语义由 Gitoxide policy v3 owner 在后续组合层签发；本切片只持久化其版本和 canonical 结果，不复制
另一套 Git path parser。durable mode 在 T1 前确定；如果 admission 不可用，必须在 T1 前拒绝。T1 后缺失
terminal proof、proof 畸形或 owner 异常一律 fail-stop，禁止 generic fallback。

## 4. 原子性边界

### 4.1 T1 与 reservation

单个 `BEGIN IMMEDIATE` transaction 完成：

1. 校验 immutable function call 与 dispatch；
2. 校验 T1 所引用的 workspace base 正是当前 canonical head；
3. 写入 call/dispatch RuntimeEvents；
4. 写入 tool projection；
5. 获取 `workspace_instance_id` 的唯一 reservation。

冲突 transaction 不产生部分 T1，也不会覆盖已有 owner。

### 4.2 terminal successor

单个 SQLite transaction 完成：

1. 验证 success `function_response` 与原 operation identity；
2. 通过注册的一次性 verifier 消费 opaque candidate capability；raw commit/tree/path 描述没有提交权限；
3. 验证 successor 的 parent/base/path/profile 与 T1 完全一致；
4. 写入 outcome RuntimeEvent；
5. 写入 successor workspace fact；
6. 更新 disposable version/head projections；
7. 释放 durable reservation。

任一步失败则整组 rollback。失败 outcome 不得推进 head。旧 operation 的 exact retry 根据 immutable
successor 返回 `committedSuccessor` 历史快照，不把它命名或解释为当前 head，也不要求它仍是当前最新 head。

### 4.3 no-effect terminal

`no_workspace_change` 与 `operation_failed_no_effect` 各自拥有明确的 terminal kind。专用 writer 只消费
mutation owner 签发的 opaque no-effect capability；内部 verifier 将其还原为 operation、dispatch、workspace
instance 与 terminal kind，并与 durable event 逐字段匹配。普通 outcome 或自报 descriptor 无权释放
reservation。验证通过后，writer 才在一个 transaction 中写入 function response + reserved terminal action；
workspace head 保持不变。generic T2 无权写该 action。projection rebuild 根据 immutable terminal 判断
reservation 已结束，不会把它重新激活。

## 5. Runtime 线性状态机

managed operation capability 由 Runtime 持有，生命周期为：

```text
open -> running -> settled -> closed
```

- capability 只能执行一次；terminal settlement 后 retained callback 失效；
- detached operation 必须 join，不能先结算再产生副作用；
- Runtime 只执行工具单独提供的 pure managed transform；普通可变 `tool.impl` 在该路径永远不会调用；
- Runtime 在一次有界 strict-JSON traversal 中复制并冻结结果；默认上限为 1 MiB、64 层、65,536 nodes、
  65,536 properties 和 65,536 array items；caller 只能进一步收紧，不能放宽；
- `undefined`、稀疏数组、非有限数字、原型污染形状和超出 byte budget 的结果在 durable publication 前拒绝；
- live provider result、message、telemetry 与 durable envelope 都读取同一个 snapshot；
- successor success、no-change success、failed-no-effect 与 unsettled 都不能触发 generic `commitOutcome()`。

## 6. 失败状态与回滚

| 失败点 | durable 状态 | 行为 |
| --- | --- | --- |
| T1 transaction 前或内部 | 无 managed T1/reservation | rollback；允许重新 admission |
| T1 commit 后、terminal 前 | prepared + active reservation | fail-stop；禁止另一 mutation 获得 ownership |
| terminal transaction 内 | prepared + active reservation | rollback；不发布 provider result |
| terminal commit 后响应丢失 | immutable outcome + successor + released reservation | exact retry/adoption，不重写 generic T2 |
| no-effect terminal commit 后响应丢失 | immutable outcome + terminal + released reservation | exact retry/adoption；head 不变 |
| projection 缺失 | immutable facts 保留 | 从 RuntimeEvents rebuild |
| projection 与 facts 不一致 | corruption | fail closed，不猜测修复 |

本切片不定义文件副作用恢复；当 T1 已提交但外部 execution/candidate owner无法证明 terminal 时，reservation
保留是有意的 parked 状态，交由后续 recovery owner 处理。

## 7. 平台能力矩阵

本切片只依赖 SQLite transaction、WAL 与进程间数据库锁，不执行平台文件 mutation。

| 能力 | Linux | macOS | Windows |
| --- | --- | --- | --- |
| T1 + reservation 原子提交 | 承诺；Linux storage stress lane | 实现预期；当前 PR 无独立 macOS recovery gate | 承诺；Windows recovery lane |
| 同 workspace instance 多进程唯一 owner | 承诺；真实双进程测试 | 实现预期；发布证据待补 | 承诺；真实双进程测试 |
| terminal successor bundle 原子提交 | 承诺 | 实现预期；发布证据待补 | 承诺 |
| process-crash 后从 facts 重建 | 承诺；真实 child process | 实现预期；发布证据待补 | 承诺；真实 child process |
| power-loss 后硬件级持久顺序 | 继承 SQLite/OS 合同，不额外扩大承诺 | 同左 | 同左 |

这里不把“代码跨平台”冒充“平台恢复证据”。macOS 在加入独立 recovery gate 前不构成发布承诺；普通单元
测试也不能替代真实 child-process kill/reopen 与双进程竞争。

## 8. Production-shaped evidence

当前测试覆盖：

- child process 在 T1 transaction 内退出：整组 rollback；
- child process 在 T1 commit 后退出：reservation 保留；
- 两个真实进程竞争同一 workspace instance：只有一个获得 reservation；
- child process 在 successor transaction 内退出：outcome/successor/head 全部 rollback；
- child process 在 successor commit 后退出：exact retry 返回已接受结果；
- child process 在 no-effect terminal transaction 内/commit 后退出：分别 rollback 或保留 terminal 并释放 reservation；
- plain no-effect outcome 缺少 owner-issued capability 时拒绝，并保留 active reservation；
- 删除 projection 后从 immutable RuntimeEvents 重建 head 与 reservation；
- Runtime owner 的 retained callback、detached operation、mutable result、oversized/non-JSON result 对抗测试；
- managed T1 后所有异常路径的 generic T2 调用次数为零。

## 9. 后续消费者合同

后续 Git candidate/Write/Edit PR 必须：

1. 在 T1 前取得并冻结 Gitoxide policy v3 path admission，并提供独立 pure Write/Edit transform；
2. 只通过本 authority 提交 terminal successor；
3. 对 T1 后的不确定 effect 返回 unsettled，不能自行清理 reservation；
4. 用 production-shaped Host/worker crash test 证明不会重放副作用；
5. 不把本切片的 internal writer 提升为通用 public append API。

## 10. 回滚方式

在尚无 production consumer 时，代码回滚可整体移除 managed dispatch extension、reservation projection 与
Runtime settlement seam；schema migration 保持 append-only，不复用版本号。若已有数据库升级，降级 binary
必须按既有 newer-schema 防护 fail closed，不能尝试写入未知 schema。
