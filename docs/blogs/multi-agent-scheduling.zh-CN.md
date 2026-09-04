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

[ENGLISH](./multi-agent-scheduling.md)

# 从 Copy-on-Write 到 Mailbox：Multi-Agent 调度的两条路径

当一个 Agent 开始创建 subagent，最直觉的解释是“多开几个模型，并行完成任务”。但真正困难的问题并不在并行，而在调度：subagent 继承什么上下文，任务由谁拆解，依赖如何表达，结果怎样交付，失败以后如何恢复，以及执行中的 Agent 是否应该彼此交流。

这些问题最终把 multi-agent 系统带向了两条不同的路线。

一条路线把 subagent 当作 operator：主 Agent 编写 workflow，调度器根据显式依赖推进执行，结果沿有向边流向下游。另一条路线把 subagent 当作 participant：每个 Agent 都有身份和 mailbox，通过互发消息协调工作，实际流程在 conversation 中逐步展开。

Maka 选择了第一条路线，Codex 的新一代 subagent 协作则明显属于第二条。要理解这两种设计，我们先从操作系统如何廉价地创建执行分支说起。

## Copy-on-Write：先共享，写入时再分叉

严格来说，Copy-on-Write 不是一种 thread 模型。Linux thread 通常共享同一份虚拟地址空间；经典的 Copy-on-Write 出现在 `fork()` 创建进程时。

如果 `fork()` 立即复制父进程的全部物理内存，创建一个 child 的成本就会随父进程内存线性增长。更糟的是，child 往往很快调用 `exec()`，刚复制的大部分页面根本不会被读取。

Linux 因此先复制逻辑视图，而不是所有物理数据。`fork()` 之后，父子进程拥有彼此独立的虚拟地址空间，但页表最初可以指向相同的物理页面，并把这些映射标记为只读：

```text
Parent virtual pages ─┐
                      ├──> shared physical pages
Child virtual pages ──┘
```

只要双方都在读取，这些页面就可以继续共享。某一方第一次写入时，CPU 触发 page fault，内核复制对应页面，并让写入方改写自己的副本：

```text
Before write

Parent ─┐
        ├──> Page A
Child ──┘

After child writes

Parent ─────> Page A
Child  ─────> Page A'
```

Copy-on-Write 的关键并不是“复制更快”，而是把复制推迟到分歧真正发生的地方。创建分支只需要建立新的身份和共享关系，成本与实际修改量相关，而不是与完整状态大小相关。

这个思想很自然地被带进 Agent 系统。一个 subagent 可以从主 Agent 的历史前缀 fork，开始时共享已有 context，之后只记录自己的增量事件：

```text
Shared conversation prefix
             │
        ┌────┴────┐
        ▼         ▼
    Main delta  Child delta
```

但上下文不是普通内存页面。父 Agent 的历史里混杂着用户意图、临时推理、工具日志、权限决定和已经过期的探索路径。完整继承虽然方便，却也会把噪声、错误假设和 token 成本一起复制给 child。

因此，multi-agent 系统面对的第一个选择不是“怎样复制得更便宜”，而是“究竟应该复制多少”。

## Subagent：不是同事，而是一种 Tool

Maka 对这个问题给出了一个激进答案：subagent 不自动继承父 Agent 的对话历史。

主 Agent 调用 `agent_spawn` 时，需要提交一个边界明确、自包含的任务：

```text
agent_spawn({
  subagent_id: "local-reader",
  task: "检查存储模块如何处理并发写入，并给出文件与符号证据"
})
```

Runtime 创建独立的 child Session，为它注入角色、工具、权限和 workspace 边界。child 的第一次模型调用从自己的历史开始，只看到主 Agent 显式交付的任务，而不是父会话的全部过程。

这要求主 Agent 把隐含上下文编译成一份可以独立执行的 specification：

