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

[English](./ARCHITECTURE.md)

# Maka 后端架构

每个 State Root 的执行与写入 authority 归属于其 Runtime Host。Desktop、TUI、CLI、bot 和 Eval client 都经过 Host 边界执行工作，不为同一份状态创建第二套 Runtime。多个 Host 可以分别拥有不同的 State Root；Peer Mesh 提供端点间的成员关系与连接，不合并这些执行 authority。

```mermaid
flowchart LR
    C["Desktop / TUI / CLI / Bot"] --> H["Runtime Host"]
    H --> S["SessionManager"]
    S --> R["AgentRun + RuntimeKernel"]
    R --> T["Tool Runtime"]
    R --> L["Runtime Event Log"]
    S --> G["Agent Graph Control Plane"]
    G --> R
    L --> P["Context / Session / UI / Recovery projections"]

    E["@maka/eval\nExperiment → Cells → Attempts → Results"] --> H
    X["External subjects"] --> E
```

Runtime Host 拥有 Session 和 Turn identity、agent lifecycle、continuation、tools、permissions 与 events。`@maka/eval` 只拥有 benchmark 实验语义：subjects、tasks、repetitions、cells、immutable attempts、result selection、budget 和 verifier 配置。Maka subject 必须经过公开的 Runtime Host client/protocol 边界；外部竞品是 generic external subject。

## Runtime 分层

1. Runtime Event Log 是模型消息、Tool Call、Tool Result 和终止事实的 canonical source。上下文裁剪与 compaction 只改变 provider input projection，不改写历史。
2. SessionManager 和 AgentRun 拥有执行生命周期。Runtime Host 拥有 admission、client capability、interaction 与公开协议。
3. Agent Graph 通过 child Session 调度依赖工作，并把每次 activation 送回同一 Runtime。
4. Storage 只拥有交互 Runtime 状态，不再有 Eval 专用 root、TaskRun ledger 或实验结果 authority。

## 工具资源准入

工具执行分为三个彼此独立的层次。`ToolScheduler` 只在单个 provider batch
内按冲突 claim 排序；进程级 shared/exclusive coordinator 提供跨 batch
correctness：`all()` 获取 exclusive，所有参与建模的非空资源 authority 获取
shared；随后领域 owner 再获取自己的 lease（例如 filesystem exact/tree
读写 lease），并在真实 effect 前重新校验 identity。

Filesystem owner 先原子获取整组 canonical path lease，再获取整组已观察到的
`(dev, ino)` object lease。因此，即使由不同 owner 执行，经硬链接访问同一文件的
exact read/write 也会互斥。等待 object admission 后再次校验 identity；目标发生
变化则拒绝执行。Tree search 按路径协调，不保证针对搜索树外硬链接或未参与
这些 authority 的 writer 提供快照。不能固定文件句柄的外部 workspace 仍保留
较弱的基于路径的执行契约。

`AskUserQuestion` 和 `request_sandbox_boundary` 使用已有 Session interaction
权限边界，等待用户回答期间不持有进程 barrier。Batch 发生致命拒绝后停止派发，
队列槽位保留原始错误，避免按 provider 顺序结算时掩盖真正原因。

固定获取顺序是 process admission，再 domain leases。显式 `none()` 同时绕过
batch 冲突图和 process barrier；`all()` 并不表示“阻塞进程中的一切异步操作”。

## Eval 边界

```text
Experiment = benchmark + executor + subjects + tasks + repetitions
Cell       = task × repetition × subject

repetition   = 新的实验样本
infra retry  = 同一个 cell 的替换 attempt
continuation = Maka subject 内部的 Runtime Host 行为
```

一个 Experiment 使用一份完全展开的声明式 spec。所有 arms 共享 executor、benchmark、tasks、budget 和 verifier。A/B 只是双臂 Experiment。Harbor 和 Pier 是 executor adapter，不是独立 workflow。

通用结果只包含 score、normalized usage、可归因 cost、duration、status 或 failure reason 以及 artifacts。一个 cell 有多个 attempts 时，以最早有效 attempt 为权威，operator 不能人工挑选结果。

## 代码边界

| 区域 | 职责 |
|---|---|
| `packages/core` | Session、Runtime Event、AgentRun、permission 和协议等纯 contract |
| `packages/storage` | 交互 Runtime store 与 SQLite control plane |
| `packages/runtime` | SessionManager、AgentRun、模型 adapter、tools、context、recovery 与 Graph reconciliation |
| `packages/runtime-host` | 唯一 hosted execution authority 与公开 client/protocol |
| `packages/eval` | Experiment cell、attempt、result selection 与 subject/executor adapter |
| `packages/cli` | TUI、`maka run` 与唯一公开 `maka eval` 路由 |
| `apps/desktop/src/main` | Electron composition 与产品入口 adapter |

## 阅读路径

- Host 权责、准入、观察、Client 隔离与生命周期：[Runtime Host 架构](./docs/architecture/runtime-host-architecture.zh-CN.md)。
- Desktop 对话投影：主对话、Side Chat、WorkHub 以 Host 执行事实为准：[以 Host 投影为唯一执行依据](./docs/architecture/desktop-conversation-host-projection.zh-CN.md)。
- 网络身份、成员关系、路径选择与 stream 恢复：[Peer Mesh 架构](./docs/architecture/peer-mesh-architecture.zh-CN.md)。
- Runtime 事实与 projection：[Runtime core](./docs/architecture/runtime-core-architecture-draft.zh-CN.md) 与 [compaction](./docs/architecture/llm-compaction-events-log-projection-draft.zh-CN.md)。
- Crash recovery 与 continuation：[Runtime resume](./docs/architecture/runtime-resume-architecture.zh-CN.md)。
- Multi-agent scheduling：[Agent Graph](./docs/architecture/agent-graph-stream-scheduling-draft.zh-CN.md)。
- Eval 行为与公开 seam：[`packages/eval`](./packages/eval)。

历史设计保存在 [`docs/archive`](./docs/archive/README.md)。当前 GitHub Issue 与源码优先于旧 draft。
