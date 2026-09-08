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

在 Multi-Agent 架构中，创建 Subagent 常被简化理解为“并行启动多个模型处理任务”。然而，系统设计的核心瓶颈在于调度拓扑：Subagent 应继承何种上下文、任务由谁拆解与分发、执行依赖如何严谨表达、产出结果如何可靠交付、单点故障后如何确定性恢复，以及并发 Agent 之间是否应当存在直接的通信通道。

这些工程权衡将 Multi-Agent 系统划分为两条截然不同的演进路径。

第一条路径将 Subagent 视为工作流算子（Operator）：主 Agent 规划确定性执行图，调度内核依据显式依赖推进执行，数据与产物沿有向边单向流动。第二条路径将 Subagent 视为协作参与者（Participant）：每个 Agent 具备独立身份与私有信箱（Mailbox），通过异步消息传递驱动协作，实际控制流在多轮对话中动态交织。

Maka 采用了第一条基于显式工作流图的路径，而 Codex 的 Subagent 体系则代表了第二条消息驱动的典型设计。理解这两类架构的前提，在于审视操作系统如何在进程派生中低成本管理状态分叉。

## Copy-on-Write：按需分叉的隔离哲学

在操作系统设计中，Copy-on-Write（CoW，写时复制）是控制分支状态复制开销的核心机制。Linux 线程默认共享同一虚拟地址空间，而经典 CoW 则作用于 `fork()` 系统调用派生新进程的阶段。

若 `fork()` 采取全量深拷贝策略，子进程创建开销将与父进程物理内存呈线性正比。更低效的是，子进程通常会迅速调用 `exec()` 载入新二进制映像，导致复制的大量内存页未被访问即遭丢弃。

Linux 通过建立彼此独立、但初始指向相同物理页帧的页表来延迟物理拷贝。`fork()` 触发时，内核为子进程建立独立的虚拟地址空间，让对应页表项映射同一组物理页，并将原本私有可写的映射标记为只读：

```text
Parent virtual pages ──┐
                       ├──> shared physical pages
Child virtual pages ───┘
```

在读操作占主导的阶段，两端完全复用同一份内存。一旦任一方首次发起写操作，内存管理单元（MMU）触发 Page Fault，内核捕获缺页中断并分配新的独立物理页，仅为执行写入的一方生成私有副本：

```text
Before write

Parent ──┐
         ├──> Page A
Child ───┘

After child writes

Parent ─────> Page A
Child  ─────> Page A'
```

Copy-on-Write 的本质在于将数据复制的成本后推至物理分歧发生的时刻。状态分叉的初始代价仅包含创建轻量元数据与建立映射拓扑，总体开销由实际修改量界定，与全局状态规模解耦。

这一思想被直接引入 Agent 架构。Subagent 能够自父 Agent 的既有会话日志打分叉点，初始阶段引用父级上下文，后续仅追加自身的增量事件：

```text
Shared conversation prefix
             │
        ┌────┴────┐
        ▼         ▼
    Main delta  Child delta
```

然而，LLM 的上下文并非等价于平坦的只读内存页。父 Agent 的历史会话中可能交织着原始用户指令、中间回复、工具调试输出、鉴权事件及已淘汰的试错路径。全量继承上下文虽然能免去前置的任务提炼，但也会将大量历史噪声、错误先验及冗余 Token 开销无差别倾倒给子任务。

因此，Multi-Agent 系统面临的首要架构抉择在于确定上下文分叉的边界与粒度。

## Subagent：任务限定的受控工具

Maka 在上下文继承上采取了严格的边界策略：Subagent 默认不继承父级会话的完整历史。

主 Agent 调度 `agent_spawn` 时，必须提供一份边界封闭、语义自洽的任务规范：

```text
agent_spawn({
  subagent_id: "local-reader",
  task: "检查存储模块如何处理并发写入，并给出文件与符号证据"
})
```

Runtime 据此创建拥有独立会话历史的子实例，并注入角色指令、受限工具集、权限边界与工作区范围。子 Agent 不会获得父级的完整对话；其初始上下文由运行时指令与显式任务规范共同构成，从而将无关的父级历史排除在工作集之外。

这要求主 Agent 将全局隐式上下文提炼为可独立执行的契约定义：

