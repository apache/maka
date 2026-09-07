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

[ENGLISH](./log-is-the-runtime.md)

# Log Is the Runtime：Maka 如何用 Append-Only Log 管理 Agent 状态与上下文

## 从 Log Is the Database 谈起

构建长时间运行的 Coding Agent 时，最棘手的问题往往出在运行时的可靠性上。如果宿主进程意外崩溃，正在执行的任务该如何精准恢复？如果某个工具在修改文件或发起网络请求途中挂了，下次启动还能不能安全重试？如果自动化测试一次性吐出数十万 token 的日志，怎么避免后续推理的上下文直接被打爆？

分布式数据库很早就遇到过类似的问题。在数据库领域，**Log Is the Database** 是一个经过充分验证的原则：数据库在任意时刻的状态，本质上都是某份基线状态与其后提交日志的应用结果。

```text
State(n) = Apply(State(0), Log[1...n])
```

其中 `Log[1...n]` 代表截止到位置 `n` 已提交的日志序列，`Apply` 是状态转移函数。只要初始状态一致，并且按相同顺序应用这串日志，所有节点就能得到完全一致的数据库状态。

生产环境不会每次都从第一条日志开始回放。数据库会定期打 Snapshot 固化全量状态，恢复时先加载 Snapshot，再回放后面的日志增量：

```text
State(n) = Apply(Snapshot(k), Log[k+1...n])
```

在这个模型里，节点本地的数据表更像是一份物化缓存，可能滞后，可能损坏，也能直接清空重建。只要 Snapshot 和后续提交的日志还在，系统状态就能完整还原。

这也决定了数据的写入路径：一次变更不会先写磁盘数据页再顺手记条日志，而是先追加到日志中。等日志复制并提交后，状态机才把它应用到业务数据里：

```text
Client Command
    ↓
Append Log
    ↓
Replicate Log
    ↓
Commit Log
    ↓
Apply to State Machine
    ↓
Update Tables / Indexes / Materialized State
```

系统中的权威数据源始终是已提交的日志前缀，表、索引和缓存都是基于日志计算出的物化结果。

这和传统单机数据库的 WAL（Write-Ahead Logging）定位不同。在传统数据库里，数据页是主状态，WAL 主要是事务原子性和持久性的恢复工具，数据页刷盘并完成 checkpoint 之后旧日志就能回收。但在 Log-centric 数据库里，日志本身就是权威历史，表状态只是日志计算出的投影。

```text
Traditional WAL:
    Data State → Primary
    Log        → Recovery Record

Log-centric Database:
    Committed Log → Authoritative History
    Data State    → Materialized Result
```

副本间的一致性由此拆解为两个确定性的环节：共识协议保证所有副本拿到同一份有序日志，状态机保证相同的日志输入必定产生相同的应用状态。

## Log Is the Runtime

把这个设计思路放到 Agent 系统中，逻辑也是相通的。

大语言模型本身是无状态的，不会在多次交互中驻留可供 Runtime 随时读取的内部状态。每一次调用模型，Runtime 都必须向其组装上下文：用户的要求、之前做过的操作、调用了什么工具、工具返回了什么，以及当前进行到了哪一步。

Agent 的状态并不依附于某个一直在跑的后台进程，而是 Runtime 根据历史事实，在每次发起推理前动态构建出的投影：

```text
Agent State(t) = Project(RuntimeEvents[0...t], policy, runtime configuration)
```

这就是 Maka 采用 **Log Is the Runtime** 的原因：`RuntimeEvent Log` 是 Agent 交互的事实空间，Agent 在某个时刻的状态则是这份日志在特定策略下的确定性视图。

完整的执行日志远比普通的聊天记录复杂，它包含任务生命周期的完整步骤：

```text
1. User: 修复这个项目里失败的测试
2. Model: 调用 Grep 搜索相关代码
3. Tool: 返回搜索结果
4. Model: 调用 Read 读取文件
5. Tool: 返回文件内容
6. Model: 调用 Edit 修改文件
7. Runtime: 请求扩大 sandbox permission
8. User: 批准
9. Tool: 返回修改结果
10. Model: 调用 Bash 重新运行测试
11. Tool: 返回测试结果
12. Model: 输出最终结论
13. Runtime: 将这次 Run 标记为 completed
```

