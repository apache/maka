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

[简体中文](./multi-agent-scheduling.zh-CN.md)

# From Copy-on-Write to Mailboxes: Two Paths for Multi-Agent Scheduling

When an agent starts creating subagents, the most intuitive explanation is that it has launched more models to work in parallel. The difficult part, however, is not parallelism. It is scheduling: which context a subagent inherits, who decomposes the work, how dependencies are represented, how results are delivered, how execution recovers after failure, and whether active agents should communicate with one another.

These questions lead multi-agent systems down two distinct paths.

One path treats a subagent as an operator. The main agent writes a workflow, a scheduler advances it according to explicit dependencies, and results travel downstream along directed edges. The other path treats a subagent as a participant. Every agent has an identity and a mailbox, agents coordinate by sending messages, and the actual workflow unfolds through conversation.

Maka takes the first path. The newer Codex subagent design clearly belongs to the second. To understand both, we can begin with the way an operating system creates an execution branch cheaply.

## Copy-on-Write: Share First, Diverge on Mutation

Strictly speaking, copy-on-write is not a threading model. Linux threads normally share one virtual address space. The classic use of copy-on-write appears when `fork()` creates a process.

If `fork()` copied all of the parent's physical memory immediately, the cost of creating a child would grow linearly with the parent's memory footprint. Worse, a child often calls `exec()` shortly afterward, so most of the copied pages would never be read.

Linux therefore copies the logical view before copying all physical data. After `fork()`, the parent and child have logically independent virtual address spaces, but their page tables may initially refer to the same read-only physical pages:

```text
Parent virtual pages ─┐
                      ├──> shared physical pages
Child virtual pages ──┘
```

The pages remain shared while both processes only read them. When either process first writes to a page, the CPU raises a page fault, the kernel copies that page, and the writer mutates its private copy:

```text
Before write

Parent ─┐
        ├──> Page A
Child ──┘

After child writes

Parent ─────> Page A
Child  ─────> Page A'
```

The essential property of copy-on-write is not merely faster copying. It defers copying until divergence actually occurs. Creating a branch requires a new identity and a sharing relationship; its cost follows the amount of changed state rather than the size of the complete state.

The idea transfers naturally to agent systems. A subagent can fork from a prefix of the main agent's history, initially sharing existing context and then recording only its own incremental events:

```text
Shared conversation prefix
             │
        ┌────┴────┐
        ▼         ▼
    Main delta  Child delta
```

Context, however, is not an ordinary memory page. A parent agent's history mixes user intent, temporary reasoning, tool logs, permission decisions, and abandoned hypotheses. Full inheritance is convenient, but it also copies noise, stale assumptions, and token cost into the child.

The first multi-agent design choice is therefore not just how to copy cheaply. It is how much to copy at all.

## A Subagent Is a Tool, Not a Coworker

Maka gives a strong answer: a subagent does not automatically inherit the parent agent's conversation history.

When the main agent calls `agent_spawn`, it must provide a bounded, self-contained task:

```text
agent_spawn({
  subagent_id: "local-reader",
  task: "Inspect concurrent writes in the storage module and cite files and symbols"
})
```

The runtime creates an independent child Session and injects its role, tools, permissions, and workspace boundary. The child's first model invocation starts from its own history. It sees the task explicitly supplied by the main agent rather than the entire parent conversation.

The main agent must compile implicit context into an independently executable specification:

```text
Inspect concurrent writes under packages/storage.

Answer:
1. Which objects provide concurrency control?
2. How are conflicts detected?
3. Cite the relevant files and symbols.
4. Perform read-only research; do not edit code.
```

Do the main agent and subagent need to communicate? Maka's answer is that they do not need an ongoing conversation.

```text
Main Agent  ── task ──>  Subagent
Main Agent  <─ result ─  Subagent
```

There is no mailbox between them and no protocol for negotiating the next step halfway through execution. The main agent decomposes the problem, selects the executor, and synthesizes results. The subagent completes the bounded task. Runtime events may be projected into the UI for the user to observe, but that presentation is not an inter-agent conversation.