```text
调查 packages/storage 中的并发写入机制。

请回答：
1. 哪些对象负责并发控制；
2. 冲突如何被发现；
3. 给出对应文件和符号；
4. 只做只读调查，不修改代码。
```

在主 Agent 与 Subagent 之间，Maka 舍弃了持续性的双向会话交互：

```text
Main Agent  ── task ──>  Subagent
Main Agent  <── result ──  Subagent
```

两者之间不存在共享 Mailbox，亦不支持运行期动态磋商指令。主 Agent 专职于顶层目标拆解、算子选型与结果综合，Subagent 聚焦于封闭局部任务的执行。运行时产生的执行事件可投影至前端界面供用户审查，但这属于系统监控层面的单向遥测，不构成 Agent 之间的交互信道。

在调用模型视角下，Subagent 遵循工具契约规范：接收结构化任务入参，在分配给它的运行时边界内执行，终态返回结构化状态、摘要文本及产物引用（Artifact Ref）：

```text
result = subagent(role, tools, task, workspace)
```

该模式确保了清晰的执行边界，同时也引出了核心架构问题：当子任务之间存在严密的因果依赖，而执行单元之间又缺少动态对话信道时，系统应如何刻画并推进全局执行计划。

## DAG：关系引擎的状态演进模型

处理具备依赖拓扑的多阶段计算时，有向无环图（Directed Acyclic Graph，DAG）是最为严谨的拓扑表达形式。

平坦的线性列表强制执行全序调度（先 A，再 B，后 C）。DAG 则定义了偏序关系：边仅用于约束不可逾越的前置依赖，不存在连接关系的节点可获得天然的并发执行自由度：

```text
A ───────> C

B ───────> D
```

在此拓扑中，A 构成 C 的前置依赖，B 构成 D 的前置依赖，而 A 与 B 之间互不干扰。调度器无须预先推导串行线性流水线，只需持续识别当前入度已清零（输入依赖已全部就绪）的活跃节点：

```text
Node  = 计算单元（Operator）
Edge  = 依赖约束或数据流向
Ready = 前置输入条件全部达成
```

现代数据库系统早已将意图定义与物理执行严格分层。用户下发声明式 SQL 后，引擎首先构建逻辑执行计划（Logical Plan）：

```text
              Aggregate by region
                       │
                      Join
                  ┌────┴────┐
              Filter      Project
                │            │
          Scan orders  Scan customers
```

逻辑计划专职描述关系代数语义。查询优化器可在保障等价语义的前提下，执行谓词下推、列裁剪、Join 重排及表达式折叠。

随后，物理计划生成器（Physical Planner）将抽象逻辑算子降级为底层的工程实现：

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

物理计划负责敲定具体的 Join 算法、分区哈希策略、并发度及跨节点 Exchange 开销。相同的逻辑关系拓扑会依据数据倾斜度、集群拓扑与内存配额，编译出各异的物理计划。

物理计划确立后，运行时引擎仍需实例化具体的执行流水线，分配内存池与计算配额，推进批流交互，并统一处理终止、超时、异常与反压信号。

能够就地流式处理批数据的算子构成连续流水线：

```text
Scan ──batch──> Filter ──batch──> Project ──batch──> Sink
```

而全局排序、Hash Join 的构建端（Build Side）或全局聚合等算子，由于必须完全吸收前置输入方可输出数据，构成了天然的管线断点（Pipeline Breaker）。执行引擎据此切分物理阶段，精准裁决各个子管线的调度准入与并发水位。

Apache Arrow Acero 提供了极为紧凑的工业参考：`Declaration` 抽象声明节点蓝图，`ExecPlan` 与 `ExecNode` 承载单次运行的物理执行图，`ExecBatch` 则作为沿边传递的标准化数据单元。

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

关系引擎的核心沉淀在于：DAG 本身是中间表达（IR），其核心价值在于支撑系统的逐层变换、语义优化、成本评估与底层确定性调度。

## Maka Agent Graph：声明式计划与系统驱动推进

关系引擎通常能在执行启动前生成封闭确定的物理计划，而 Agent 的认知与执行计划往往高度依赖中间反馈，无法一次性静态穷举。