如果只保存第 1 条和第 12 条，留下的只是一份聊天文本，丢失了执行状态。真正决定 Agent 下一步动作的，还包括工具调用的具体参数和返回值、调用与响应的对应关系、权限审批结论，以及每一步发生的先后顺序。

因此，Maka 没有采用简单的 `role + text` 结构，而是定义了结构化的 `RuntimeEvent`：

```ts
type RuntimeEventContent =
  | Text
  | Thinking
  | FunctionCall
  | FunctionResponse
  | Error
```

事件还可以携带影响 Runtime 控制流的动作：

```ts
type RuntimeEventActions = {
  stateDelta?: StateDelta
  permissionRequest?: PermissionRequest
  permissionDecision?: PermissionDecision
  tokenUsage?: TokenUsage
  toolDispatch?: ToolDispatch
  toolRecovery?: ToolRecovery
  endInvocation?: boolean
}
```

每条事件都打上了 `sessionId`、`turnId`、`runId` 和 `invocationId` 的坐标，持久化到 SQLite 的 `runtime_events` 表中，并在一次 Invocation 内获得单调递增的 `event_seq`。Maka 读取历史时，基于 `event_seq` 获取一个不可变前缀：

```text
RuntimeEvents[1...highWater]
```

通过引入 `highWater` 边界与前缀摘要（Digest），恢复逻辑把后续执行绑定在经过校验的历史切片上，无需依赖可能发生变化的模糊状态。

同一份 `RuntimeEvent Log` 会针对不同消费场景生成不同的投影：

```text
                         ┌→ Session / UI
                         │
Runtime Event Log ───────┼→ Next Model Context
                         │
                         ├→ Run Terminal State
                         │
                         └→ Crash Recovery / Continuation
```

- `projectRuntimeEventsToStoredMessages()`：投影为前端展示所需的会话消息、工具状态与轮次信息。
- `buildRuntimeEventModelReplayPlan()`：组装下一次模型调用所需的有效上下文，跳过内部控制事件（如 `modelVisibility: hidden`）和流式临时分块，配对函数调用并保留原生思考语义。
- `classifyRuntimeEventTerminalFact()`：判定单次 Run 的终态（completed、failed 或 aborted）。
- `buildContinuationReplayPlan()`：在进程退出后，判定哪些已确认的历史可以安全移交后续 Run 继续执行。

在工具调用的恢复上，Maka 将工具执行拆分为落盘派发（Dispatch）和落盘结果（Outcome）两个边界。如果崩溃发生在两者之间，系统将该状态标记为待核对，在无法证明幂等和安全性时阻止自动重试，避免静默重试引发重复写文件等副作用。

只要 Committed Runtime Event Log 存在，进程即便崩溃，UI 即便重载，模型上下文即便重构，Agent 曾经观察到的事实、发起的调用、返回的结果与结束的边界，都能从日志中确定性地恢复出来。

## Compaction：作为物化视图的压缩投影

日志追加写机制面临一个实际限制：事件序列单调递增，但模型的上下文窗口大小是固定的。

如果把模型上下文等同于执行历史，最直接的做法是截断早期记录，用模型生成的摘要就地覆盖。这样做会永久破坏底层历史，丢失排查线索，后续换用更大上下文的模型时也无法再利用当年的完整信息。

Maka 将事实层面的历史（History）与推理层面的上下文（Context）区分开来：`RuntimeEvent Log` 保持 Append-Only 不可变，Compaction 只改变下一次模型推理读取历史的方式。

较长的历史会被投影为“早期事件的摘要加近期事件的原文字节”。老旧的中间交互不再占用后续推理的 Token，但它们依然完整留在底层日志中。

Compaction Checkpoint 相当于数据库里的物化视图，是一份为了加速读取而生成的持久化快照。Checkpoint 遗失时可以通过原始日志重新计算，若两者产生分歧，始终以权威的原始日志为准。

因此，可靠的 Checkpoint 必须明确记录其覆盖的连续事件区间、终止水位线以及源日志摘要。Compaction 不会在历史中挑拣删除，而是在时间线上画出清晰的水位：水位线之前由 Checkpoint 承载，水位线之后保持原始事件。后续新产生的事件继续在尾部追加，下一次压缩也只需增量折叠旧 Checkpoint 与新生成的增量后缀。

摘要本身具有信息损耗，会直接影响模型对后续动作的判断。Maka 要求投影结果必须先完成校验与落盘，才能交给模型使用。如果在内存中生成摘要后直接发给模型再异步持久化，一旦发生崩溃，系统就无法复原模型当时到底看到了哪一份上下文。

