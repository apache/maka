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

# ADR：RuntimeEvent 唯一事实源与 RecoveryResolver 唯一判定权威

- 状态：Accepted，Phase 2.5 开始实施
- 日期：2026-07-17
- 范围：Runtime Resume Phase 2.5–3

## 背景

Phase 2 已经把 provider-visible `function_call`、Tool Journal 和 `tool_operations` 放进同一个 SQLite 事务，但这仍留下两套可能独立演进的恢复事实：RuntimeEvent 表达 provider 历史，Journal 表达是否跨过工具派发边界。如果恢复代码分别读取二者并自行推断，冲突处理、legacy 兼容和后续状态扩展都会产生平行状态机。

本 ADR 决定事实归属、判定权威和投影边界。它不承诺从 Runtime 内部事实推导外部世界的绝对状态；外部副作用在崩溃窗口内仍可能未知。

## 决策

### 1. RuntimeEvent 是唯一 canonical recovery fact source

工具执行边界、工具结果、恢复判断和 reconcile 结果都必须表现为 append-only RuntimeEvent。Tool Journal 与 `tool_operations` 只保留为 SQLite 查询投影：

- Runtime 不得只写 Journal 而不写对应 RuntimeEvent；
- Journal 行必须引用产生它的 RuntimeEvent；
- 新协议数据删除投影后必须能从 RuntimeEvent 重建；
- 投影冲突时以 RuntimeEvent 为准，冲突本身作为 corruption 处理；
- projection 可以与 RuntimeEvent 在同一个 SQLite 事务中同步更新，但这不改变事实归属。

Legacy 数据不伪装成新协议。缺少新协议 marker 或 dispatch fact 的历史按 legacy 规则保守解释，不能利用“事件缺失”证明工具未执行。

### 2. T1 是独立、非模型可见的 dispatch RuntimeEvent

`function_call` 只表达 provider 发起调用。它可以在权限等待期间先提交，不能同时承担 T1 语义。

所有参数校验、availability、loop、权限与 runtime guards 通过后，工具 implementation 之前提交：

```text
actions.toolDispatch = {
  protocol: "t1_after_preflight_v1",
  operationId,
  providerToolCallId,
  toolName,
  canonicalArgsHash,
  recoveryMode
}
```

该事件的准确含义是“Runtime 已进入不可安全假定 implementation 未执行的边界”，而不是“副作用已经发生”。T1 事务原子提交 function call（若尚未存在）、dispatch RuntimeEvent 和查询投影。T1 提交失败必须阻止 implementation。

### 3. Protocol marker 是运行时事实

`toolBoundary: "t1_after_preflight_v1"` 只在 canonical durable commit sink 实际接线时写入，不能根据软件版本无条件写入。JSONL/best-effort 或无 tool commit sink 的 run 不得携带此 marker。

该 capability 由 host 显式注入，再按当前 run 选择的 backend 门控；SQLite store 的存在本身不是充分条件。当前只有确实接入 `RuntimeCommitSink` 的 AiSdk tool path 可以声明该协议，其他 backend 即使共享同一个 SQLite RuntimeEventStore 也不得继承 marker。

marker 只允许位于 run 的首个 canonical RuntimeEvent：

- 普通 run：initial user RuntimeEvent 的 `actions.runtimeProtocol`；
- continuation run：continuation-start RuntimeEvent 的 `actions.runtimeProtocol`。

Resolver 不接受中途补写 marker。marker 缺失即 legacy/unknown protocol。

### 4. RecoveryResolver 是唯一判定权威

Planner、CLI、UI 和未来 reconciler 不得各自组合事实。它们只消费 `RecoveryResolver` 输出的稳定 decision 与 reason code。

核心决策表：

