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

# Log Is the Runtime: Managing Agent State and Context with Append-Only Logs

## From "Log Is the Database"

Building a long-running coding agent presents systems challenges that single-turn prompting rarely encounters. When a host process crashes midway through a task, how does execution recover reliably? If a tool partially modified the filesystem before dying, can it be retried safely without unintended side effects? When a test run outputs hundreds of thousands of tokens, how do we keep the next inference step from exceeding the model context window?

Distributed databases addressed similar problems long ago. In database engineering, **Log Is the Database** is a proven architectural principle: state at any point in time is fundamentally a deterministic function of a baseline state and the sequence of committed log records that followed:

```text
State(n) = Apply(State(0), Log[1...n])
```

Here, `Log[1...n]` represents the log committed through offset `n`, and `Apply` is the state transition function. Given identical initial states and the same ordered log records, every node converges to the same database state.

Production systems do not replay from genesis on every startup. Databases periodically capture a point-in-time snapshot, allowing crash recovery to load the snapshot and replay only the subsequent suffix:

```text
State(n) = Apply(Snapshot(k), Log[k+1...n])
```

Under this model, on-disk tables behave like materialized views over the log. They can lag, suffer corruption, or be rebuilt from scratch. As long as the snapshot and committed log suffix remain intact, node state can be reconstructed cleanly.

This principle dictates the write path. A mutation is not applied directly to data pages with a log written as an afterthought. It is first committed to the append-only log, and then deterministically applied to user-facing state:

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

The authoritative record is the committed log prefix. Tables, indexes, and caches are materialized projections derived from that log.

This marks a distinction from traditional write-ahead logging (WAL). In traditional single-node engines, data pages hold primary state, and WAL acts as an atomic recovery mechanism; once data pages reach disk and a checkpoint completes, older log segments can be reclaimed. In log-centric systems, the relationship is inverted: the committed log is the authoritative history, while table states are derived representations.

```text
Traditional WAL:
    Data State → Primary
    Log        → Recovery Record

Log-centric Database:
    Committed Log → Authoritative History
    Data State    → Materialized Result
```

Consistency splits into two deterministic parts: consensus protocols ensure all nodes agree on the log order, and deterministic state machines ensure identical log inputs produce identical application states.

## Log Is the Runtime

Applying this architecture to autonomous agents yields a direct parallel.

Large language models are stateless across invocations. They do not retain mutable, runtime-readable internal memory between execution steps. For every inference turn, the runtime must reconstruct context: user prompts, past tool invocations, environment results, and current task coordinates.

Agent state does not reside in a persistent model process. It is a deterministic projection materialized from historical facts before every model invocation:

```text
Agent State(t) = Project(RuntimeEvents[0...t], policy, runtime configuration)
```

This is the foundation of **Log Is the Runtime** in Maka: the `RuntimeEvent Log` serves as the immutable factual substrate of agent interactions, and agent state at any point in time is a policy-driven projection over that log.

A real execution history captures far more than conversational text:

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

Retaining only items 1 and 12 preserves an end-user transcript, but loses the operational state of the agent. The next decision depends on tool input parameters, execution results, request-response correlations, permission grants, and the strict order across all steps.

For this reason, Maka represents execution using typed `RuntimeEvent` records rather than simple `role + text` sequences:

```ts
type RuntimeEventContent =
  | Text
  | Thinking
  | FunctionCall
  | FunctionResponse
  | Error
```

Events also carry actions that drive runtime lifecycle transitions:

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

Every event is tagged with `sessionId`, `turnId`, `runId`, and `invocationId`, persisted to the SQLite `runtime_events` table, and assigned a monotonic `event_seq`. Maka reads history through immutable prefix windows bounded by a `highWater` mark:

```text
RuntimeEvents[1...highWater]
```

By computing a cryptographic digest over this prefix, crash recovery and continuation binding anchor to a verified segment of history rather than ambiguous mutable state.

A single committed `RuntimeEvent Log` yields distinct operational projections:

```text
                         ┌→ Session / UI
                         │
Runtime Event Log ───────┼→ Next Model Context
                         │
                         ├→ Run Terminal State
                         │
                         └→ Crash Recovery / Continuation
```

- `projectRuntimeEventsToStoredMessages()`: Transforms events into user-facing chat messages, tool execution cards, and turn statuses for the UI.
- `buildRuntimeEventModelReplayPlan()`: Assembles the prompt payload for the next inference call, stripping internal events (`modelVisibility: hidden`) and streaming chunks, while re-pairing function calls and preserving native reasoning blocks.
- `classifyRuntimeEventTerminalFact()`: Evaluates whether a Run concluded as completed, failed, or aborted.
- `buildContinuationReplayPlan()`: Determines which committed prefix can be handed off to a new Run following process restarts.

For tool recovery, Maka separates execution into durable dispatch and durable outcome boundaries. If a crash occurs between dispatch and outcome, recovery classifies the execution as pending reconciliation. When safety and idempotency cannot be proven, the runtime blocks continuation rather than executing an unsafe blind retry.

