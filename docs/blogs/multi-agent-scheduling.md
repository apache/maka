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

In multi-agent architectures, creating a subagent is often simplified as running multiple model instances in parallel. The true engineering bottleneck lies in the scheduling topology: what context a subagent inherits, who decomposes and dispatches tasks, how dependencies are expressed, how results are reliably handed off, how systems recover deterministically from failures, and whether concurrent agents require direct communication channels.

These trade-offs divide multi-agent systems into two distinct evolutionary paths.

The first path treats subagents as workflow operators: the main agent defines an execution graph, the scheduler advances steps based on explicit dependencies, and data artifacts flow unidirectionally along directed edges. The second path treats subagents as collaborative participants: each agent possesses an addressable identity and a private mailbox, coordinating via asynchronous message passing while the effective control flow unfolds across multi-turn conversations.

Maka implements the explicit workflow graph approach, whereas the Codex subagent architecture represents the message-driven pattern. Understanding these designs begins with examining how operating systems manage state branching efficiently during process creation.

## Copy-on-Write: Branching State on Mutation

In operating system design, Copy-on-Write (CoW) optimizes the cost of branching execution state. Linux threads share a single virtual address space by default, while classic CoW governs process creation during `fork()` system calls.

If `fork()` performed a deep physical memory copy immediately, child process instantiation costs would scale linearly with parent memory footprint. Child processes typically call `exec()` shortly after creation, discarding freshly duplicated memory pages before reading them.

Linux optimizes this by creating separate page tables whose entries initially map the same underlying physical frames. Upon `fork()`, the kernel assigns an independent virtual address space to the child, points corresponding page table entries at shared physical pages, and marks the private writable mappings as read-only:

```text
Parent virtual pages ──┐
                       ├──> shared physical pages
Child virtual pages ───┘
```

Both processes share physical pages during read-only access. When either process issues a write, the memory management unit (MMU) triggers a page fault. The kernel intercepts the fault, allocates a fresh physical frame, and grants write permissions to the mutating process:

```text
Before write

Parent ──┐
         ├──> Page A
Child ───┘

After child writes

Parent ─────> Page A
Child  ─────> Page A'
```

Copy-on-Write defers data duplication to the precise point of divergence. Branch creation incurs minimal metadata overhead, with total cost governed by actual mutation volume rather than total state magnitude.

This architectural principle maps directly to agent systems. A subagent can fork from the parent agent conversation history, sharing the initial context prefix while recording subsequent events to a private delta stream:

```text
Shared conversation prefix
             │
        ┌────┴────┐
        ▼         ▼
    Main delta  Child delta
```

However, model context differs fundamentally from physical memory pages. Parent conversation history may contain raw user prompts, intermediate assistant turns, tool diagnostic output, authorization events, and discarded trial paths. Unrestricted context inheritance passes historical noise, stale assumptions, and compounding token costs directly to child tasks.

Multi-agent architectures must therefore define the exact boundary and granularity of context propagation.

## Subagents as Task-Scoped Tools

Maka enforces a strict isolation boundary: subagents never automatically inherit the full conversation history of the parent agent.

When the main agent invokes `agent_spawn`, it must supply a self-contained task specification:

```text
agent_spawn({
  subagent_id: "local-reader",
  task: "Inspect how the storage package handles concurrent writes, citing files and symbols"
})
```

The runtime provisions an independent child session with its own conversation history, role instructions, bounded tool registry, permission scope, and workspace boundary. The child does not receive the parent's full conversation; its initial context combines runtime instructions with the explicit task specification, keeping unrelated parent history outside the child working set.

This contract requires the main agent to compile implicit conversational context into a standalone specification:

```text
Investigate concurrent write handling in packages/storage.

Provide answers for:
1. Which objects manage concurrency control;
2. How conflicts are detected;
3. Specific files and code symbols;
4. Perform read-only inspection without modifying files.
```

Maka eliminates ongoing conversational chatter between the main agent and its subagents:

```text
Main Agent  ── task ──>  Subagent
Main Agent  <── result ──  Subagent
```

No shared mailbox or intermediate negotiation protocol exists between the two tiers. The main agent decomposes high-level objectives, selects operators, and synthesizes final outcomes; subagents focus on localized task execution. Runtime execution events can be projected to the user interface for observability, serving as one-way telemetry rather than inter-agent dialogue.