| RuntimeEvent facts | 判定 |
|---|---|
| call + matching response，无 dispatch | completed；表示 T1 前合成结果，legacy 下 response 本身也是完成证据 |
| call + dispatch + matching response | completed |
| call + dispatch，无 response | indeterminate / reconcile_required |
| call，无 dispatch、无 response，首事件声明新协议 | definitely_not_dispatched |
| call，无 dispatch、无 response，legacy/unknown protocol | indeterminate |
| dispatch 存在但对应 call 不存在 | corruption |
| response 存在但对应 call 不存在 | corruption |
| dispatch/response 的 operation、tool call、tool name 或执行身份冲突 | corruption |
| 同一 operation 出现多个不一致 dispatch 或 response | corruption |

Resolver 必须 fail-closed：未知组合不能退化成自动重试。Phase 3 首个恢复写入者应追加 `tool_recovery_decided` RuntimeEvent；后续 reconcile 结果同样追加事件，不回写历史事实。

### 5. Journal 是可重建投影，不是第二份账本

Phase 2.5 保留现有表以降低查询成本，但状态缩窄为当前确有写入路径的 `prepared | outcome_committed`。未来 `indeterminate`、`reconciled`、`parked` 若需要查询状态，先定义对应 RuntimeEvent，再扩展 projector。

新协议的重建验收标准：清空 `tool_journal_events` 与 `tool_operations` 后，从 RuntimeEvent 投影得到相同 operation identity、dispatch/result event refs、recovery mode 与 current state。

### 6. Continuation 保持组装式 replay

不把全部祖先事件复制进 continuation run，避免 O(n²) 存储和重复 canonical facts。continuation-start 的 `actions.stateDelta.replaySources` 保存 canonical manifest：

```text
[{ invocationId, runId, turnId, highWater, prefixDigest }]
```

- `prefixDigest` 对原始不可变前缀做摘要：按 durable 顺序使用 event id 与完整 payload 的规范化序列化；
- 不摘要 provider replay 投影，因为投影逻辑会随版本演进；
- planning 与 execution revalidation 复用同一个祖先遍历器；
- 每个 source 都校验 identity、high-water 与 prefix digest；
- cycle 与 depth overflow 使用稳定 park/revalidation code；
- batch read 属于性能优化，不是 Phase 3 前置条件。

### 7. Phase 0–3 的身份契约

一个 Invocation 对应一个 AgentRun。continuation 创建新的 invocationId、runId 和 turnId。invocationId 隔离 provider/tool execution 与 operationId，runId 标识 durable operational ledger；当前阶段不宣称一个 invocation 包含多个 run。

## 被否决的方案

### Journal 作为唯一事实源

否决。它要求 legacy RuntimeEvent 被硬塞进 Journal 语义，并使 provider replay 与恢复状态分别拥有事实权威。

### RuntimeEvent 与 Journal 都是事实源

否决。事务一致不能消除两套状态机的解释漂移，corruption 时也无法回答谁有最终权威。

### continuation 物化全部祖先事件

否决。它造成链长增长时的 O(n²) 存储、事件身份重复和去重复杂度。

## 实施顺序

1. Phase 2.5：增加 dispatch RuntimeEvent 和运行时 protocol marker；Journal 改为其同步投影。
2. Phase 2.5：实现稳定 revalidation error code，清理无生产调用的旧接口与虚设状态。
3. Phase 3：实现纯 RecoveryResolver 与完整决策表。
4. Phase 3：提交 `tool_recovery_decided`，先支持 park/reconcile_required，不直接自动重跑有副作用工具。
5. Phase 3：加入 replay manifest、全 source digest revalidation 与投影重建工具。

## 验收不变量

- T1 失败时 tool implementation 调用次数为零；
- dispatch 事件存在而 response 缺失时不得自动重试；
- 新协议中 call 缺少 dispatch 可以判定 definitely_not_dispatched；
- legacy 中相同缺口仍为 indeterminate；
- permission deny 等 T1 前合成 response 被判定 completed；
- orphan dispatch、orphan response 和 ref mismatch 被判定 corruption；
- protocol marker 只在 durable boundary 实际激活时出现在首事件；
- 删除新协议 Journal/operation projection 后可以从 RuntimeEvent 等价重建；
- continuation 执行前校验每个 replay source 的原始前缀 digest。
