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

[简体中文](./log-is-the-runtime.zh-CN.md)

# Log Is the Runtime: How Maka Uses an Append-Only Log to Manage Agent State and Context

## Log Is the Database

**Log Is the Database** is not a metaphor. It is a data model used by real distributed databases: the state of a database at any point in time can be recomputed from an earlier state and the committed log that follows it.

In its simplest form:

```text
State(n) = Apply(State(0), Log[1...n])
```

`Log[1...n]` is the committed log through position `n`, and `Apply` is the database's state transition function. Given the same initial state and the same log entries in the same order, every node should arrive at the same database state.

Real systems do not replay from the first log entry on every startup. As the log grows, the database periodically takes a snapshot of its complete state at a known log position. Recovery loads that snapshot and replays only the suffix:

```text
State(n) = Apply(Snapshot(k), Log[k+1...n])
```

A node's local database is therefore not an irreplaceable original. It is closer to a computed result: it may lag, become corrupt, or be deleted entirely. As long as the snapshot and the committed log after it remain available, the node's state can be reconstructed.

This also determines the write path. A write does not first modify the database and then leave a log entry as an afterthought. It first becomes a log record. Only after that record is replicated and committed does the state machine apply it to the database:

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

The authoritative object is not the set of pages currently held by one node. It is the committed log prefix. Tables, indexes, caches, and local storage files are materialized results of applying that prefix.

This is the most important difference between a log-centric database and the conventional view of a write-ahead log.

In a traditional database, the WAL is primarily a recovery mechanism. It provides local transaction atomicity and durability. Once changes have safely reached data pages and a checkpoint has completed, older WAL records can usually be reclaimed. In this model, data pages hold the primary state and the log exists to recover them.

In a log-centric database, the relationship is reversed:

```text
Traditional WAL:
    Data State → Primary
    Log        → Recovery Record

Log-centric Database:
    Committed Log → Authoritative History
    Data State    → Materialized Result
```

This does not mean the system must retain every entry since genesis forever. Snapshots, checkpoints, and log compaction are still necessary engineering tools. The important question is what defines the evolution of database state—and what determines whether two replicas contain the same database.

For a log-centric system, the answer is not to compare two sets of local files. It is to ask whether both nodes hold the same committed log and whether they have applied it through the same position.

Database consistency can therefore be split into two concrete questions:

```text
Do all replicas agree on the same log?
Does the same log produce the same state?
```

Replication and consensus protocols answer the first question. A deterministic state machine answers the second.

That is the most direct meaning of **Log Is the Database**: the log is not a record left behind after the database runs. The log is the input to database state, and the database we query is the result computed at a particular position in that input.

## Log Is the Runtime

Apply the same idea to agents and a similar conclusion follows.

An LLM does not hold durable, runtime-readable state that advances continuously with a task. Every time the Runtime calls the model, it must tell the model again what the user said, what the model previously did, which tools it called, what those tools returned, and how far the task has progressed.

The agent's “state” is not hidden inside a model process that stays alive forever. The Runtime reconstructs that state from historical facts before every model call.

```text
Agent State(t) = Project(RuntimeEvents[0...t], policy, runtime configuration)
```

This is how Maka carries **Log Is the Database** into an agent runtime. The Runtime Event Log is the fact space of agent interaction. The state of the agent at a particular moment is a projection of that log under a particular policy.

Such a log clearly cannot contain only chat text. A real agent execution may look like this:

```text
1. User: Fix the failing tests in this project
2. Model: Call Grep to search the relevant code
3. Tool: Return the search results
4. Model: Call Read to inspect a file
5. Tool: Return the file contents
6. Model: Call Edit to modify the file
7. Runtime: Request a broader sandbox permission
8. User: Approve
9. Tool: Return the edit result
10. Model: Call Bash to rerun the tests
11. Tool: Return the test results
12. Model: Produce the final answer
13. Runtime: Mark the Run completed
```

If we save only entries 1 and 12, we have preserved a conversation, not the execution state of an agent. The agent's next action also depends on tool arguments and results, call/result correlation, permission decisions, terminal status, and the order of all those facts.

That is why Maka does not represent history as a simple `role + text` sequence. A `RuntimeEvent` may contain:

```ts
type RuntimeEventContent =
  | Text
  | Thinking
  | FunctionCall
  | FunctionResponse
  | Error
```

An event may also carry actions that affect Runtime control state:

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

Every event also carries a `sessionId`, `turnId`, `runId`, and `invocationId`. Together, these identities answer four different questions: which long-running interaction does this belong to, which user-visible turn is this, which concrete execution attempt produced it, and which model/tool invocation contains this activity?

