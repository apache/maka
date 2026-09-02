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

# Log Is the Runtime：Maka 如何用 Append-Only Log 管理 Agent 状态与上下文

## Log Is the Database

所谓 **Log Is the Database**，不是一句比喻，而是一种真实存在于分布式数据库中的数据理念：数据库在任意时刻的状态，都可以由一份历史状态和其后提交的日志重新计算出来。

写成公式就是：

```text
State(n) = Apply(State(0), Log[1...n])
```

`Log[1...n]` 是截至位置 `n` 已经提交的日志，`Apply` 是数据库的状态转换过程。只要初始状态相同，并且按照相同顺序执行相同的日志，节点就应该得到相同的数据库状态。

实际系统当然不会在每次启动时从第一条日志开始回放。随着日志增长，数据库会定期生成 snapshot，把某个日志位置上的完整状态保存下来。恢复时先加载 snapshot，再回放它之后的日志：

```text
State(n) = Apply(Snapshot(k), Log[k+1...n])
```

因此，一个节点的本地数据库并不是不可替代的原件。它更像是一份计算结果：可以落后，可以损坏，也可以被整个删除。只要 snapshot 和后续 committed log 还在，这个节点的状态就能够被重新构造出来。

这也决定了写入发生的顺序。一次写入不是先修改数据库，再顺手留下一条日志。它首先成为日志中的一条记录，在被复制并提交之后，才由状态机应用到数据库状态中：

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

这里真正具有权威性的不是某个节点此刻持有的数据页，而是已经提交的日志前缀。表、索引、缓存以及本地存储文件，都是这段日志执行后的物化结果。

这正是它与传统 WAL 观念最重要的区别。

在传统数据库中，WAL 首先是一种恢复机制。数据库通过日志保证本地事务的原子性和持久性；一旦修改已经安全写入数据页并完成 checkpoint，较早的日志就可以被回收。在这个模型里，数据页是主要状态，日志服务于数据页的恢复。

而在 log-centric database 中，关系反了过来：

```text
Traditional WAL:
    Data State → Primary
    Log        → Recovery Record

Log-centric Database:
    Committed Log → Authoritative History
    Data State    → Materialized Result
```

这并不意味着系统必须永久保留从创世开始的每一条日志。Snapshot、checkpoint 和 log compaction 仍然是必要的工程手段。关键在于：数据库用什么来定义状态的演进，又用什么来判断两个副本是否拥有同一个数据库。

对于一个以 log 为核心的系统，答案不是比较两份本地文件是否相同，而是检查两个节点是否拥有相同的 committed log，以及它们是否把这段日志应用到了相同的位置。

换句话说，数据库的一致性被拆成了两个更具体的问题：

```text
所有副本是否同意同一段日志？
相同的日志是否会产生相同的状态？
```

前一个问题由复制和共识协议解决，后一个问题由确定性的状态机解决。

这就是 **Log Is the Database** 最直接的含义：log 不是数据库运行之后留下的记录；log 是数据库状态的输入，而我们查询到的数据库，只是这段输入在某个位置上的计算结果。

## Log Is the Runtime

把这个思路放到 Agent 上，会得到一个很相似的结论。

LLM 本身没有一份会随着任务持续推进的、可供 Runtime 读取的持久状态。每次调用模型，Runtime 都要重新告诉它：用户说过什么、模型此前做过什么、调用过哪些工具、工具返回了什么，以及任务目前进行到了哪里。

换句话说，Agent 所谓的“状态”，并不藏在某个一直运行的模型进程里。它是 Runtime 根据历史事实，在每次模型调用之前重新构造出来的。

```text
Agent State(t) = Project(RuntimeEvents[0...t], policy, runtime configuration)
```

这就是 Maka 对 **Log Is the Database** 的进一步使用：Runtime Event Log 是 Agent 交互的事实空间；Agent 在某个时刻的状态，是这段日志在特定策略下的投影。

这里的 log 显然不能只记录聊天文本。一次真正的 Agent 执行可能是这样的：

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

如果只保存第 1 条和第 12 条，我们保存的是一段聊天记录，不是 Agent 的执行状态。真正决定 Agent 下一步行为的，还包括工具调用的参数和结果、调用之间的对应关系、权限是否获得、执行是否已经结束，以及这些事实之间的顺序。

