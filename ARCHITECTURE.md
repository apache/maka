[中文](./ARCHITECTURE.zh-CN.md)

# Maka Backend Architecture

> This is the entry point for Maka Agent backend architecture. It does not repeat each deep-dive article. It establishes the system spine and helps readers reach the right chapter by engineering question. The current series covers Runtime, tools and context, durable Headless tasks, Self-check, the AHE self-iteration boundary, Graph scheduling over child Sessions, and crash-safe Runtime continuation.

## Architecture in one sentence

Maka is a **log-first, projection-driven** Agent Runtime. Execution facts enter append-only logs; Session state, model context, TaskRun, Self-check, and evolution evidence are projections of those facts for different consumers.

```mermaid
flowchart LR
    U["Desktop / CLI / Bot / Gateway"] --> S["SessionManager"]
    S --> R["AgentRun + Runtime Runner"]
    R --> T["Tool Runtime"]
    R --> L["Runtime Event Log"]
    R --> H["Headless Task Event Log"]
    T --> L
    S --> G["Agent Graph Control Plane"]
    G --> R

    L --> C["Provider Context Projection"]
    L --> V["Session / UI Read Models"]
    L --> X["Crash Recovery / Continuation"]
    L --> GP["Graph Records / Client Projection"]
    GP --> G
    L -. "trajectory refs" .-> H

    H --> P["TaskRun Projection"]
    P --> K["Bounded Self-check"]
    P --> E["AHE Evidence Export"]
    E --> A["External Evolution Loop"]
```

Read left to right. Entry points hand user intent to Runtime; model and tool execution produce facts; those facts are projected into model context, interactive views, crash-recovery decisions, Graph scheduling inputs, durable task state, and evolution evidence. Graph coordinates child Sessions from durable schedule metadata but sends execution back through the same Runtime. Providers, concrete storage implementations, and UI components are omitted so the diagram can preserve the backend spine shared by this series.

## A four-layer mental model

### 1. Execution facts

An Agent Run produces model messages, Tool Calls, Tool Results, permission decisions, and termination facts. Runtime Event Log is the canonical source for those interaction semantics except hosted permission answers: InteractionStore is their canonical authority, while the Runtime ledger stores only answer identity and audit facts. The embedded/legacy path retains its existing decision-event semantics. Context pruning and Compaction may change what the model sees next, but cannot rewrite facts that already occurred.

Relevant chapters: 1, 2, 3, and 8.

### 2. Coordinated Agent work

When dependent Agent work benefits from dynamic topology, Graph treats child Sessions as operator containers, Session-inline AgentRuns as activations, and committed RuntimeEvents as reference-only records. SQLite owns schedule, topology, admission, and supervisor-wake metadata; Runtime keeps execution authority. The main Agent stays beside the graph to observe, intervene, and synthesize without gating normal record delivery.

Relevant chapter: 7.

### 3. Durable tasks

When a task outlives one Turn or process, Headless uses an independent task identity, Task Event Log, and TaskRun projection to preserve progress across Attempts. Self-check provides bounded feedback inside that task loop but does not own final fact authority.

Relevant chapters: 4 and 5.

### 4. Evolution

AHE organizes outcomes and traces from multiple TaskRuns into evolution evidence bound to target identity. It remains outside the interactive Runtime and advances system changes through a constrained change surface, falsifiable manifests, candidate evaluation, and rollback lineage.

Relevant chapter: 6.

## Eight-chapter index

| Chapter | Core question | Implementation status | Read |
|---|---|---|---|
| 1. Log Is the Runtime | How does Maka preserve and replay the state space of an Agent Run? | Current | [English](./docs/architecture/runtime-core-architecture-draft.md) · [中文](./docs/architecture/runtime-core-architecture-draft.zh-CN.md) |
| 2. Evidence Before Compression | How can a large Tool Result leave Turn-level evidence without exhausting active context? | Current + Target | [English](./docs/architecture/turn-evidence-tools-active-prune-draft.md) · [中文](./docs/architecture/turn-evidence-tools-active-prune-draft.zh-CN.md) |
| 3. Compaction Is a Projection | How can the LLM forget old context without losing historical facts? | Current | [English](./docs/architecture/llm-compaction-events-log-projection-draft.md) · [中文](./docs/architecture/llm-compaction-events-log-projection-draft.zh-CN.md) |
| 4. The Durable Task Loop | How does Maka continue a task that outlives a Turn, Run, or process? | Current + Target | [English](./docs/architecture/durable-task-loop-headless-draft.md) · [中文](./docs/architecture/durable-task-loop-headless-draft.zh-CN.md) |
| 5. Self-Check Is Not Self-Trust | How can an Agent inspect and repair its work without turning self-report into authority? | Current + Target | [English](./docs/architecture/self-check-bounded-feedback-loop-draft.md) · [中文](./docs/architecture/self-check-bounded-feedback-loop-draft.zh-CN.md) |
| 6. Self-Iteration Happens Outside the Runtime | How does Maka turn run experience into falsifiable and reversible system improvement? | Current + Target | [English](./docs/architecture/ahe-self-iteration-boundary-draft.md) · [中文](./docs/architecture/ahe-self-iteration-boundary-draft.zh-CN.md) |
| 7. Graph Is a Schedule, Not a Second Runtime | How does Maka coordinate dynamic dependent Agent work while the main Agent supervises beside the data path? | Current | [English](./docs/architecture/agent-graph-stream-scheduling-draft.md) · [中文](./docs/architecture/agent-graph-stream-scheduling-draft.zh-CN.md) |
| 8. Resume Is Not Retry | How does Maka recover crash facts, avoid duplicate side effects, and create a provably safe new execution? | Current + Target | [English](./docs/architecture/runtime-resume-architecture.md) · [中文](./docs/architecture/runtime-resume-architecture.zh-CN.md) |