Events are written to the SQLite `runtime_events` table and receive a monotonically increasing `event_seq` within an invocation. When Maka reads an execution history, it does not load a mutable “current message list.” It reads an immutable prefix through a known position:

```text
RuntimeEvents[1...highWater]
```

The high-water mark matters. It turns “I recovered this execution” into a verifiable statement: recovery must say exactly which event it read through rather than continuing from a vague and potentially changing notion of “latest.” Maka can also digest the immutable prefix, binding a continuation to one exact history instead of to an ambiguous Session.

The same Runtime Event Log can produce several different kinds of state.

`projectRuntimeEventsToStoredMessages()` projects the messages, tool activity, and Turn state displayed by the UI. `buildRuntimeEventModelReplayPlan()` projects the model history accepted by the next provider call. `classifyRuntimeEventTerminalFact()` determines whether a Run completed, failed, or was aborted. `buildContinuationReplayPlan()` decides which history can safely be handed to a new Run after a process failure.

```text
                         ┌→ Session / UI
                         │
Runtime Event Log ───────┼→ Next Model Context
                         │
                         ├→ Run Terminal State
                         │
                         └→ Crash Recovery / Continuation
```

These projections may apply different selection rules, but they cannot invent their own facts.

The model, for example, does not need to see every Runtime control event. The model-history projection skips events marked `modelVisibility: hidden`, does not turn terminal facts into chat messages, and never replays transient streaming chunks. It also pairs function calls with their responses and preserves provider-native semantics such as signed thinking when the provider supports them.

The UI makes a different selection. It needs to display text, thinking, tool activity, permission state, and errors, but it should not render an internal tool-dispatch recovery fact as a chat message.

Model context is therefore not history, and neither is the UI transcript. They are two ways of reading the same Runtime Event Log.

This distinction becomes essential for long-running agents. A model's context window is finite; an agent's execution history can keep growing. Maka must preserve complete history while still allowing the next inference to read a bounded context.

Replay also needs a precise boundary.

Replaying the Runtime Event Log does not mean executing every tool again, nor does it reproduce the exact neural state of the model's hidden layers. Maka provides semantic replay: at a known event boundary, it reconstructs the content exchanged by the user and model, tool calls and results, permissions, and terminal state, then uses those facts to build the UI, model context, and recovery decisions.

If a tool crossed a side-effect boundary but left no result, Maka does not blindly retry it simply because replay found a function call. Tool execution is divided into durable dispatch and outcome boundaries. A crash between them must be classified as unknown or in need of reconciliation. When safety cannot be proven, continuation is blocked rather than assuming that the tool never ran.

**Log Is the Runtime** does not claim that a log can reproduce the entire physical world. It makes a narrower and more useful guarantee:

> A process may disappear, the UI may be rebuilt, model context may be selected again, and a new Run may take over execution. But what the agent observed, which calls it made, which results it received, and where execution ended must remain reconstructible from the committed Runtime Event Log.

For a database, the log replays data state. For Maka, the log replays the state space from which the agent can continue acting.

## Compaction Is Only a Projection

Append-only history creates an immediate tension: history keeps growing, but the model's context window does not.

If context and history are treated as the same thing, there is an obvious response: delete the earliest messages and overwrite them with a summary. The context becomes shorter, but the history has now been rewritten permanently. Recovery, auditing, debugging, or revisiting the task with a larger model can access only the lossy summary.

Maka separates the two concerns. The Runtime Event Log remains append-only; compaction changes only how the next inference reads it.

A long history can be projected as a summary of early events followed by recent events in their original form. Older model responses and Tool Results stop consuming tokens in the next inference, but they remain in the source log. Context is compacted; history is not.

> Context is not history.

A compaction checkpoint is much like a materialized view in a database. It can be durable and can serve as the fast path for most reads, but it remains a computed result over source data. The authority test is straightforward: if the checkpoint is lost, it can be rebuilt from the log. If the checkpoint disagrees with the log, discard the checkpoint and return to raw history—not the other way around.

This is why a reliable checkpoint must preserve more than summary text. It must identify the continuous history it covers, the event boundary where that coverage ends, and whether the source still matches the source used to create the summary. Only then can the Runtime know that it is replacing a known prefix with a projection rather than injecting an untraceable summary into model context.

The continuous prefix is especially important. Compaction does not remove scattered pieces that happen to look unimportant. It draws an explicit waterline in an ordered log: the checkpoint represents everything before the waterline, while events after it remain raw. New facts can continue to append at the tail. The next compaction needs to fold only the previous checkpoint and the newly grown suffix instead of reinterpreting the entire Session.