这也是 Maka 没有用一个简单的 `role + text` 结构表示历史的原因。在代码中，`RuntimeEvent` 的内容包括：

```ts
type RuntimeEventContent =
  | Text
  | Thinking
  | FunctionCall
  | FunctionResponse
  | Error
```

事件还可以携带影响 Runtime 控制状态的 actions，例如：

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

每条事件同时带有 `sessionId`、`turnId`、`runId` 和 `invocationId`。这些 ID 分别回答：这段长期交互是谁、这是用户看到的哪一轮、这是哪一次具体执行尝试，以及这组模型和工具活动属于哪次 invocation。

事件写入 SQLite 的 `runtime_events` 表，并在一次 invocation 内获得单调递增的 `event_seq`。Maka 读取一段执行历史时，不是读取“当前消息列表”，而是按 `event_seq` 读取一个 immutable prefix：

```text
RuntimeEvents[1...highWater]
```

这里的 `highWater` 很重要。它把“我恢复了这次执行”变成了一个可验证的陈述：恢复逻辑必须明确自己读到了哪一条事件，而不是从一个仍可能变化的“最新状态”继续运行。Maka 还会对这个 immutable prefix 计算 digest，使 continuation 绑定到一段确定的历史，而不是绑定到一个模糊的 Session。

同一段 Runtime Event Log 会产生多种不同的状态。

`projectRuntimeEventsToStoredMessages()` 将它投影成用户在 UI 中看到的消息、工具活动和 Turn 状态；`buildRuntimeEventModelReplayPlan()` 将它投影成下一次 provider 调用能够接受的模型历史；`classifyRuntimeEventTerminalFact()` 判断一次 Run 最终是 completed、failed 还是 aborted；`buildContinuationReplayPlan()` 则在进程崩溃之后判断哪一段历史可以安全地交给一个新的 Run 继续执行。

```text
                         ┌→ Session / UI
                         │
Runtime Event Log ───────┼→ Next Model Context
                         │
                         ├→ Run Terminal State
                         │
                         └→ Crash Recovery / Continuation
```

这些 projection 可以有不同的选择规则，但不能各自发明事实。

例如，模型不需要看到所有 Runtime 控制事件。`buildRuntimeEventModelReplayPlan()` 会跳过 `modelVisibility: hidden` 的事件，不会把 terminal fact 当作一条对话消息，也不会把流式传输中的临时 chunk 放回模型上下文。它还要重新配对 function call 和 function response，并在 provider 支持时保留 signed thinking 等原生语义。

UI 的选择又不同。它需要展示文本、thinking、工具活动、权限状态和错误，但不应该把内部的 tool-dispatch recovery fact 渲染成一条聊天消息。

因此，模型上下文不是历史本身，UI transcript 也不是历史本身。它们都是对同一份 Runtime Event Log 的读取方式。

这个区分对长时间运行的 Agent 尤其重要。模型的 context window 是有限的，Agent 的执行历史却可以不断增长。如何同时保留完整历史，又让下一次推理只读取一个有限上下文，是 Maka 必须单独解决的问题。

这里还必须给“回放”划一条边界。

回放 Runtime Event Log，不等于重新执行所有工具，也不等于复现模型当时每一个隐藏层的神经元状态。Maka 当前保证的是 semantic replay：在一个确定的事件边界上，重新得到用户和模型已经交换的内容、工具调用及其结果、权限与终止状态，并据此构造 UI、模型上下文和恢复判断。

对于已经越过副作用边界、却没有留下结果的工具调用，Maka 不会因为“回放到了一个 function call”就盲目重试。代码把工具执行拆成 dispatch 和 outcome 两个 durable boundary；如果崩溃发生在两者之间，恢复器必须把它识别为未知或待核对状态。无法证明安全时，continuation 会被阻止，而不是猜测工具没有执行。

所以 **Log Is the Runtime** 并不是说 log 可以复刻整个物理世界。它表达的是一个更严格、也更有用的保证：