From the caller perspective, a subagent adheres to standard tool semantics: it consumes structured input parameters, executes within assigned runtime boundaries, and returns terminal execution state, summary metrics, and artifact references:

```text
result = subagent(role, tools, task, workspace)
```

While this contract ensures scoped execution boundaries, it raises an architectural challenge: when subtasks possess complex causal dependencies without direct communication channels, the system requires a formal mechanism to represent and advance the global execution plan.

## DAGs: The Relational Engine Execution Model

Directed Acyclic Graphs (DAGs) provide a rigorous structural representation for multi-stage computation involving dependency constraints.

Flat sequential lists enforce total ordering (A, then B, then C). A DAG defines a partial order: directed edges enforce mandatory precedence constraints, while disconnected nodes execute with natural concurrency:

```text
A ───────> C

B ───────> D
```

Here, A must precede C, and B must precede D, while A and B share no temporal constraints. The scheduler avoids deriving an arbitrary global sequence, focusing exclusively on nodes whose incoming dependencies have been satisfied:

```text
Node  = Computational unit (Operator)
Edge  = Dependency constraint or data flow
Ready = All inbound preconditions satisfied
```

Relational database systems long ago decoupled declarative intent from physical execution. When a user submits a SQL statement, the query engine compiles an abstract Logical Plan:

```text
              Aggregate by region
                       │
                      Join
                  ┌────┴────┐
              Filter      Project
                │            │
          Scan orders  Scan customers
```

The logical plan models relational algebraic semantics. The query optimizer applies rule-based transformations such as predicate pushdown, column pruning, join reordering, and expression simplification while preserving output equivalence.

The Physical Planner subsequently translates logical operators into concrete engine implementations:

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

The physical plan selects join algorithms, partition layouts, target parallelism, and exchange operators. The same logical plan compiles into distinct physical plans based on dataset cardinality, cluster distribution, and memory allocations.

Once the physical plan compiles, the execution engine instantiates pipelines, manages memory pools, routes record batches, and handles completion, cancellation, errors, and backpressure signals.

Operators that consume and produce record batches in a streaming manner combine into execution pipelines:

```text
Scan ──batch──> Filter ──batch──> Project ──batch──> Sink
```

In contrast, sort operations, the build side of hash joins, or global aggregations must buffer full input streams before emitting records, forming pipeline breakers. The engine schedules pipeline execution dynamically based on readiness and available resource capacity.

Apache Arrow Acero provides a clean reference implementation: `Declaration` defines node configurations, `ExecPlan` and `ExecNode` represent physical execution topologies, and `ExecBatch` serves as the standardized unit of data passing along edges.

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

Relational engines demonstrate that a DAG functions primarily as an Intermediate Representation (IR), enabling systematic optimization, lowering, and deterministic scheduling.

## Maka Agent Graph: Declarative Planning and Engine Progression

Relational query engines produce deterministic physical plans prior to execution, whereas agent plans evolve dynamically based on runtime discovery.

Exploratory analysis uncovers unindexed code paths, intermediate builds shift validation requirements, and task failures require path recalculation rather than blind retries. Maka models the Agent Graph as a dynamically expanding DAG throughout the session lifecycle.

The architecture enforces a strict separation of operational concerns:

- **Main Agent:** Owns high-level goal decomposition and semantic decisions.
- **Coordinator:** Drives dependency resolution and topological convergence.
- **Supervisor:** Observes graph checkpoints and resumes semantic judgment when the workflow requires it.

### The Main Agent Writes Durable Intent

Only the main agent within the root session holds graph mutation capabilities. It registers operator definitions, schedules dependent work, deprecates historical branches, and selects final artifacts to close the graph; child sessions cannot mutate global topology.

The main agent records plan modifications via `update_agent_graph`. Independent nodes run concurrently, while dependent nodes explicitly reference committed upstream artifacts:

```text
Runtime review result ─┐
                       ├──> Synthesis work
Storage review result ─┘
```

This interaction commits Durable Intent: specifying newly provisioned work units, current input frontiers, targeted node deprecations, and terminal outcome selections.

Schedule mutations append to SQLite as immutable revision records marked with session, run, turn, and call identifiers. Even if the host process terminates unexpectedly, committed execution plans remain fully preserved in durable storage.