```text
调查 packages/storage 中的并发写入机制。

请回答：
1. 哪些对象负责并发控制；
2. 冲突如何被发现；
3. 给出对应文件和符号；
4. 只做只读调查，不修改代码。
```

主 Agent 和 subagent 是否需要交流？Maka 的答案是：不需要持续交流。

```text
Main Agent  ── task ──>  Subagent
Main Agent  <─ result ─  Subagent
```

双方之间没有 mailbox，也没有执行到一半回来协商下一步的消息协议。主 Agent 负责拆解问题、选择执行者和综合结果；subagent 只负责完成局部任务。运行过程中的事件可以投影到 UI 供用户观察，但这种 presentation 不是 Agent 之间的 conversation。

从调用者看来，subagent 仍然遵守 Tool 的契约：输入一个任务，执行一个受限过程，返回状态、摘要和 artifact 引用。

```text
result = subagent(role, tools, task, workspace)
```

这让上下文边界非常清楚，却也引出了下一个问题：如果任务之间存在复杂依赖，而 child 之间又不通过交谈协调，系统用什么表达全局计划？

## DAG：数据库如何把意图变成执行

当计算由多个相互依赖的步骤组成时，最自然的表达通常不是列表，而是 Directed Acyclic Graph，也就是 DAG。

列表给出全序：先 A，再 B，再 C。DAG 表达的是偏序：边只声明必要的先后关系，没有依赖关系的节点可以自由并发。

```text
A ───────> C

B ───────> D
```

这里 A 必须先于 C，B 必须先于 D，但 A 与 B 之间没有天然顺序。调度器不需要获得一份完整执行序列，只需要找到当前输入条件已经满足的节点。

```text
Node  = 一个计算单元
Edge  = 依赖或数据流
Ready = 节点的输入条件已经满足
```

数据库很早就把“要做什么”与“怎样执行”分成了不同层次。用户提交 SQL，数据库首先生成 logical plan：

```text
              Aggregate by region
                       │
                      Join
                  ┌────┴────┐
              Filter      Project
                │            │
          Scan orders  Scan customers
```

Logical plan 描述关系语义。优化器可以下推 Filter、裁剪列、调整 Join 顺序或简化表达式，只要不改变查询结果。

随后，physical planner 把抽象 operator 降低为具体实现：

```text
             FinalHashAggregateExec
                       │
                 RepartitionExec
                       │
            PartialHashAggregateExec
                       │
                  HashJoinExec
                 ┌─────┴─────┐
            FilterExec   RepartitionExec
                 │              │
     ParquetScanExec     ParquetScanExec
```

Physical plan 开始决定 Join 算法、partition 数量、并行度以及中间数据是否需要 exchange。同一个 logical plan 可以因为数据规模、分区方式、可用内存和机器核数不同而产生不同的 physical plan。

但 physical plan 仍然不是执行。运行时还要为节点创建状态、分配资源，让数据流动，并处理结束、取消、错误和 backpressure。

可以立即消费和产出 batch 的 operator 能形成 pipeline：

```text
Scan ──batch──> Filter ──batch──> Project ──batch──> Sink
```

Sort、Hash Join 的 build side 或全局 Aggregate 往往必须先积累输入，因而成为 pipeline breaker。到了这一层，执行引擎才真正需要决定哪些 pipeline 已经 ready，以及上下游怎样并发推进。

Apache Arrow Acero 展示了一个紧凑的实现：`Declaration` 描述准备构造的节点，`ExecPlan` 和 `ExecNode` 表示一次运行的物理图，`ExecBatch` 是沿边流动的数据。

```text
SQL
 │ parse / analyze
 ▼
Logical Plan
 │ semantic optimization
 ▼
Optimized Logical Plan
 │ physical planning
 ▼
Physical Plan
 │ instantiate / schedule
 ▼
Running Pipelines
```

数据库留下的核心经验是：DAG 不是执行本身，而是一种允许系统逐层优化、降低并最终调度执行的中间表示。