From the caller's perspective, a subagent still honors a Tool contract: accept a task, execute a constrained process, and return a status, summary, and artifact references.

```text
result = subagent(role, tools, task, workspace)
```

That creates a clean context boundary, but raises another question. If tasks have complex dependencies and children do not coordinate through conversation, how does the system represent the global plan?

## DAGs: How Databases Turn Intent into Execution

When a computation consists of interdependent steps, a Directed Acyclic Graph is often a more natural representation than a list.

A list imposes a total order: A, then B, then C. A DAG represents a partial order. Edges declare only required precedence, so unrelated nodes may run concurrently.

```text
A ───────> C

B ───────> D
```

A must precede C and B must precede D, but A and B have no inherent ordering. A scheduler does not need a complete execution sequence. It only needs to find nodes whose input conditions are satisfied.

```text
Node  = a unit of computation
Edge  = a dependency or data flow
Ready = the node's input conditions are satisfied
```

Databases have long separated what should be computed from how it should execute. A SQL statement first becomes a logical plan:

```text
              Aggregate by region
                       │
                      Join
                  ┌────┴────┐
              Filter      Project
                │            │
          Scan orders  Scan customers
```

The logical plan describes relational semantics. An optimizer can push down filters, prune columns, reorder joins, and simplify expressions as long as the result remains unchanged.

A physical planner then lowers abstract operators into concrete implementations:

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

The physical plan chooses join algorithms, partition counts, parallelism, and data exchanges. The same logical plan may produce different physical plans as data volume, partitioning, available memory, and CPU resources change.

Yet a physical plan is still not execution. The runtime must instantiate state, allocate resources, move data, and handle completion, cancellation, errors, and backpressure.

Operators that can immediately consume and produce batches form a pipeline:

```text
Scan ──batch──> Filter ──batch──> Project ──batch──> Sink
```

A sort, the build side of a hash join, or a global aggregate may need to accumulate input before producing output and therefore becomes a pipeline breaker. At this layer, the execution engine finally decides which pipelines are ready and how upstream and downstream work advance concurrently.

Apache Arrow Acero provides a compact example. A `Declaration` describes a node to construct, `ExecPlan` and `ExecNode` represent the physical graph for one execution, and `ExecBatch` is the data moving along its edges.

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

The central database lesson is that a DAG is not execution itself. It is an intermediate representation that a system can optimize, lower, instantiate, and eventually schedule.

## Maka Agent Graph: Agents Write Plans, Systems Advance Them

A database can usually construct a reasonably complete physical plan before execution. An agent rarely knows its whole plan in advance.

An investigation may reveal a new problem. An implementation result may change the validation strategy. When a node fails, the main agent may choose a different path instead of retrying mechanically. A Maka Agent Graph is therefore a DAG that grows while it runs.

Maka divides the work among three responsibilities:

> The main agent writes the plan, the Coordinator advances it, and the Supervisor observes it.

### The Main Agent Writes Durable Intent

Only the main agent in the root Session owns Graph control tools. It can append work, stop or replace existing work, select final results, and close the Graph. Child Sessions cannot mutate the global topology in return.

The main agent submits schedule revisions through `update_agent_graph`. Work without input dependencies can run in parallel; later work refers to committed upstream result records:

```text
Runtime review result ─┐
                       ├──> Synthesis work
Storage review result ─┘
```

This is not an ephemeral instruction to start three processes now. It is durable intent: which work to add, what its input frontier is, which work should stop or be replaced, and which results are ultimately selected.

Schedule updates are committed to SQLite as append-only revisions with their source Session, Run, Turn, and Tool Call identity. If the main agent exits, the plan does not disappear with its model context.

### The Coordinator Is a Reconciler

The Coordinator does not keep one authoritative mutable DAG in memory. Every reconciliation reads durable state again:

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

It folds revisions into the current plan, assembles provisions into a topology, and combines that view with AgentRuns and committed RuntimeEvents. From those facts it calculates which work has completed, which inputs are missing, and which nodes are ready.

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