保留追加写前缀还能提高 LLM Provider 的 KV-Cache 前缀命中率。只要 System Prompt、工具定义与序列化格式保持稳定，多次调用通常只需在尾部追加增量内容，复用已有的计算缓存。Compaction 虽然会重置一次旧前缀，但也建立了一个紧凑的全新基线，后续交互可以继续基于新基线积累 Cache。

## Tool Result Prune：有边界的上下文卸载

即使在交互轮次不多的场景下，单次工具调用也可能占满上下文。读取大型源码文件、全仓符号检索、拉取测试日志或等待子 Agent 汇聚结果，单次输出可能达到数万甚至数十万 Token。模型在当前步骤需要分析这些细节，但在后续的多轮交互中如果一直带着这些大体积数据，不仅增加开销，还会干扰模型的注意力。

Tool Result Prune 的目的，是避免大体积对象持续滞留在模型的工作内存中。

Maka 借鉴了操作系统的按需分页（Demand Paging）思想：在把完整的 Tool Result 写入持久化存储后，模型上下文中的原始负载会被替换为轻量级的占位符（Placeholder）。占位符记录了调用工具名、原始字节大小、内容哈希以及访问凭证。模型获知完整结果已经归档，并在需要细节时通过特定方式发起检索。

在目前的实现中，归档的大对象由通用的 `ArtifactStore` 统一承载。为了提供更专门的上下文卸载生命周期管理，系统后续计划迁移至独立的 SQLite `ContextOffloadStore`（见 Issue #4071）。

卸载与读取路径遵循严格的有边界读取（Bounded Read）控制，将查看目录结构（Inspect）、按项查询（Query）与分页读取（Paginated Read）分开。模型可以先探查元数据，仅在必要时拉取局部分片，避免一次读取又把数十万 Token 全部倒灌回活跃上下文。

在时序上，Maka 遵循“先归档落盘、后生成占位符”。只有在完整负载确认写入存储，并且哈希与字节校验一致后，Runtime 才会将上下文中的原文替换为占位符。若归档失败，系统宁可保留完整内容多占一些 Token，也不生成可能失效的悬空引用。

卸载机制主要应用在两个阶段：
1. **单轮执行内（Active Turn）**：工具刚产生超大结果时，在进入下一步推理前将其移出活跃上下文，让模型按需读取。
2. **历史重放时（History Replay）**：近期工具调用保留完整上下文，早期的大型工具结果在重构上下文时替换为占位符，形成热数据常驻、冷数据下沉的分层设计。

这两类裁剪仅作用于对模型可见的 Projection。原始的 `RuntimeEvent Log` 中永远保留完整的工具输出，后续的 History Compaction 在生成语义摘要时看到的也是真实事件，而不是占位符。

History Compaction 沿时间轴压缩历史，将长事件序列折叠为低分辨率的语义摘要；Tool Result Prune 沿空间轴卸载负载，保持事件结构的同时将大对象转移到持久存储中。两者以不可变的 Append-Only Log 为基准，在减少 Token 占用的同时，保证了执行历史的精确与可复原。

## 结语：保留事实，延迟决定如何读取

Maka 的这些设计最终指向同一个原则：先把发生过的事情可靠地记录下来，再根据不同场景决定如何读取它们。

UI、模型上下文、崩溃恢复和任务续跑读取的是同一份 `RuntimeEvent Log`，但各自使用不同的 Projection。Compaction 改变历史的表达粒度，Tool Result Prune 改变大对象进入上下文的方式，它们都不需要改写已经发生的事实。

Append-Only 并没有消除系统复杂度，而是把复杂度从维护一份不断被覆盖的当前状态，转移到了如何从稳定历史构造合适的视图。这样做的代价是日志会持续增长，Projection 需要版本和校验，归档数据也必须管理生命周期。但它换来的是更清晰的恢复边界、更完整的审计能力，以及在模型和上下文策略变化后重新解释历史的可能性。

对于 Agent Runtime 来说，状态管理的目标并不是把全部历史永远塞进模型，而是保留一份完整、可验证的事实记录，并在每次推理前构造一份有界且有用的上下文。

模型决定下一步做什么，Log 则保证 Runtime 始终能够回答：此前究竟发生过什么。这就是 **Log Is the Runtime**。