## Maka Agent Graph：让 Agent 写计划，让系统推进计划

数据库通常能在执行前构造相对完整的 physical plan，Agent 的计划却很难一次写完。

一次调查可能暴露出新的问题；一个实现结果可能改变验证方案；某个节点失败后，主 Agent 也可能选择另一条路径，而不是机械重试。Maka 的 Agent Graph 因此是一张在运行过程中逐步生长的 DAG。

它把职责分成三部分：

> 主 Agent 负责写计划，Coordinator 负责推进计划，Supervisor 负责观察计划。

### 主 Agent 写入 Durable Intent

只有 root Session 中的主 Agent 拥有 Graph control tools。它可以追加工作、停止或替换旧工作，并选择最终结果关闭 Graph。child Session 不能反向修改全局拓扑。

主 Agent 通过 `update_agent_graph` 提交 schedule revision。没有输入依赖的 work 可以并行；后续 work 则引用 upstream 已提交的 result record：

```text
Runtime review result ─┐
                       ├──> Synthesis work
Storage review result ─┘
```

这不是“现在启动三个进程”的瞬时命令，而是 durable intent：系统要增加什么 work、输入 frontier 是什么、谁应该被停止或替换，以及最终选择哪些结果。

Schedule update 以 append-only revision 提交到 SQLite，并带有来源 Session、Run、Turn 和 Tool Call identity。主 Agent 即使退出，已经写下的计划也不会随着模型上下文消失。

### Coordinator 是 Reconciler

Coordinator 不在内存中长期持有一份权威的可变 DAG。每轮 reconciliation 都重新读取持久状态：

```text
SQLite control plane
    │
    ├── schedule updates
    ├── operator provisions
    ├── intent claims
    └── supervisor wakes
    │
    ▼
Coordinator reconstructs a snapshot
```

它把 revisions 折叠成当前计划，把 provisions 组成 topology，再结合 AgentRun 和 committed RuntimeEvents，计算哪些 work 已经完成、哪些输入仍未出现，以及哪些节点已经 ready。

```text
Observe durable state
        │
        ▼
Apply stop / replace / finish decisions
        │
        ▼
Provision missing operators
        │
        ▼
Resolve ready work
        │
        ▼
Claim exact Turn / Run identities
        │
        ▼
Dispatch child AgentRuns
```

Maka 当前使用事件驱动的 single-flight driver，而不是固定 `setInterval` 扫描数据库。新的 schedule、child RuntimeEvent 或 host recovery 都可以请求 reconciliation；同一个 Graph 同时只有一个 driver，重复 wake 被合并到下一轮。

### SQLite 是 Control Plane

Graph 没有再造第二套 Agent runtime。SQLite 只保存调度事实，实际的模型调用、Tool Call、权限处理、停止和 RuntimeEvent 持久化仍由 Session Runtime 完成。

```text
Main Agent ──> SQLite schedule
                    │
                    ▼
               Coordinator
                    │ claim / dispatch
                    ▼
          Child Sessions / AgentRuns
                    │
                    ▼
          committed RuntimeEvents
```

一个 child Session 是稳定的 operator container，一次 AgentRun 是一次 activation，已经提交的 RuntimeEvent 才能成为 Graph 中可消费的 record。

### Claim 把 Ready 与 Execute 分开

Coordinator 可以反复重建 snapshot，因此同一个节点也可能被多次计算为 ready。如果看到 ready 就直接调用模型，崩溃和重试可能导致重复执行。

Maka 在执行前向 SQLite 写入 conditional claim，把确定性 intent 绑定到具体 operator、Session、Turn 和 Run identity：

```text
ready intent
     │
     ▼
conditional claim
     │
     ├── already exists ──> inspect or recover the same Run
     └── new claim ───────> execute the allocated Run
```

Readiness 是可以重复计算的 projection，execution admission 则成为持久事实。

### Supervisor 在 Checkpoint 处恢复判断