初步的探索性分析可能揭示未知代码分支，局部的实现产物可能彻底改变后续的验证策略，而子任务的执行中断亦会促使规划者切换架构备选方案。Maka 的 Agent Graph 因此被建模为一张在会话生命周期内持续演进的动态 DAG。

该机制在职责切分上确立了三权分立：

- **主 Agent**：专职规划业务蓝图与语义决策。
- **Coordinator**：专职推进依赖解析与拓扑收敛。
- **Supervisor**：观察执行图的关键检查点，并在工作流需要语义判断时恢复主 Agent 的决策过程。

### 主 Agent 写入 Durable Intent

在 Maka 中，仅 Root Session 的主 Agent 具备全局执行图的操作权限。主 Agent 负责登记算子定义、派发依赖任务、标记废弃旧节点，并选取收敛产物终结执行图；子会话被剥离了篡改全局拓扑的系统权限。

主 Agent 借助 `update_agent_graph` 提交结构化的调度修订（Schedule Revision）。无前置依赖的任务自动并发，后续任务显式锚定上游已落盘的产物记录：

```text
Runtime review result ─┐
                       ├──> Synthesis work
Storage review result ─┘
```

该调用提交的是持久化执行意图（Durable Intent）：清晰阐明待追加的工作单元、输入前沿状态、待熔断或替换的历史分支，以及最终采纳的输出集合。

每次调度更新均以追加写日志（Append-Only Revision）的形式持久化至 SQLite，并严格打上宿主会话、Run、Turn 与 Call ID 的审计标记。即便主 Agent 进程遭遇崩溃，已提交的执行计划亦绝不会在内存挥发中遗失。

### Coordinator 专职状态对齐

Coordinator 并不在内存中维护长期易失的权威 DAG 对象。每次执行对齐（Reconciliation）均从持久化存储中重新提取基线事实：

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

Coordinator 将追加写的修订事件折叠为当前计划快照，结合已注册的算子定义构建拓扑，再结合各子任务已持久化的 `RuntimeEvent`，计算各节点的终态与就绪边界。

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

Maka 采用事件驱动的 Single-Flight Driver，而非固定间隔的数据库轮询循环。新的调度提交、子任务事件回传或宿主恢复均可拉起对齐循环；单张执行图在任意时刻仅允许一个 Driver 实例活跃，重复的并发唤醒请求自动合并入后续轮次。

### SQLite 担任控制面存储

Agent Graph 避免重复造一套平行的 Agent 运行时。SQLite 专职托管全局调度事实，底层实际的模型交互、工具调用、权限审查、异步中断及事件持久化，全量复用成熟的 Session Runtime。

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

在系统模型中，子会话充当稳定的算子容器，`AgentRun` 对应单次执行生命周期。下游节点消费的是由运行时事件支撑、已经提交的结果记录，并非将每一条 `RuntimeEvent` 都直接视为执行图输入。

### Claim 机制解耦就绪计算与执行准入

由于 Coordinator 在每次对齐时重建快照，同一个算子节点可能在不同的运算切片中被反复确认为 Ready。若系统在探知就绪时直接触发模型调用，在遭遇重试或瞬时调度抖动时极易产生重复执行。

Maka 在实际拉起子任务前，向 SQLite 写入前置条件认领记录（Conditional Claim），将处于 Ready 状态的抽象意图严密绑定至具体算子、会话编号、交互轮次及执行 ID：

```text
ready intent
     │
     ▼
conditional claim
     │
     ├── already exists ──> inspect or recover the same Run
     └── new claim ───────> execute the allocated Run
```

就绪判定（Readiness）属于可无副作用反复推导的投影视图，而执行准入（Execution Admission）则作为权威事实被一次性原子落盘。

### Supervisor 于检查点恢复语义把关

确定性的 Coordinator 擅长依据拓扑推进执行，却无法代替大语言模型进行高维语义裁决：评估两份调查结论是否存在逻辑矛盾、判断子任务的执行挫折应采取重试、替换算子亦或彻底推倒既有路线。这些关键决策依赖于主 Agent 的高阶推理。

主 Agent 提交完一轮调度规范后，即刻结束当前的监督轮次（Supervisor Turn）。Coordinator 在后台异步调度并发子流水线；一旦全局执行图抵达持久化检查点（Durable Checkpoint），Host 环境唤醒主 Agent 进入全新轮次：

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