Maka currently uses an event-driven, single-flight driver rather than a fixed `setInterval` database scan. A new schedule, a child RuntimeEvent, or host recovery can request reconciliation. Only one driver advances a Graph at a time, and repeated wakes coalesce into another pass.

### SQLite Is the Control Plane

The Graph does not introduce a second agent runtime. SQLite stores scheduling facts, while model invocations, Tool Calls, permissions, stopping, and RuntimeEvent persistence remain the responsibility of the Session Runtime.

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

A child Session is a stable operator container, an AgentRun is one activation, and only a committed RuntimeEvent can become a record consumed by the Graph.

### Claims Separate Ready from Execute

Because the Coordinator can rebuild its snapshot repeatedly, it can calculate the same node as ready more than once. Starting a model whenever readiness is observed would allow a crash or retry to duplicate execution.

Before execution, Maka writes a conditional claim to SQLite and binds a deterministic intent to a specific operator, Session, Turn, and Run identity:

```text
ready intent
     │
     ▼
conditional claim
     │
     ├── already exists ──> inspect or recover the same Run
     └── new claim ───────> execute the allocated Run
```

Readiness remains a recomputable projection. Execution admission becomes a durable fact.

### The Supervisor Regains Judgment at Checkpoints

The Coordinator can advance an existing plan deterministically, but it should not decide whether two investigations contradict each other, or whether a failed node calls for a retry, replacement, or change in direction. Those semantic decisions remain with the main agent.

After writing one round of the schedule, the main agent can end its current supervisor turn. The Coordinator advances the Graph asynchronously. At a durable checkpoint, the Host creates another supervisor turn:

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

The main agent reads a bounded Graph snapshot and, when needed, a child's committed result. It can then add another round of work, stop or replace obsolete work, or select results and finish the Graph.

The loop contains two kinds of intelligence. The main agent contributes semantic intelligence through decomposition, judgment, and synthesis. The Coordinator contributes systems intelligence through persistence, topology reconstruction, concurrent advancement, and failure recovery.

## Go Channels: Communication Is Scheduling

A DAG describes dependency, but does not by itself implement waiting, wakeup, and backpressure. Go's concurrency model offers another way to think about scheduling.

A goroutine is a lightweight execution unit scheduled by the Go runtime. The runtime model often summarized as G-M-P multiplexes many goroutines over fewer OS threads: G is a goroutine, M is an OS thread, and P is the runtime resource required to execute Go code.

Goroutines make concurrent tasks cheap. Channels define how those tasks cooperate.

### An Unbuffered Channel Is a Rendezvous

```go
handoff := make(chan Result)
go func() { handoff <- result }()
received := <-handoff
```

The sender of an unbuffered Channel waits for a receiver, and the receiver waits for a sender. Communication completes only when both sides reach the handoff point. It transfers not only a `Result`, but also the synchronization fact that both parties met there.

The Go memory model defines happens-before relations for Channel operations. After receiving the value, the receiver can observe writes completed by the sender before the send. A Channel therefore combines:

```text
value transfer + scheduling point + memory ordering
```

### A Buffer Defines How Far a Producer May Lead

```go
jobs := make(chan Job, 32)
```

A buffered Channel decouples a producer and consumer across a bounded distance. A send proceeds while capacity remains. When the buffer fills, the producer blocks and pressure propagates backward through the pipeline.

The capacity `32` is not merely a performance setting. It defines how many units of work the producer may get ahead of the consumer. Too little capacity can suppress useful parallelism. Too much can accumulate obsolete work, consume memory, and delay the discovery of a slow downstream stage.

### `select`, `close`, and nil Channels

`select` lets one goroutine wait on several communication edges:

```go
select {
case job := <-jobs:
    return handle(job)
case <-ctx.Done():
    return ctx.Err()
}
```

It acts as a scheduling interface. An execution unit declares the events it depends on, and the runtime resumes it when one becomes ready.

`close(ch)` publishes a lifecycle transition: no new values will arrive. Receivers first drain the buffer and then observe termination through `value, ok := <-ch`. Closing can also broadcast a signal because all waiting receivers can observe it.