Coordinator 能确定性推进计划，却不适合判断两份调查是否矛盾，或者一次失败应该重试、替换还是改变方向。这些语义决策仍然属于主 Agent。

主 Agent 写完一轮 schedule 后，可以结束当前 supervisor turn。Coordinator 异步推进 Graph；到达 durable checkpoint 后，Host 再创建一个新的 supervisor turn：

```text
Main Agent schedules work
          │
          ▼
Coordinator advances Graph
          │
          ▼
durable checkpoint
          │
          ▼
Host wakes Main Agent
```

主 Agent 读取有界 Graph snapshot，必要时读取 child 的 committed result，然后增加下一轮工作、停止或替换旧 work，或者选择结果 finish Graph。

整个闭环中存在两种智能：主 Agent 提供拆解、判断和综合的语义智能；Coordinator 提供持久化、拓扑重建、并发推进和故障恢复的系统智能。

## Go Channel：通信本身就是调度

DAG 能描述依赖，却不能独自回答执行时的等待、唤醒与背压。Go 的并发模型提供了另一个观察调度的角度。

goroutine 是由 Go runtime 调度的轻量级执行单元。常被概括为 G-M-P 的 runtime 会把大量 goroutine 多路复用到较少的 OS thread 上：G 表示 goroutine，M 表示 OS thread，P 表示执行 Go 代码所需的 runtime 资源。

goroutine 解决“如何廉价地产生并发任务”，Channel 则解决它们“如何协作”。

### 无缓冲 Channel 是 Rendezvous

```go
handoff := make(chan Result)
go func() { handoff <- result }()
received := <-handoff
```

无缓冲 Channel 的发送者等待接收者，接收者也等待发送者。只有双方都到达交接点，通信才能完成。它传递的不只是 `Result`，还传递了“双方已经在这里会合”的同步事实。

Go memory model 为 Channel 操作定义了 happens-before。接收者拿到值后，可以观察发送者在 send 之前完成的写入。因此 Channel 同时承载了：

```text
value transfer + scheduling point + memory ordering
```

### Buffer 定义允许领先的距离

```go
jobs := make(chan Job, 32)
```

有缓冲 Channel 允许生产者和消费者在有限距离内解耦。只要还有空间，send 就能继续；buffer 满以后，生产者阻塞，压力沿 pipeline 反向传播。

容量 `32` 不只是性能参数，也规定生产者最多可以比消费者领先多少项工作。太小会损失并行度，太大则可能积压过期任务、放大内存占用，并延迟暴露下游变慢的问题。

### `select`、`close` 与 nil Channel

`select` 允许一个 goroutine 同时等待多条通信边：

```go
select {
case job := <-jobs:
    return handle(job)
case <-ctx.Done():
    return ctx.Err()
}
```

它是一种调度接口：执行单元声明自己依赖哪些事件，runtime 在其中一项 ready 时恢复它。

`close(ch)` 发布的是“不会再有新值”的生命周期状态。关闭后，接收者先读完 buffer，再通过 `value, ok := <-ch` 观察结束。关闭还可以充当广播，因为所有等待者都能观察到它。

nil Channel 则永远不会 ready。在 `select` 中把某个 Channel 变量设为 nil，可以动态禁用一条分支，构造小型并发状态机。

### Pipeline 必须拥有取消路径

多个 stage 可以由 Channel 连接成 pipeline，也可以通过多个 goroutine 形成 fan-out 和 fan-in。但如果下游提前退出，上游可能永久阻塞在 send 上并泄漏 goroutine。

```go
select {
case out <- result:
case <-ctx.Done():
    return
}
```

每个可能长期阻塞的 send 或 receive，都应该回答：如果另一端永远不会再出现，这个 goroutine 怎样退出？

Go Channel 的真正特色，是没有把数据流与控制流彻底分开。一次通信既传递 value，也表达 dependency、synchronization 和 backpressure：