Of course, saying “compaction is only a projection” does not mean that compaction has no effect on agent behavior.

A database index generally should not change query results. An agent summary, however, is inherently lossy. A model given full history may make a different next decision from a model given compacted context. Compaction does not change the past, but it changes the state visible to the model as it generates the future.

“Only” describes authority, not importance. A checkpoint has no authority to rewrite history, but it participates in determining how history grows next. A new projection should therefore be validated, made durable, and only then given to the model. Generating a summary in memory, sending it to the model, and persisting it afterward creates an unrecoverable fork: after a restart, the Runtime knows what the model produced but cannot know which version of history the model saw.

Append-only history also has a practical benefit: higher KV-cache prefix hit rates. An agent task may call a model many times. As long as the system prompt, tool definitions, and serialization remain stable, the next request usually appends new model output, Tool Calls, and Tool Results to the previous history. The provider can reuse the long token prefix it has already computed.

Compaction deliberately breaks the old prefix once, but it also establishes a shorter new prefix anchor. As long as that checkpoint remains stable, subsequent events append after it and the new KV-cache prefix can be reused. Compaction is therefore not continuous context rewriting. It occasionally establishes a new read point for an ever-growing log.

This is Maka's choice between append-only history and finite context: history always moves forward; compaction does not delete it, but decides where and at what resolution the model continues reading it.

## Tool Result Prune Is Context Offload

Even without a long history, a single Tool Call can fill a model's context window.

Reading a large file, searching an entire repository, running tests, fetching a web page, or waiting for a group of child agents can produce tens or hundreds of thousands of tokens. The model may need those details for one step, but repeatedly carrying the full Tool Result into every later inference is usually expensive and unnecessary.

Tool Result Prune does not answer “should this history still exist?” It answers “must this large object remain resident in the model's working memory?”

Maka first writes the complete Tool Result to a separate context-offload store, then replaces the original body in the next model request with a small placeholder. The placeholder retains the producing tool, original size, content digest, and a readable address. The model knows that a complete result exists and how to retrieve it when details become relevant.

“External” here means external to model context, not necessarily remote. Maka remains local-first: the offload store is a Runtime-managed layer of durable local storage outside the finite context window.

Pruning is therefore closer to operating-system swap or demand paging than deletion. The context window is expensive working memory, the offload store is larger backing storage, and the placeholder is the page-table entry left in the working set. The difference is that page-in is explicit rather than transparent. The model can inspect the archive's structure and metadata, query one item, or read a bounded page instead of loading the whole object back into context.

That read path must be bounded. Otherwise a hundred-thousand-token result would be pruned only for one archive read to inject all hundred thousand tokens again. Maka separates inspect, query, and paginated read: first show the model what the archive contains, then retrieve only the portion needed for the current inference.

The most important ordering rule is simple: archive first, placeholder second.

A placeholder that says only “result omitted” has no recovery value. The Runtime can remove the original from model context only after the complete body has been written successfully and the reference, content hash, byte count, and Session identity all match. If archival fails, the correct behavior is to keep the complete Tool Result rather than save tokens by creating a dangling pointer.

Reads cannot blindly trust an address returned by the model either. An archive belongs to the Session that created it, and its contents must match the hash and size stored in the placeholder. This makes the placeholder a capability for one exact object, not a path that can be used to browse arbitrary local data.

Maka applies this offload at two time scales.

Within the active Turn, a tool may produce a large result just before the next step. The Runtime can move it out of the active context so that the model sees a reference in the next inference and decides whether to inspect its structure, read a portion, or leave it unloaded.

During history replay, recent Tool Results remain complete while older oversized results become placeholders. The Session retains a relatively complete recent working set and moves older, less frequently accessed results to a cheaper storage tier.

Both forms of pruning affect only the provider-visible projection. The original Tool Result remains in the canonical Runtime Event Log, and later history compaction still reads the original event rather than the placeholder. Otherwise the summary would describe “some content was omitted” instead of what the agent actually observed.

Tool Result Prune and History Compaction both reduce context, but they solve different problems.

History Compaction folds a continuous span of history into a lower-resolution semantic summary. Tool Result Prune preserves the event structure and moves only an oversized payload out of the hot working set. The first changes the resolution at which the model reads history; the second changes the storage tier of a large object.

Together they form a tiered memory system for agents. The newest and most relevant facts remain directly in context. Large but potentially useful Tool Results are available by reference and loaded on demand. A checkpoint preserves continuity across older history. The complete execution facts remain in the append-only log.

That is the central boundary in Maka's context management: context may be compacted, paged, and projected again—but saving tokens should never require pretending that something which happened never happened.