A nil Channel can never become ready. Assigning nil to a Channel variable in a `select` dynamically disables that branch and makes it possible to build small concurrent state machines.

### Every Pipeline Needs Cancellation

Channels naturally connect stages into pipelines and support fan-out and fan-in with multiple goroutines. But when a downstream stage exits early, an upstream producer may remain blocked forever on a send and leak its goroutine.

```go
select {
case out <- result:
case <-ctx.Done():
    return
}
```

Every send or receive that may block indefinitely must answer one question: how does this goroutine exit if the other endpoint never appears again?

The distinctive property of a Go Channel is that it does not fully separate data flow from control flow. One communication carries a value while expressing dependency, synchronization, and backpressure:

```text
communication = dependency + synchronization + backpressure
```

That model suggests another approach to subagents. If every agent owns an inbox, can message arrival itself become a scheduling condition?

## Codex Subagents: Collaboration Through Mailboxes

Codex answers yes. It preserves parent-child delegation while modeling every agent as an execution unit with an identity, independent history, and an inbox that can receive messages over time.

Agents in the same subagent tree have addressable paths:

```text
/root
├── /root/runtime_review
├── /root/storage_review
│   └── /root/storage_review/query_analysis
└── /root/test_runner
```

The design resembles an Actor system:

```text
Actor identity   = AgentPath
Actor state      = Thread history
Actor mailbox    = Session InputQueue
Actor activation = Turn
```

### A Mailbox Is Private to a Session

Codex Core separates the payload queue from the wakeup signal in `InputQueue`:

```rust
struct InputQueue {
    activity_tx: watch::Sender<InputQueueActivity>,
    mailbox_pending_mails: Mutex<VecDeque<PendingMailboxCommunication>>,
}
```

The `VecDeque` stores FIFO messages. A Tokio `watch` Channel tells waiters that mailbox activity occurred. Notifications may coalesce because the queue, not the signal, is the source of message truth.

This is not a shared inbox from which workers compete to claim work. Every Session has a private mailbox. Before delivery, every `InterAgentCommunication` already identifies its `author`, `recipient`, `content`, and `trigger_turn` behavior.

### A Message Also Carries Scheduling Intent

Codex V2 distinguishes two delivery modes:

```text
send_message   = QueueOnly
followup_task  = TriggerTurn
```

`send_message` places content in the target inbox. A running agent sees it at a later model boundary. If the target is idle, the message waits for its next natural activation.

`followup_task` sets `trigger_turn=true`. If the target is idle, the pending-work scheduler may create a new Turn for it.

```text
                    InterAgentCommunication
                              │
                   ┌──────────┴──────────┐
                   │                     │
          trigger_turn = false  trigger_turn = true
                   │                     │
              queue message        wake idle Agent
```

A message therefore carries information, a recipient, and scheduling intent at the same time.

### Agents Read Mail at Model Boundaries

A message cannot alter an LLM sampling request that has already been sent. It first enters the mailbox and waits for the Turn loop to construct another model context:

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

Codex also tracks a `MailboxDeliveryPhase`. At the beginning of a Turn, new mail may join the current execution. Once the runtime has recorded user-visible final output, late mail is left for a later Turn so that background messages cannot silently extend an answer that already appeared complete.

### Completion Is Also a Message

Codex starts a completion watcher for a child. When the child reaches a terminal status, the watcher constructs an `InterAgentCommunication` from the child to the parent and places it in the parent's mailbox.

That completion message uses `trigger_turn=false`. A result first becomes a fact in the parent's inbox rather than an interruption that always forces immediate reasoning.

For the same reason, `wait_agent` does not pull the response body directly from a selected child. It subscribes to mailbox activity on the current Session:

```text
wait_agent
    │
    ├── new mail ─────> wake
    ├── user steer ───> interrupt wait
    └── deadline ─────> timeout
```

The tool handles suspension and wakeup. The message body remains in the mailbox and is subsequently added to model context by the Turn loop.

### The Workflow Unfolds in Conversation