主 Agent 读取有界的执行图快照与下游提交的产物正文，启动下一阶段任务规划、剔除陈旧节点或终结图任务。

全流程形成了两种系统能力的互补结合：主 Agent 贡献语义维度的拆解与仲裁，Coordinator 贡献持久化状态机、确定性拓扑演算、并发编排及故障自愈等系统层面的控制保证。

## Go Channel：基于通信范式的并发调度

DAG 擅长固化静态与动态的宏观依赖，但在微观层面仍需解决任务挂起、事件唤醒与流控反压等调度细节。Go 语言的并发哲学为多智能体调度提供了另一套经典的系统视角。

goroutine 是由 Go 运行时自主调度的轻量执行体。经典的 G-M-P 运行时模型将海量的应用协程多路复用至有限的操作系统原生线程：G 代表协程实体，M 对应系统内核线程，P 则抽象了执行 Go 代码所需的逻辑处理器资源。

goroutine 实现了极低成本的并发单元实例化，而 Channel 则确立了各单元间的协作契约。

### 无缓冲 Channel 作为对齐集合点

```go
handoff := make(chan Result)
go func() { handoff <- result }()
received := <-handoff
```

无缓冲 Channel 要求发送端与接收端均已就绪方可完成交接。发送端在接收就绪前阻塞，接收端在数据送达前挂起，因此发送与接收操作构成了两个 goroutine 之间的同步点：

Go 内存模型为 Channel 操作赋予了严谨的 Happens-Before 偏序保障。接收端成功提取数据时，能够安全观察到发送端在投递动作前所完成的全部内存写入。因此，单次 Channel 通信复合了多重职责：

```text
value transfer + scheduling point + memory ordering
```

### 缓冲区界定解耦容限

```go
jobs := make(chan Job, 32)
```

有缓冲 Channel 允许生产者与消费者在受控深度内异步解耦。只要缓冲区存在未填满槽位，发送操作即可无阻塞完成；一旦缓冲耗尽，发送协程挂起，调度压力沿调用链逆向回溯。

容量阈值不仅是性能调优参数，更界定了上游被允许领先下游的最大工作配额。容量过紧会削弱流水线的吞吐平滑度；容量过大则会导致过期任务堆积、内存水位失控，并掩盖下游算子已经发生严重退化的真实瓶颈。

### 多路复用与生命周期信令

Go 通过 `select` 语法允许单个执行体同时监听多组通信边：

```go
select {
case job := <-jobs:
    return handle(job)
case <-ctx.Done():
    return ctx.Err()
}
```

该结构充当声明式的调度接口：执行单元声明其关心的前置信号集，运行时在任一条件达成时将其从等待队列唤醒。

`close(ch)` 则是对生命周期终止状态的广播分发。通道关闭后，接收端在排空既有缓冲后，可通过 `value, ok := <-ch` 感知到通道已完结。所有阻塞在空且已关闭通道上的接收者都能观察到这一终态。

nil Channel 则具备永不就绪的物理特性。在 `select` 块中动态将某分支的通道变量置为 nil，可在不破坏调度主循环的前提下优雅禁用特定分支，构成高内聚的状态机控制。

### 流水线构建中的取消传播

多个计算阶段可借助 Channel 串联为处理流水线，亦可通过扇出（Fan-out）与扇入（Fan-in）实现多路并行。然而，下游算子若非正常提前退场，未受保护的上游生产者将永久阻塞于发送点，导致协程泄漏。

```go
select {
case out <- result:
case <-ctx.Done():
    return
}
```

任何可能比下游消费者存活更久的阻塞通信点，都需要显式的取消路径，使相关 goroutine 能够安全清理并退出。

Go Channel 的核心架构特征在于将数据载荷与调度语义高度复合：一次通信行为同时承载了数据交换、依赖表达、状态同步与反压流控：

```text
communication = dependency + synchronization + backpressure
```

这一模型启示了另一种 Multi-Agent 系统设计方案：若为每个 Agent 分配专属收件箱，消息投递行为本身能否直接充当系统调度的核心驱动力。

## Codex Subagent：基于私有信箱的协同架构

Codex 在其 Subagent 协作演进中给出了另一种实践。它保留了父子任务委派关系，同时将每个 Agent 建模为可在同一根任务树内寻址、持有独立会话历史、依托私有队列异步收发消息的实体。