> 进程可以消失，UI 可以重建，模型上下文可以重新选择，甚至下一次执行可以由新的 Run 接管；但 Agent 已经观察过什么、做出过什么调用、得到过什么结果，以及执行在哪个边界结束，必须能够从 committed Runtime Event Log 中重新得到。

对于数据库，log 回放的是数据状态；对于 Maka，log 回放的是 Agent 可以继续行动的状态空间。

## Compaction Is Only a Projection

Append-only 很自然地带来一个矛盾：历史只会增长，但模型的 context window 不会增长。

如果把 context 当成 history，这个问题几乎只有一种解法：删掉早期消息，用一段摘要覆盖它们。上下文是变短了，但历史也被永久改写了。以后无论是恢复、审计、调试，还是换一个更大的模型重新理解任务，能够读到的都只剩那段有损摘要。

Maka 选择把两件事分开：Runtime Event Log 继续 append-only；compaction 只决定下一次 inference 如何读取它。

一段很长的历史，可以被投影成“早期事件的 summary，加上最近事件的原文”。旧的模型回复和 Tool Result 不再占用下一次推理的 token，但它们仍然留在原始日志中。被压缩的是 context，不是 history。

> Context is not history.

从这个角度看，compaction checkpoint 很像数据库里的 materialized view。它可以被持久化，也可以成为绝大多数读取的快速入口，但它仍然只是某段原始数据的计算结果。判断谁是事实源的方法很简单：checkpoint 丢了，可以从 log 重新生成；如果 checkpoint 与 log 对不上，应该丢弃 checkpoint，退回原始历史，而不是反过来修改 log 迁就 checkpoint。

这也是为什么一个可靠的 checkpoint 不能只保存一段 summary。它还必须说明自己覆盖了哪一段连续历史、停在哪个事件边界，以及这段 source 是否仍然和生成 summary 时完全相同。只有这样，Runtime 才能确定自己做的是“用 projection 替换一个已知前缀”，而不是把一段来历不明的摘要塞进模型上下文。

这里的“连续前缀”尤其重要。Compaction 不是从历史各处挑选一些看起来不重要的内容删除，而是在一条有序日志上画出一条明确的水位线：水位线之前由 checkpoint 表示，之后仍然保留原始事件。这样，新的事件可以继续追加在尾部；下一次 compaction 也只需要把旧 checkpoint 和新增长的那段历史向前折叠，而不必重新解释整个 Session。

当然，“compaction 只是 projection”并不意味着它对 Agent 的行为没有影响。

数据库中的索引通常不应该改变查询结果，但 Agent 的 summary 天生是有损的。模型读完整历史和读 compacted context，下一步可能做出不同判断。Compaction 没有改变已经发生的过去，却改变了模型生成未来事件时所能看到的状态。

所以这里的“只是”说的是它的 authority，而不是它的重要性：checkpoint 没有资格改写历史，但它会参与决定历史接下来怎样增长。正因如此，一份新的 projection 应该先被验证、再被持久化，最后才交给模型使用。只在内存里临时生成 summary、发送给模型之后才尝试保存，会产生一个无法恢复的分叉：进程重启后，Runtime 知道模型输出了什么，却不知道模型当时究竟看到了哪一版历史。

Append-only 还带来另一个很实际的收益：更高的 KV cache 前缀命中率。一次 Agent 任务会连续调用模型很多次；只要 system prompt、tool definitions 和序列化方式保持稳定，下一次请求通常只是在上一轮历史后追加新的 model、Tool Call 和 Tool Result。此前已经计算过的长 token prefix 可以继续被 provider 复用。

Compaction 会主动打断一次旧前缀，但它同时建立了一个更短的新前缀锚点。只要这个 checkpoint 保持稳定，后续事件又会继续 append 在它后面，新的 KV cache 前缀便可以持续复用。因此，compaction 不是反复重写上下文，而是偶尔为一条不断增长的日志建立新的读取起点。

这就是 Maka 在 append-only 与有限 context 之间做出的选择：历史永远向前追加；compaction 不负责删除历史，只负责决定模型从哪里、以什么分辨率继续阅读历史。

## Tool Result Prune Is Context Offload

即使不考虑很长的历史，一次 Tool Call 也可能瞬间塞满模型的 context window。