**Current + Target** means the article covers verified implementation and visibly labeled target direction. It does not mean Target sections are implemented. The `implementation_status` and `last_verified` fields in each article's front matter are the more precise status source.

## Choose a reading path by problem

### Entering Runtime for the first time

Read `1 → 2 → 3 → 8`. Start with the fact log, then learn the tool-evidence and context projections that recovery later consumes. Finish with crash repair and safe continuation.

### Changing Tools, Context, or Compaction

Read `1` for the canonical-fact boundary, then `2 → 3`. Add `8` when the change affects T1/T2, recovery, or continuation, and add `4` when it affects evidence consumed by durable tasks.

### Changing crash recovery, durable Tool boundaries, or workspace continuity

Read `1 → 8`. Chapter 1 establishes RuntimeEvent and AgentRun authority; Chapter 8 explains startup repair, T1/T2, RecoveryResolver, safe-boundary continuation, and the Phase 3–4 workspace path. Add `4` for Headless Attempt recovery and `7` when recovery affects Graph activations or supervisor wakes.

### Changing Headless or task recovery

Read `1 → 8 → 4 → 5`. Chapter 8 separates Runtime continuation from Attempt retry and workspace restore. Chapter 3 adds context recovery, while Chapter 2 adds the Tool Result evidence boundary.

### Changing Self-check or completion conditions

Read `4 → 5`, then revisit Chapter 2's rule that context pruning must not delete evidence.

### Changing AHE or self-iteration

Read `1 → 4 → 5 → 6`. Chapter 6 depends on the Event Log, TaskRun projection, and authority boundaries established earlier.

### Changing Graph, child Sessions, or multi-Agent scheduling

Read `1 → 7`. Chapter 1 establishes RuntimeEvent and AgentRun authority; Chapter 7 explains how Graph projects those facts into records, binds operators to child Sessions, linearizes schedule and admission in SQLite, and returns control to the root supervisor Agent. Add `2 → 3` when changing how child output is retrieved or compacted.

## Code boundaries

| Area | Primary responsibility |
|---|---|
| `packages/core` | Pure contracts for Session, Runtime Event, AgentRun, and permission |
| `packages/storage` | Durable stores for sessions, settings, run ledgers, and the SQLite metadata control plane |
| `packages/runtime` | SessionManager, AgentRun, model adapters, tool execution, context, recovery, and Graph reconciliation |
| `packages/headless` | TaskRun, Autonomous Loop, Self-check, result export, and AHE protocol |
| `apps/desktop/src/main` | Electron main-process composition, IPC, and product-entry adapters |

The “code map” in each deep-dive article is the preferred implementation entry point. Earlier design and evolution material remains available in:

- [`docs/archive/runtime-kernel.md`](./docs/archive/runtime-kernel.md)
- [`docs/archive/runtime-v2-architecture-evolution.md`](./docs/archive/runtime-v2-architecture-evolution.md)
- [`docs/archive/runtime-v2-implementation-notes.md`](./docs/archive/runtime-v2-implementation-notes.md)

Those documents provide historical design context and implementation notes. The eight chapters indexed here are the narrative entry point for current backend mechanisms.

## Documentation layout

`docs/architecture/` remains flat. One mechanism owns one stable slug: the default `.md` file is English and `.zh-CN.md` is its Chinese counterpart. While the collection is still easy to scan, avoiding another `chapters/` level keeps links shallow.

Maintenance rules:

- Every new deep dive needs a stable `doc_id`, implementation status, verification date, and owner;
- Chinese and English counterparts must preserve scope, Current/Target boundaries, diagrams, and limitations;
- This index stores one-sentence questions and links; mechanism details remain in the deep dives;
- Adding, renaming, or publishing an article requires updating both architecture indexes;
- The `-draft` filename suffix must agree with front matter `document_status`; publication should remove the suffix and update all index links in the same change.