处于同一根任务树中的 Agent 共享一套层级化寻址路径：

```text
/root
├── /root/runtime_review
├── /root/storage_review
│   └── /root/storage_review/query_analysis
└── /root/test_runner
```

该拓扑高度契合经典的 Actor 系统模型：

```text
Actor identity   = AgentPath
Actor state      = Thread history
Actor mailbox    = Session InputQueue
Actor activation = Turn
```

### 信箱作为会话内部的私有队列

Codex 核心的 `InputQueue` 结构将数据存储与唤醒信令彻底解耦：

```rust
struct InputQueue {
    activity_tx: watch::Sender<InputQueueActivity>,
    mailbox_pending_mails: Mutex<VecDeque<PendingMailboxCommunication>>,
}
```

内存中的 `VecDeque` 在会话存续期间维持消息的先进先出（FIFO）顺序，而 Tokio 的 `watch` 通道则向监听调度器下发信箱发生变动的轻量唤醒脉冲。多条变动信号可以合并，因为待处理负载仍保留在队列中；这个队列本身并不意味着持久化。

这并非多个无差别工作节点共同竞争的任务拉取队列。每个会话独占自身的专有信箱，每封通信记录在派发前必须预先绑定发送方（Author）、接收方（Recipient）、文本负载及是否拉起轮次的标志位（`trigger_turn`）。

### 消息附带显式调度意图

Codex V2 将消息投递清晰划分为两种调度级别：

```text
send_message   = QueueOnly
followup_task  = TriggerTurn
```

`send_message` 仅执行入队追加。若目标 Agent 正在执行，信件将在后续的模型推理切片边界被统一查阅；若目标 Agent 处于休眠，消息在信箱中静默封存，等待未来的自然交互周期。

`followup_task` 则显式注入 `trigger_turn = true` 属性。若目标 Agent 处于空闲等待状态，待办调度器获准为其即时创建新的执行轮次。

```text
                    InterAgentCommunication
                              │
                   ┌──────────┴──────────┐
                   │                     │
          trigger_turn = false  trigger_turn = true
                   │                     │
              queue message        wake idle Agent
```

单次消息投递同时复合了信息传递、目标寻址与执行调度意图。

### 模型采样边界的受控收信机制

外部消息绝不会破坏性中断一次正在进行的 LLM 采样请求。新抵达的消息先入队隔离，等待当前交互轮次结束、重新构建下一次模型上下文时批量水合入局：

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

Codex 引入了 `MailboxDeliveryPhase` 状态机。轮次启动初期，信箱积压邮件被允许注入上下文；一旦运行时已在本地生成并记录了面向用户的最终输出，迟到的后发消息将被强制顺延至后续轮次，严防已敲定的结论被并发涌入的次级消息无序篡改。

### 任务完结作为结构化消息回传

Codex 为子任务配置了专属的状态观察者（Completion Watcher）。子任务推进至最终稳态后，观察者构造一条由子任务发往父任务的通信记录，并安全置入父任务信箱。

此完结信件的 `trigger_turn` 默认配置为 `false`。执行结果首先作为一条事实沉淀入父级收件箱，避免非预期打断父任务可能正在专注展开的上下文。

`wait_agent` 工具通过等待父会话的信箱活动来实施流控，而不是直接返回某个子任务的结果：

```text
wait_agent
    │
    ├── new mail ─────> wake
    ├── user steer ───> interrupt wait
    └── deadline ─────> timeout
```

该工具仅负责执行挂起与唤醒协议；实际的结果内容仍保留于信箱底层，在随后的正常轮次中并入模型上下文。

### 对话交织中演进的工作流

基于 DAG 的体系将所有依赖固化为显式拓扑边，而基于 Mailbox 的体系则呈现为一系列在时间线上展开的动态消息流：

```text
Root ──task──────> Agent A
Root ──task──────> Agent B
Agent A ──note───> Agent B
Agent B ──result─> Root
Root ──follow-up─> Agent A
Agent A ──result─> Root
```

Agent A 在得出局部洞察后可即时知会并发的 Agent B，主 Agent 亦能在子任务运行中途随时追加补充指引。真实的业务工作流无须在初始阶段完成全量预测，而是在多方对话交互中逐步成型。