```text
communication = dependency + synchronization + backpressure
```

这个模型也启发了另一派 subagent 系统：如果每个 Agent 都拥有一只 inbox，消息到达本身是否可以成为调度条件？

## Codex Subagent：用 Mailbox 组织协作

Codex 给出的答案是肯定的。它保留 parent-child delegation，同时把每个 Agent 建模成有身份、有独立历史、可以持续接收消息的执行单元。

同一棵 subagent tree 中的 Agent 拥有可寻址路径：

```text
/root
├── /root/runtime_review
├── /root/storage_review
│   └── /root/storage_review/query_analysis
└── /root/test_runner
```

这套模型与 Actor system 很接近：

```text
Actor identity   = AgentPath
Actor state      = Thread history
Actor mailbox    = Session InputQueue
Actor activation = Turn
```

### Mailbox 是 Session 的私有队列

Codex Core 的 `InputQueue` 把 payload 与 wakeup 分开：

```rust
struct InputQueue {
    activity_tx: watch::Sender<InputQueueActivity>,
    mailbox_pending_mails: Mutex<VecDeque<PendingMailboxCommunication>>,
}
```

`VecDeque` 保存 FIFO 消息，Tokio `watch` Channel 通知等待者 mailbox 发生变化。通知可以合并，因为 queue 才是消息事实来源。

这不是多个 worker 竞争 claim 的共享 inbox。每个 Session 都有自己的 mailbox，每封 `InterAgentCommunication` 在投递前就已经指定 `author`、`recipient`、`content` 和 `trigger_turn`。

### Message 也携带调度意图

Codex V2 区分两种投递：

```text
send_message   = QueueOnly
followup_task  = TriggerTurn
```

`send_message` 只把消息放进目标 inbox。目标 Agent 正在运行时，它会在后续模型边界看到消息；目标 Agent 已经空闲时，消息等待下一次自然 activation。

`followup_task` 会设置 `trigger_turn=true`。如果目标 Agent 已经空闲，pending-work scheduler 可以为它创建新的 Turn。

```text
                    InterAgentCommunication
                              │
                   ┌──────────┴──────────┐
                   │                     │
          trigger_turn = false  trigger_turn = true
                   │                     │
              queue message        wake idle Agent
```

所以一封消息同时表达 information、recipient 和 scheduling intent。

### Agent 在模型边界收信

消息不会修改一次已经发出的 LLM sampling request。它先进入 mailbox，等待 Turn loop 再次构造模型 context：

```text
Agent B starts sampling
          │
Agent A sends a message
          │
          ▼
     B.mailbox.enqueue
          │
 current sampling ends
          │
          ▼
     drain mailbox
          │
          ▼
build next model request
```

Codex 还维护 `MailboxDeliveryPhase`。Turn 开始时，邮件可以加入当前执行；一旦 runtime 已经记录用户可见的 final answer，迟到消息就被留给下一轮，避免已经结束的答案被后台消息悄悄续写。

### Completion 本身也是一封消息

Codex 为 child 启动 completion watcher。child 进入终态后，watcher 构造一封从 child 发往 parent 的 `InterAgentCommunication`，并把它放进 parent mailbox。

这封 completion message 的 `trigger_turn` 是 false。结果首先是一条进入 parent inbox 的事实，而不是强制 parent 立即推理的中断。

`wait_agent` 因此也不直接从指定 child 拉取正文。它订阅当前 Session 的 mailbox activity：

```text
wait_agent
    │
    ├── new mail ─────> wake
    ├── user steer ───> interrupt wait
    └── deadline ─────> timeout
```

工具只负责 suspend 和 wakeup；消息正文仍保存在 mailbox 中，随后由 Turn loop 放进模型 context。

### Workflow 在 Conversation 中展开

DAG 系统把依赖写成显式边，Codex 的协作则可能表现为一串动态消息：