A DAG system writes dependencies as explicit edges. The same collaboration in Codex may appear as a dynamic sequence of messages:

```text
Root ──task──────> Agent A
Root ──task──────> Agent B
Agent A ──note───> Agent B
Agent B ──result─> Root
Root ──follow-up─> Agent A
Agent A ──result─> Root
```

Agent A can immediately tell Agent B about a discovery, and the main agent can add constraints before a child finishes. The complete workflow does not have to exist in advance. It grows through conversation.

That flexibility has a cost. Control flow is distributed across message histories. Explaining why Agent B changed direction may require replaying its mailbox, and deciding when work is ready cannot be reduced to counting incoming edges in one global DAG.

Codex can therefore be summarized as main-agent delegation with an Actor mailbox as its collaboration plane.

## Conclusion: Workflow and Collaboration

Maka and Codex can both create subagents, execute work in parallel, and assign follow-ups, but they choose different systems primitives.

| Dimension          | Maka workflow                                | Codex mailbox                                 |
| ------------------ | -------------------------------------------- | --------------------------------------------- |
| Core abstraction   | Operators and edges in a DAG                 | Addressable agents with private inboxes       |
| Work creation      | The main agent writes a schedule             | Parent spawn or an agent sends a follow-up    |
| Scheduling signal  | The Coordinator calculates node readiness    | Message arrival, `trigger_turn`, agent status |
| Data transfer      | Records become downstream edge inputs        | Messages enter the target agent's context     |
| Peer communication | Children do not need to communicate          | Agents may message other agents               |
| Observation        | Read a global Graph snapshot                 | Inspect agent status and consume inboxes      |
| Primary strength   | Explicit, auditable, deterministic recovery  | Flexible negotiation along unknown paths      |
| Primary cost       | Ad hoc coordination must return to the Graph | Implicit control flow and growing context     |

A workflow fits tasks with clear dependencies, structured outputs, long execution, and strong recovery requirements. Code scans, test matrices, data processing, and multi-stage research synthesis can all be modeled as operators and records.

A mailbox fits tasks whose next step depends on semantic discoveries, where roles must exchange findings, and where the plan cannot be enumerated in advance. Design discussions, cross-review, and open-ended investigations are closer to this kind of collaboration.

The real dividing line is not whether a system uses subagents. It is where coordination state lives:

```text
Maka:  coordination lives in the Graph
Codex: coordination lives in the Conversation
```

A Graph extracts the plan from model context and gives a deterministic system responsibility for advancing it. A Conversation preserves freedom to communicate and lets the plan emerge during execution. The former resembles a database execution engine; the latter resembles an Actor system.

This distinction also explains why Maka deliberately avoids conversations among subagents. It is not an assumption that agents cannot collaborate. It is a choice to compile collaboration into an explicit schedule: models provide semantic judgment, the Runtime owns execution facts, and the Coordinator advances dependencies.

Multi-agent scheduling is ultimately not a question of how many models to start. It is a classic systems question: how to represent state, carry dependencies, control concurrency, and still know what to do next after any executor disappears.

## Further Reading

- [Linux `fork(2)`](https://man7.org/linux/man-pages/man2/fork.2.html)
- [Apache DataFusion: Reading Explain Plans](https://datafusion.apache.org/user-guide/explain-usage.html)
- [Apache Arrow: Acero Overview](https://arrow.apache.org/docs/cpp/acero/overview.html)
- [The Go Programming Language Specification: Channel types](https://go.dev/ref/spec#Channel_types)
- [The Go Memory Model](https://go.dev/ref/mem)
- [Go Concurrency Patterns: Pipelines and cancellation](https://go.dev/blog/pipelines)
- [Codex `InputQueue` and mailbox](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/session/input_queue.rs#L66-L186)
- [Codex MultiAgent V2 message delivery](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs#L12-L127)
- [Codex mailbox-driven Turn scheduling](https://github.com/openai/codex/blob/8e6a44b428e31f91b21edc97904fcdf4f0931ade/codex-rs/core/src/tasks/mod.rs#L422-L508)