### The Coordinator Acts as a State Reconciler

The Coordinator avoids retaining authoritative in-memory graph objects. Every reconciliation cycle reconstructs baseline truth directly from durable storage:

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

The Coordinator folds committed revision logs into the current plan snapshot, constructs the operational topology from registered operators, and correlates completed `RuntimeEvents` to evaluate node readiness:

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

Maka uses an event-driven single-flight driver rather than a fixed-interval database polling loop. New schedule commits, child completion events, or host recovery routines trigger reconciliation; a single driver instance runs per graph, coalescing concurrent wakeups into subsequent iterations.

### SQLite Serves as the Control Plane

The Agent Graph layer avoids duplicating core agent runtime capabilities. SQLite acts purely as the control plane for scheduling facts, while model sampling, tool execution, permission arbitration, cancellation, and event logging remain delegated to the established Session Runtime.

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

Child sessions function as stable operator containers, while `AgentRun` represents an individual execution lifecycle. Downstream graph nodes consume committed result records backed by runtime events, rather than treating every `RuntimeEvent` as graph input.

### Claims Decouple Readiness from Execution Admission

Because the Coordinator reconstructs plan snapshots on every cycle, identical nodes can evaluate as ready across multiple reconciliation passes. Triggering model calls immediately upon detecting readiness risks duplicate executions during retries or transient scheduling jitter.

Maka requires writing a conditional claim to SQLite before execution begins, binding ready work to an allocated operator, session, turn, and run identity:

```text
ready intent
     │
     ▼
conditional claim
     │
     ├── already exists ──> inspect or recover the same Run
     └── new claim ───────> execute the allocated Run
```

Readiness evaluation remains a reproducible, side-effect-free projection, whereas execution admission commits as an atomic, durable fact.

### The Supervisor Restores Semantic Judgment at Checkpoints

Deterministic Coordinators excel at dependency management, yet cannot replace language models for high-level semantic arbitration: resolving contradictions between reports, deciding whether to retry or replace failing components, or altering strategic direction. Strategic judgment remains reserved for the main agent.

After writing a schedule update, the main agent concludes its current supervisor turn. The Coordinator drives the execution graph asynchronously; once the graph reaches a durable checkpoint, the host environment wakes the main agent into a fresh supervisor turn:

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

The main agent inspects bounded graph snapshots and committed child outputs, scheduling subsequent work units, pruning obsolete branches, or marking the graph complete.

This lifecycle combines two complementary capabilities: the main agent provides semantic decomposition and synthesis, while the Coordinator enforces transaction durability, topological planning, concurrency control, and fault tolerance.

## Go Channels: Communication as Scheduling

DAGs excel at modeling macro-level dependencies, yet runtime scheduling requires low-level primitives for task suspension, wakeup notifications, and backpressure. The Go concurrency model provides a classic systems perspective on communication-driven coordination.

A goroutine is a lightweight execution unit scheduled by the Go runtime. The G-M-P scheduler multiplexes thousands of application goroutines across a small pool of operating system threads: G represents the goroutine, M represents an OS thread, and P represents logical processor resources required to execute Go code.

Goroutines provide cost-effective concurrency, while channels establish structured communication contracts between them.

### Unbuffered Channels as Rendezvous Points

```go
handoff := make(chan Result)
go func() { handoff <- result }()
received := <-handoff
```

An unbuffered channel requires both sender and receiver to be ready before data transfers. The sender blocks until a receiver arrives, and the receiver blocks until a value is available. The send and receive operations therefore form a synchronization point between the two goroutines.

The Go memory model establishes strict happens-before guarantees for channel operations. The receiver observing a transmitted value is guaranteed to observe all memory writes performed by the sender prior to the send operation. A single channel transmission combines multiple coordination primitives:

```text
value transfer + scheduling point + memory ordering
```

### Buffers Regulate Decoupling Capacity

```go
jobs := make(chan Job, 32)
```

A buffered channel allows producers and consumers to decouple within a bounded capacity. As long as slots remain available, send operations complete without blocking; once the buffer fills, the producer suspends, propagating backpressure upstream.

Buffer capacity determines the maximum lead a producer may hold over a consumer. Tight limits restrict throughput smoothing, while excessive buffers accumulate obsolete work, elevate memory pressure, and conceal downstream degradation.