读取一个大文件、搜索整个代码库、运行测试、抓取网页，或者等待一组子 Agent 返回，都可能产生几万甚至几十万 token 的 Tool Result。模型在拿到结果的那个 step 里也许确实需要这些细节，但在后续每一次推理中重复携带完整结果，通常既昂贵，也没有必要。

Tool Result Prune 解决的不是“这段历史还要不要”，而是“这份大对象是否必须一直驻留在模型的工作内存里”。

Maka 的选择是先把完整 Tool Result 写入独立的 context-offload storage，再把下一次模型请求中的原文替换成一个很小的 placeholder。Placeholder 保留结果来自哪个工具、原始大小、内容摘要和可回读地址。模型知道这里曾经有一份完整结果，也知道在需要细节时应该怎样取回它。

这里的“外部”是相对于模型 context 而言，并不意味着必须上传到远端。Maka 仍然遵循 local-first：offload storage 只是位于有限的 context window 之外，由 Runtime 管理的一层本地持久存储。

所以 prune 更像操作系统的 swap 或 demand paging，而不像删除：context window 是昂贵的工作内存，offload store 是容量更大的后备存储，placeholder 是留在工作集里的页表项。区别是这里的 page-in 不是透明发生的，而是由模型显式决定。模型可以先查看 archive 的结构和元信息，再按 item 查询，或者分页读取其中一段，而不必一次把整个大对象重新搬回 context。

这条读取路径必须是 bounded 的。否则，一个十万 token 的结果刚被 prune，模型调用一次回读工具又把十万 token 全部塞了回来，context 管理就只完成了一次无意义的往返。Maka 因此把 inspect、query 和分页 read 分开：先让模型知道 archive 里有什么，再只取当前推理真正需要的部分。

这里最重要的顺序是：先 archive，再 placeholder。

一个只保存“结果已被省略”的占位符没有任何恢复价值。只有当完整内容已经成功写入外部存储，并且引用、内容 hash、字节数和 Session 身份都能够对应起来时，Runtime 才能从模型上下文中移走原文。如果 archive 写入失败，正确的行为是继续保留完整 Tool Result，而不是为了节省 token 制造一个无法回读的空指针。

同样，回读也不能只相信模型传回来的地址。Archive 属于产生它的 Session，内容必须与 placeholder 中记录的 hash 和大小一致。这个约束让 placeholder 成为对一份确定内容的 capability，而不是一个可以随意读取本地数据的文件路径。

Maka 会在两个时间尺度上做这种 offload。

一种发生在当前 Turn 内：工具刚产生一个很大的 Tool Result，在进入下一 step 之前，Runtime 就可以把它从 active context 中卸载。模型在下一次推理中先看到引用，再按任务需要决定查看结构、读取局部，还是完全不加载原文。

另一种发生在历史 replay 时：最近的 Tool Result 保持完整，较早且过大的结果在重新构造模型上下文时变成 placeholder。这样，Session 可以保留一段相对完整的近期工作集，而把很少再次访问的旧结果放到更便宜的存储层。

这两种 prune 都只作用于 provider-visible projection。Canonical Runtime Event Log 中的原始 Tool Result 仍然存在，后续 history compaction 看到的 source 也仍然是原始事件，而不是 placeholder。否则，summary 就会总结出“这里曾经有一段被省略的内容”，而不是总结 Agent 当时真正观察到的结果。

因此，Tool Result Prune 和 History Compaction 虽然都在减少 context，却解决了两个不同的问题。

History Compaction 把一段连续历史折叠成更低分辨率的语义摘要；Tool Result Prune 则保留事件结构，只把其中过大的 payload 移出热工作集。前者改变模型阅读历史的分辨率，后者改变一份大对象所在的存储层级。

两者共同建立了一种分层的 Agent memory：最新、最相关的事实直接留在 context 中；体积很大但仍可能有用的 Tool Result 通过引用按需读取；更早的历史由 checkpoint 提供连续性的摘要；而完整的执行事实始终保留在 append-only log 中。

这也是 Maka 上下文管理最核心的边界：context 可以被压缩，可以被分页，也可以被重新投影；但为了节省 token，不应该假装一件已经发生过的事从未发生。