```text
Root ──task──────> Agent A
Root ──task──────> Agent B
Agent A ──note───> Agent B
Agent B ──result─> Root
Root ──follow-up─> Agent A
Agent A ──result─> Root
```

Agent A 可以把新发现立即告诉 Agent B，主 Agent 也可以在 child 尚未完成时补充约束。实际 workflow 不必预先完整存在，而是在 conversation 中逐步生长。

灵活性也带来代价。控制流分散在消息历史中；想解释 Agent 为什么改变方向，需要回放它收到的 mailbox；想知道一项工作何时真正 ready，也不能只数一张全局 DAG 的入边。

Codex 因而可以概括为：以主 Agent 委派为入口，以 Actor mailbox 作为协作平面。

## 总结：Workflow 与 Collaboration

Maka 和 Codex 都能创建多个 subagent，也都支持并行和 follow-up，但它们选择了不同的系统原语。

| 维度     | Maka workflow                  | Codex mailbox                          |
| -------- | ------------------------------ | -------------------------------------- |
| 核心抽象 | DAG 中的 operator 与 edge      | 可寻址 Agent 与私有 inbox              |
| 任务产生 | 主 Agent 写 schedule           | parent spawn 或 Agent 发送 follow-up   |
| 调度条件 | Coordinator 计算节点 readiness | 消息到达、`trigger_turn` 与 Agent 状态 |
| 数据传递 | record 沿依赖边成为下游输入    | message 进入目标 Agent context         |
| 横向交流 | child 之间不需要通信           | Agent 可以向其他 Agent 发消息          |
| 状态观察 | 读取全局 Graph snapshot        | 检查各 Agent 状态并消费 inbox          |
| 主要优势 | 显式、可审计、容易确定性恢复   | 灵活、可动态协商、适合未知路径         |
| 主要代价 | 临时协商必须回到 Graph         | 控制流隐含，消息与 context 容易膨胀    |

Workflow 适合依赖明确、结果可结构化、执行时间较长并且必须可靠恢复的任务。代码扫描、批量测试、数据处理和多阶段 research synthesis 都可以被建模为 operator 与 record。

Mailbox 适合下一步取决于语义发现、角色需要不断交换信息、计划无法预先穷举的任务。设计讨论、交叉审查和开放式调查更接近这种协作。

两者真正的分界并不是“是否使用 subagent”，而是把协调状态放在哪里：

```text
Maka:  coordination lives in the Graph
Codex: coordination lives in the Conversation
```

Graph 把计划从模型上下文中提取出来，交给确定性系统推进；Conversation 保留 Agent 的交流自由，让计划在运行中自然形成。前者更像数据库执行引擎，后者更像 Actor system。

这也解释了为什么 Maka 刻意不让 subagent 互相聊天。它并不是认为 Agent 无法协作，而是选择把协作编译成显式的 schedule：模型负责语义判断，Runtime 负责执行事实，Coordinator 负责推进依赖。

Multi-agent 调度最终不是“启动多少模型”的问题，而是一个更传统的系统问题：如何表示状态，如何传递依赖，如何控制并发，以及在任何一个执行者退出以后，系统还能否知道下一步该做什么。

## 延伸阅读

- [Linux `fork(2)`](https://man7.org/linux/man-pages/man2/fork.2.html)
- [Apache DataFusion：Reading Explain Plans](https://datafusion.apache.org/user-guide/explain-usage.html)
- [Apache Arrow：Acero Overview](https://arrow.apache.org/docs/cpp/acero/overview.html)
- [The Go Programming Language Specification: Channel types](https://go.dev/ref/spec#Channel_types)
- [The Go Memory Model](https://go.dev/ref/mem)
- [Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines)
- [Codex `InputQueue` and mailbox](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/session/input_queue.rs#L66-L186)
- [Codex MultiAgent V2 message delivery](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L12-L127)
- [Codex mailbox-driven Turn scheduling](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/tasks/mod.rs#L422-L508)