While host processes may crash and model contexts are reconstituted across distinct Runs, the factual record of what the agent observed, invoked, and completed remains reconstructible from the committed log.

## Compaction: Projections as Materialized Views

Append-only logs present a practical constraint: event logs grow indefinitely, whereas LLM context windows remain bounded.

Conflating inference context with execution history leads systems to truncate early messages and overwrite them with generated summaries. This permanently discards original history, complicating debugging, auditing, or re-evaluating tasks with larger models later on.

Maka separates canonical history from inference context. The `RuntimeEvent Log` remains strictly append-only; compaction only alters how subsequent inference queries read the log.

A prolonged interaction history is projected as a synthesized summary of early events followed by the verbatim recent suffix. Earlier intermediate tokens no longer burden inference, yet remain preserved in the underlying log.

Compaction checkpoints function like database materialized views: they are durable, computed projections designed to accelerate reads. If a checkpoint is lost or corrupted, it can be recomputed from raw events; if a discrepancy arises, the canonical log remains authoritative.

A reliable checkpoint must record the continuous event prefix it spans, its termination waterline, and an integrity digest of the source events. Rather than pruning scattered events based on arbitrary heuristics, compaction draws a clear waterline: everything preceding the waterline is summarized by the checkpoint, while events following it remain raw. New interactions continue appending at the tail, and subsequent compactions fold the previous checkpoint with the newly accumulated suffix.

Because summaries are lossy representations that influence future decisions, compaction projections must be verified and persisted durably before being exposed to the model. Generating a summary in memory and persisting it only after invoking the model risks creating an irrecoverable state split if a crash occurs mid-flight.

Preserving an append-only prefix also improves KV-cache reuse. When system prompts, tool schemas, and serialization formats remain stable, subsequent model requests append incremental tokens, reusing precomputed KV caches. Compaction resets the cache prefix once, but establishes a compact baseline that subsequent steps continue to build upon.

## Tool Result Prune: Bounded Context Offload

Even across short interactions, a single tool invocation can saturate an inference window. Reading large source trees, running test suites, or gathering multi-agent fan-out results can generate outputs spanning tens or hundreds of thousands of tokens. While the model needs full detail for the immediate step, carrying those large payloads into subsequent turns degrades latency and increases token cost.

Tool Result Pruning treats model context like operating-system working memory, offloading large payloads to backing storage.

When a tool produces an oversized payload, Maka writes the full result to persistent storage and replaces the payload in subsequent model requests with a lightweight placeholder. The placeholder records producing tool metadata, byte size, content hash, and an authorized access handle. The model recognizes that complete data exists and can query it when specific details are required.

In the current implementation, offloaded payloads are backed by the general-purpose `ArtifactStore`. Migration to a dedicated SQLite `ContextOffloadStore` with dedicated lifecycle management is planned under Issue #4071.

The retrieval path enforces bounded reads by separating inspection, structured querying, and paginated reading:
- **Inspect**: Evaluates high-level metadata and object schema.
- **Query**: Searches specific items or fields.
- **Paginated Read**: Streams bounded slices into context on demand.

To maintain recoverability, Maka adheres to an "archive first, placeholder second" sequence. The original payload is pruned from context only after the backing store confirms durable persistence and hash verification. If archival fails, the full result remains in active context, avoiding broken references.

Maka applies offloading across two operational horizons:
1. **Active Turn**: Oversized results are pruned immediately prior to the next reasoning step, allowing the model to explore data on demand.
2. **History Replay**: Recent tool invocations remain verbatim, while older, oversized payloads are projected as placeholders during context reconstruction.

Pruning affects only the projected view visible to the model. The canonical `RuntimeEvent Log` retains original tool outputs, ensuring subsequent history compaction summarizes real operational facts rather than placeholder markers.

History Compaction compresses along the temporal axis, folding older sequential turns into continuous semantic summaries. Tool Result Pruning offloads along the payload axis, moving oversized results into backing storage while preserving fine-grained event structure. Together, they keep inference fast and lean without sacrificing execution truth.

## Conclusion: Preserve Facts, Defer Representation

Maka's design follows a consistent rule: record what happened reliably, then decide how each consumer should read it.

The UI, model context, crash recovery, and task continuation all read from the same `RuntimeEvent Log`, but each uses a different projection. Compaction changes the resolution at which history is represented. Tool Result Pruning changes how large payloads enter the context. Neither requires rewriting facts that have already been committed.

Append-only history does not remove complexity. It moves complexity away from maintaining a mutable current state and into constructing appropriate views over stable history. The trade-off is continued log growth, versioned and verified projections, and lifecycle management for archived data. In return, the runtime gains clearer recovery boundaries, a more complete audit trail, and the ability to reinterpret history as models and context policies evolve.

For an agent runtime, state management is not about keeping the entire history inside the model forever. It is about preserving a complete, verifiable factual record and constructing a bounded, useful context before each inference step.

The model decides what to do next. The log ensures that the runtime can always reconstruct what has already happened. This is the practical meaning of **Log Is the Runtime**.