动态灵活性对应着系统复杂度的转移：系统控制流被分散掩埋在跨 Agent 的通信历史中。追溯某个决策变更的原因需要完整重放对应信箱的吸收序列；研判某个中间节点是否已满足执行条件，亦无法简单依赖全局有向图的拓扑入度来决断。

Codex 架构的技术本质可概括为：在根任务范围内保留父子委派关系，并在其上叠加 Actor 风格的私有信箱协作层。

## 架构选型：工作流编排与消息协同

Maka 与 Codex 均支持 Subagent 派生、并发执行及追加任务，但在系统底层原语的设计上做出了截然不同的取舍。

| 维度         | Maka 工作流模型                          | Codex 信箱协作模型                         |
| ------------ | ---------------------------------------- | ------------------------------------------ |
| **核心抽象** | DAG 拓扑中的算子与数据边                 | 可在根任务树内寻址的 Agent 与私有信箱      |
| **任务派发** | 主 Agent 显式编写调度计划                | 父级派发或对等实体投递 Follow-up           |
| **调度条件** | Coordinator 演算节点依赖就绪度           | 消息入队、`trigger_turn` 标记及活跃度      |
| **数据传递** | 结构化记录沿依赖边注入下游               | 消息体在模型轮次边界并入会话上下文         |
| **横向交互** | 不向子节点暴露直接通信通道               | 根任务树内的 Agent 支持直接消息传递        |
| **全局视图** | 随时可提取全局确定性图快照               | 需汇聚各 Agent 状态与信箱积压综合反推      |
| **核心优势** | 显式拓扑、确定性执行、原生易于审计与恢复 | 具备极高弹性、支持动态协商、适配开放式探索 |
| **核心代价** | 动态调整需重新提请修改调度图             | 控制流隐式离散，消息与上下文极易膨胀       |

工作流模型适用于前后依赖清晰、产物结构规范、单次执行跨度较长且对崩溃恢复要求极高的系统级工程任务。静态代码分析、并行构建测试、大规模数据管道及多阶段技术调研均具备明确的“算子与产物”特征。

信箱协同模型更适用于行动分支高度取决于即时语义发现、各角色需密集双向推演、且全流程无法预先穷举的探索性任务。系统方案研讨、交叉代码审查与发散式安全渗透更贴合此类去中心化的交互结构。

两种路径的底层分水岭在于协调状态（Coordination State）的物理托管位置：

- **Maka**：将协同状态上浮收拢于全局执行图（Coordination lives in the Graph）。
- **Codex**：将协同状态离散下沉于多方通信流（Coordination lives in the Conversation）。

Agent Graph 将计划从大模型的易失上下文中抽离，交由持久、可重放的系统协调器推进；Mailbox 机制则赋予智能体更自由的动态调整空间。前者更贴近确定性的关系数据库计算引擎，后者则深植于经典的 Actor 并发框架。

这也阐释了 Maka 约束 Subagent 横向直接交流的设计取向：将协同过程静态编译为透明受控的调度图。大模型专职贡献高价值的语义逻辑判断，Runtime 严密记录真实系统的执行事实，而 Coordinator 则负责确定性地驱动数据依赖向前收敛。

Multi-Agent 系统的核心本质是一套经典的分布式系统课题：状态如何规范表达、依赖如何可信传递、并发如何精准约束，以及当特定执行节点遭遇崩溃退出后，整个系统是否依然具备清晰的前进确定性。

## 延伸阅读

- [Linux `fork(2)`](https://man7.org/linux/man-pages/man2/fork.2.html)
- [Apache DataFusion: Reading Explain Plans](https://datafusion.apache.org/user-guide/explain-usage.html)
- [Apache Arrow: Acero Overview](https://arrow.apache.org/docs/cpp/acero/overview.html)
- [The Go Programming Language Specification: Channel types](https://go.dev/ref/spec#Channel_types)
- [The Go Memory Model](https://go.dev/ref/mem)
- [Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines)
- [Codex `InputQueue` and mailbox](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/session/input_queue.rs#L66-L186)
- [Codex MultiAgent V2 message delivery](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L12-L127)
- [Codex mailbox-driven Turn scheduling](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/tasks/mod.rs#L422-L508)