### Multiplexing and Lifecycle Signaling

Go provides the `select` statement to allow a goroutine to monitor multiple channel events simultaneously:

```go
select {
case job := <-jobs:
    return handle(job)
case <-ctx.Done():
    return ctx.Err()
}
```

The `select` construct functions as a declarative scheduling interface: the worker declares event dependencies, and the runtime awakens it when any condition resolves.

The `close(ch)` primitive broadcasts lifecycle termination across all readers. Upon closure, receivers drain remaining buffered items, after which `value, ok := <-ch` signals that the channel has terminated. All receivers blocked on an empty closed channel can observe this terminal state.

A nil channel never resolves. Dynamically setting a channel reference to nil inside a `select` block cleanly disables a specific branch without altering the outer loop structure, forming a compact state machine.

### Cancellation Propagation in Pipelines

Multiple execution stages connect via channels to form processing pipelines, expanding into fan-out and fan-in topologies. However, if downstream stages exit prematurely, uncoordinated upstream producers block indefinitely on send operations, leaking goroutines.

```go
select {
case out <- result:
case <-ctx.Done():
    return
}
```

Any blocking communication site that may outlive its downstream consumer needs an explicit cancellation path so workers can terminate cleanly and release resources.

Go channels integrate data passing with scheduling semantics: a single communication primitive handles data transport, dependency signaling, synchronization, and backpressure:

```text
communication = dependency + synchronization + backpressure
```

This model inspires an alternative multi-agent coordination pattern: provisioning private inboxes for individual agents, allowing message delivery to act as the primary scheduling mechanism.

## Codex Subagents: Mailbox-Driven Collaboration

Codex applies message-driven coordination to its subagent architecture. While preserving parent-child task delegation, it models each agent as an actor addressable within a root task tree, with dedicated conversation history and asynchronous communication through private mailboxes.

Agents within the same root task tree share a hierarchical addressing namespace:

```text
/root
├── /root/runtime_review
├── /root/storage_review
│   └── /root/storage_review/query_analysis
└── /root/test_runner
```

This architecture closely mirrors the classic Actor model:

```text
Actor identity   = AgentPath
Actor state      = Thread history
Actor mailbox    = Session InputQueue
Actor activation = Turn
```

### Private Mailbox Queues per Session

The Codex Core `InputQueue` decouples payload storage from wakeup notifications:

```rust
struct InputQueue {
    activity_tx: watch::Sender<InputQueueActivity>,
    mailbox_pending_mails: Mutex<VecDeque<PendingMailboxCommunication>>,
}
```

An in-memory `VecDeque` preserves FIFO message ordering while the session is resident, while a Tokio `watch` channel transmits change notifications to waiting schedulers. Wakeup signals may coalesce safely because pending payloads remain in the queue; this queue does not itself imply durable persistence.

This design avoids competitive worker claim patterns. Each session owns a dedicated mailbox, and every `InterAgentCommunication` payload specifies author, recipient, content, and a turn trigger flag (`trigger_turn`) prior to dispatch.

### Messages Convey Scheduling Intent

Codex V2 differentiates message delivery into two scheduling tiers:

```text
send_message   = QueueOnly
followup_task  = TriggerTurn
```

The `send_message` operation enqueues the payload without forcing an immediate wakeup. Active recipients inspect incoming messages at their next reasoning boundary; idle recipients hold messages until subsequent conversational turns activate them.

The `followup_task` operation marks `trigger_turn = true`. If the recipient is idle, the task scheduler immediately provisions a new turn to process the payload.

```text
                    InterAgentCommunication
                              │
                   ┌──────────┴──────────┐
                   │                     │
          trigger_turn = false  trigger_turn = true
                   │                     │
              queue message        wake idle Agent
```

A message transmission simultaneously conveys conversational information, destination addressing, and execution scheduling intent.

### Controlled Message Ingestion at Model Boundaries

External messages do not interrupt in-flight LLM sampling requests. New arrivals queue in the mailbox, merging into the conversation context when the active turn completes and constructs the next model request:

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

Codex regulates ingestion via `MailboxDeliveryPhase`. Pending messages drain into context during early turn phases; once the runtime records a final user-visible response, late-arriving messages defer to subsequent turns, preventing external inputs from altering finalized outputs.

### Task Completion Delivered as Structured Messages

Codex attaches a completion watcher to child sessions. When a child reaches terminal state, the watcher constructs an `InterAgentCommunication` payload from child to parent, depositing it into the parent mailbox.

The completion message sets `trigger_turn = false`. Results enter the parent inbox as factual events rather than disruptive interrupts, preserving parent reasoning continuity.

The `wait_agent` tool waits on parent mailbox activity instead of returning a child result directly:

```text
wait_agent
    │
    ├── new mail ─────> wake
    ├── user steer ───> interrupt wait
    └── deadline ─────> timeout
```

The tool coordinates suspension and wakeups, while message content remains buffered within the mailbox until the turn loop incorporates it into model context.

### Conversational Workflow Evolution

DAG systems compile execution dependencies into explicit topological edges, whereas mailbox architectures express workflows through dynamic message exchanges:

```text
Root ──task──────> Agent A
Root ──task──────> Agent B
Agent A ──note───> Agent B
Agent B ──result─> Root
Root ──follow-up─> Agent A
Agent A ──result─> Root
```

Agent A shares findings with concurrent Agent B immediately, while the root agent injects steering constraints during child execution. Workflows evolve organically through conversation rather than requiring static upfront definition.

This flexibility introduces architectural trade-offs: control flow distributes across message histories. Explaining strategic adjustments requires reconstructing full mailbox absorption traces, and evaluating task readiness cannot be determined from topological graph degrees alone.

The Codex architecture combines root-scoped parent-child delegation with actor-style private mailboxes to form a collaborative coordination layer.

## Architectural Trade-offs: Workflow Scheduling and Message Collaboration

Maka and Codex support subagent delegation, concurrent execution, and iterative follow-ups, but diverge fundamentally in their underlying systems primitives.

| Dimension                | Maka Workflow Architecture                  | Codex Mailbox Architecture                                         |
| ------------------------ | ------------------------------------------- | ------------------------------------------------------------------ |
| **Core Abstraction**     | Operators and edges within a DAG            | Agents addressable within a root task tree, with private mailboxes |
| **Task Emission**        | Main agent writes schedule revisions        | Parent spawn or peer follow-up messages                            |
| **Scheduling Driver**    | Coordinator evaluates node readiness        | Message queuing, `trigger_turn`, and agent state                   |
| **Data Propagation**     | Structured records pass along edges         | Message payloads inject at turn boundaries                         |
| **Peer Communication**   | No direct child-to-child channel is exposed | Supported within the root task tree via direct message passing     |
| **Global Observability** | Reconstructible from graph snapshots        | Aggregated across distributed mailboxes                            |
| **Primary Strength**     | Explicit topology, deterministic recovery   | Dynamic negotiation, exploratory adaptability                      |
| **Primary Trade-off**    | Plan revisions require graph mutations      | Implicit control flow, context expansion risks                     |

The workflow architecture excels in scenarios featuring defined dependencies, structured artifacts, prolonged execution spans, and rigorous crash recovery requirements. Static code analysis, automated test suites, data pipelines, and multi-stage research synthesis map cleanly to operators and record streams.

The mailbox architecture fits exploratory tasks where subsequent steps depend on semantic discovery, roles exchange continuous feedback, and execution paths resist upfront enumeration. Architectural deliberations, collaborative code reviews, and open-ended investigations align naturally with conversational messaging.

The fundamental divergence lies in where coordination state resides:

- **Maka:** Coordination lives in the Graph.
- **Codex:** Coordination lives in the Conversation.

The Agent Graph extracts execution plans from model context, delegating progression to a deterministic system engine. The mailbox approach preserves conversational flexibility, allowing coordination to emerge dynamically. The former resembles relational database execution engines, while the latter reflects classic Actor concurrency systems.

This clarifies Maka design choice regarding subagent isolation: it compiles collaboration into transparent, auditable scheduling graphs. Models provide semantic reasoning, the runtime records execution ground truth, and the Coordinator advances data dependencies deterministically.

Multi-agent scheduling ultimately addresses foundational distributed systems challenges: modeling state, passing dependencies reliably, bounding concurrency, and ensuring predictable forward progress when individual workers terminate.

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
