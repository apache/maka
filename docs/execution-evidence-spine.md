# Execution Identity and Evidence Spine

Status: Phase 0 contract, Phase 1 Runtime-to-Task lineage, Phase 2A-2C evidence freshness and Compaction coverage, and Phase 3A TaskRun inspection. See [issue #948](https://github.com/maka-agent/maka-agent/issues/948).

Maka already records the facts needed to explain an execution. Runtime Events preserve model and tool interaction facts, AgentRun records operational lifecycle, and Task Events preserve durable task-control decisions. The missing piece is a shared way to reference those facts across subsystem boundaries.

The Execution Identity and Evidence Spine is that reference protocol. It answers:

> Which execution, source-log prefix, workspace revision, and target snapshot support this projection or evidence claim?

It is deliberately not a new event log, trace backend, or source of truth.

## Delivery boundary

Phase 0 added a versioned shared contract in `@maka/core/execution-evidence`, runtime validation, cursor comparison rules, and this ownership audit. At that boundary it did not:

- assign or persist log sequence numbers;
- change Runtime, AgentRun, Session, or TaskRun storage;
- migrate durable data;
- attach evidence references to Self-check, Compaction, or AHE exports;
- add a lineage inspection command.

Defining the contract first prevents each integration from inventing a different meaning for identity, coverage, or freshness.

Phase 1 makes the Runtime-to-Task portion concrete:

- new AgentRun headers persist `invocationId` while legacy headers remain readable;
- every finished headless Runtime invocation appends a `task_attempt_execution_linked` Task Event;
- the event references TaskRun, Attempt, Session, Invocation, AgentRun, Turn, and inclusive Runtime Event coverage;
- one Attempt may link multiple AgentRuns, including the bounded heavy-task repair run;
- `TaskRunProjection.executionLineage` and each `TaskAttempt.executionLineage` expose the replayed links;
- legacy `ResultRecord` imports produce an honest identity-only link when Runtime coverage is unavailable.

Phase 2A binds compact heavy-task evidence back to executor-owned Runtime facts:

- new tool-derived evidence records the producing AgentRun when Runtime supplies it, while legacy evidence remains readable;
- after each headless invocation, Maka matches the evidence `toolCallId` to immutable Runtime `function_call` and `function_response` rows;
- a `heavy_task_evidence_provenance_linked` Task Event stores only the resulting `ExecutionEvidenceRef` and inclusive Runtime range;
- TaskRun replay overlays the validated provenance onto durably recorded compact tool and artifact evidence;
- a missing function response, conflicting tool name, or mismatched Runtime identity produces no provenance claim.

System-created artifacts, external verifier artifacts, and replay-derived Self-check envelopes keep their existing authority records. Phase 2A does not invent a Runtime source for facts that were not durably recorded from a Runtime tool call.

Phase 2B makes accepted heavy-task Self-check freshness replay-derived:

- Task Event stores expose stable zero-based append cursors;
- system-owned provenance binds the Self-check to its exact Runtime call/result range, Task Event high water, and post-run workspace manifest revision;
- replay reports `current`, `stale`, or backward-compatible `unknown` freshness;
- later mutation evidence invalidates a bound Self-check until a matching workspace observation revalidates it;
- the completion gate rejects explicitly stale Self-checks without pretending that legacy evidence is fresh.

Phase 2C binds each newly written Compaction checkpoint to the exact ordered Runtime Event projection it summarizes:

- `maka.compactable_runtime_event_projection.v1` names the session-scoped ordering and filtering policy;
- inclusive low/high cursors identify the first and last source Runtime Event, while the existing digest still validates the complete ordered prefix;
- prefix matching returns the successor Runtime Events that remain outside the lossy projection;
- legacy V2 checkpoints remain readable, but a source-bound checkpoint cannot be replaced or recovered behind a legacy checkpoint that cannot prove cursor semantics;
- the canonical Runtime Event ledger remains untouched and authoritative.

Phase 3A makes the TaskRun lineage directly inspectable:

- `maka eval task-run inspect <taskRunId> --store <root>` renders a human-readable TaskRun → Attempt → AgentRun tree;
- `--json` emits the versioned `maka.task_run_inspect.v1` machine contract from the same read model;
- the inspector joins Task Event cursors to linked AgentRun and Runtime ledgers, then checks claimed Runtime coverage against observed boundary facts;
- Tool Call/Response gaps, stale or unknown Self-checks, invalid Compaction records, missing AgentRuns, and projection warnings remain explicit structured diagnostics;
- output carries identities, cursors, counts, and health facts, not copies of raw model messages, tool arguments, or tool results;
- a Tool Call without a committed response is reported as an unknown outcome whose external side effects may have occurred, never inferred as success or failure.

The current delivery still does not add AHE lineage, durable recovery modeling for ambiguous external side effects, or the general `maka inspect <sessionId|agentRunId|taskRunId>` resolver.

## Existing authorities

The spine references existing authorities instead of copying their facts.

| Authority | Identity today | Owns | Does not own |
| --- | --- | --- | --- |
| `RuntimeEvent` | `sessionId`, `invocationId`, `runId`, `turnId`, `id` | Canonical model, tool, runtime-content, and terminal interaction facts | Task scheduling or task-level decisions |
| `AgentRunHeader` and `AgentRunEvent` | `sessionId`, optional legacy-compatible `invocationId`, `runId`, `turnId`, event `id` | Operational run lifecycle, status, model resolution, permission, and run-local checkpoints | A second copy of raw Runtime interaction history |
| `ModelCallAttempt` | `sessionId`, `runId`, `turnId`, `logicalCallId`, `attemptId` | **Metering source of truth.** One record per physical provider request, carrying the tokens, the cost, and the `usageBasis`/`costBasis` that qualify both | Whether the set of records is complete — nothing records an expected dispatch count, so no consumer may read a set of attempts as proof of coverage |
| `SessionEvent` and stored messages | Session and turn-oriented identifiers | Compatibility and UI/session read models | Canonical Runtime history |
| `TaskEvent` | `taskRunId`, optional event-specific `attemptId`, event `id` | Task lifecycle, attempts, policy decisions, evidence envelopes, permissions, and recovery-visible task state | Raw model messages, Tool Calls, or Tool Results already owned by Runtime Events |
| `TaskRunProjection` | Fold of one `taskRunId` event stream | Current task read model derived from Task Events | Independent facts outside its source Task Events |
| Compaction checkpoints and blocks | Checkpoint/block ids, policy-specific `highWaterName` and `highWaterSeq`, explicit Runtime Event ids | Lossy context projections and the source set required to validate those projections | Replacement of canonical Runtime Events or a universal log cursor |
| Self-check records | Task and check-specific identifiers | Bounded completion claims and supporting task evidence | Executor-owned command, output, artifact, or workspace facts |
| AHE exports | Target snapshot and exported trajectory references | A derived evaluation/evolution evidence package | Authority over the Runtime or Task facts it exports |

This gives Maka two principal append-only evidence lanes:

```text
Runtime Event ledger                       Task Event ledger
session / invocation / AgentRun / turn     TaskRun / attempt
        |                                          |
        +------------- evidence ref ---------------+
                              |
                   workspace + target snapshot
```

Model spend has exactly one authority: a `ModelCallAttempt` is committed to the AgentRun stream, and everything the Usage surface reads is a projection of that stream, never a parallel write. The projection may fall behind — a failed upsert, a crash between the two — and that is recoverable, because re-deriving a run from the stream and upserting on `attemptId` is idempotent. Recovery is driven by a pending marker written before the projection is attempted, so it survives a crash rather than depending on an error handler running; the residual gap is the window between committing to the authority and writing that marker, which only a full sweep of the stream would close. A read model that cannot be rebuilt from the authority is a second source of truth wearing a different name. Per-turn token aggregates on `RuntimeEvent` and the `token_usage` `SessionEvent` remain projections for replay and recovery; they are not accounting, and accounting is not derived from them. The pre-cutover `LlmCallRecord` table is frozen: it is never migrated into the canonical ledger, because its schema cannot express `usageBasis` or `costBasis` and a migration would have to record unpriced spend as a zero cost. All-time answers therefore sum both sources and report how much came from each, until the old table ages out of the queried range.

Task Events may reference a Runtime trajectory. They must not reproduce it. Projections may summarize either ledger, but their trust comes from source coverage that can be checked against the owning ledger.

## Identity contract

`ExecutionEvidenceRef` separates Runtime and Task identity lanes so similarly named runs cannot be confused:

```ts
interface ExecutionEvidenceRef {
  schemaVersion: 'maka.execution_evidence_ref.v1';
  execution?: {
    sessionId: string;
    invocationId?: string;
    agentRunId?: string;
    turnId?: string;
  };
  task?: {
    taskRunId: string;
    attemptId?: string;
  };
  runtimeCoverage?: ExecutionLogCoverage;
  taskCoverage?: ExecutionLogCoverage;
  workspace?: WorkspaceRevisionRef;
  target?: TargetSnapshotRef;
}
```

`execution.agentRunId` maps to the existing `AgentRunHeader.runId` and `RuntimeEvent.runId`. The longer cross-ledger name is intentional: `agentRunId` and `taskRunId` describe different lifecycles.

The Runtime hierarchy remains:

```text
sessionId > invocationId > agentRunId > turnId
```

`invocationId` is the existing durable Runtime spine. `agentRunId` identifies a concrete execution attempt recorded by AgentRun. Current production paths may assign the same value to both; consumers must not rely on that implementation coincidence.

Only `sessionId` is required inside an execution identity, and only `taskRunId` is required inside a task identity. At least one lane must be present. Optional descendants let readers represent legacy or partial knowledge honestly instead of fabricating identifiers.

## Cursor contract

An ordered cursor has three required coordinates:

```ts
interface ExecutionLogCursor {
  ledger: 'runtime_event' | 'runtime_event_projection' | 'task_event';
  streamId: string;
  sequence: number;
  eventId?: string;
}
```

The semantics are strict:

1. `sequence` is the zero-based append ordinal within one `(ledger, streamId)` pair.
2. Only `sequence` determines order.
3. `eventId` is an optional audit, lookup, and deduplication pointer. It must never determine order.
4. Cursors from different ledgers or streams are incomparable.
5. Different explicit event ids at the same stream position are a conflict, not an ordering result.

The planned stream bindings are:

| Ledger | `streamId` |
| --- | --- |
| `runtime_event` | `execution.agentRunId` |
| `runtime_event_projection` | session id, interpreted only with its adjacent projection policy version |
| `task_event` | `task.taskRunId` |

Canonical Runtime and Task cursors use physical append ordinals. A `runtime_event_projection` cursor is intentionally different: it is an ordinal in a named, versioned projection whose owner must publish the ordering and filtering policy beside the cursor. Cursors from that projection are therefore incomparable with canonical `runtime_event` cursors even when their boundary `eventId` values happen to match. Existing Runtime Event ids remain audit pointers, not ordering fields, and Compaction's legacy `highWaterSeq` remains a checkpoint-local value rather than a source-log cursor.

For Phase 1 headless lineage, the persisted AgentRun Runtime Event JSONL is the ordered stream. Mutable partial snapshot files are excluded, while every physical JSONL row—including a lifecycle row that may carry `partial: true`—retains its append position. Those immutable positions are materialized as zero-based cursor sequences. A completed invocation therefore records coverage such as:

```text
TaskRun task-42 / Attempt attempt-2
  -> AgentRun run-a: Runtime Events [0..146]
  -> AgentRun run-b: Runtime Events [0..38]   # bounded repair run
```

The Task Event stores only these references and boundary event ids. Model messages, Tool Calls, Tool Results, and other Runtime facts remain solely in the Runtime Event ledger.

Phase 2A applies the same rule at evidence granularity. A compact Task evidence envelope may display a bounded summary, but its `provenance` points to the immutable Runtime call/result range that owns the exact request and response. Maka requires the canonical `function_response` before creating that link; a planned or interrupted call alone is not proof of an executor result.

Phase 2C applies the cursor contract without falsely describing the Compaction input as one AgentRun append log. Compaction operates on the session/model-context Runtime Event projection, so its checkpoint carries `runtime_event_projection` cursors plus `maka.compactable_runtime_event_projection.v1`. The policy fixes the projection's ordering/filtering semantics; the boundary ids and source digest then fail closed if replay no longer presents the exact covered prefix. Events after the high-water cursor are returned as explicit successor facts and remain raw in provider-visible context.

Coverage is an inclusive range within one stream:

```ts
interface ExecutionLogCoverage {
  lowWater?: ExecutionLogCursor;
  highWater: ExecutionLogCursor;
  eventCount?: number;
}
```

`lowWater` may be omitted when only a prefix high water is known. `eventCount` counts observed rows and therefore need not equal the ordinal span when gaps are represented.

## Example

```ts
const evidence = {
  schemaVersion: 'maka.execution_evidence_ref.v1',
  execution: {
    sessionId: 'session-7',
    invocationId: 'invocation-12',
    agentRunId: 'run-12',
    turnId: 'turn-3',
  },
  task: {
    taskRunId: 'task-42',
    attemptId: 'attempt-2',
  },
  runtimeCoverage: {
    lowWater: {
      ledger: 'runtime_event',
      streamId: 'run-12',
      sequence: 100,
      eventId: 'runtime-event-100',
    },
    highWater: {
      ledger: 'runtime_event',
      streamId: 'run-12',
      sequence: 246,
      eventId: 'runtime-event-246',
    },
    eventCount: 147,
  },
  workspace: {
    kind: 'workspace_snapshot',
    ref: 'workspace-19',
    dirty: true,
  },
  target: {
    snapshotId: 'maka-ahe-abc123',
    sourceLabel: 'git:abc123',
  },
} as const;
```

This object says where evidence came from. It does not assert that the evidence is correct, current, or complete. Those judgments require reading the referenced facts and comparing their source high waters with current ledger and workspace state.

## Compatibility rules

- Persisted references must carry `schemaVersion`.
- Readers validate unknown input before trusting identity or cursor fields.
- Missing optional identities mean unknown, not empty and not synthesized.
- Legacy records can remain readable through partial identity lanes.
- A future schema version must use an explicit migration or compatibility reader; it must not silently reinterpret v1 cursor ordering.
- A projection must not claim coverage that its producer cannot prove.

## Current AHE integration

AHE target v2 exports now carry the shared evidence spine through
`maka.ahe.execution_lineage.v1`. Every current run-result row names its
`taskRunId` and a digest-bound lineage document. That document binds target,
Task coverage, Attempts, AgentRuns, and Runtime coverage without copying
Runtime facts into Task Events. Payload-safe AgentRun inspection is exported by
default; canonical raw Runtime Events remain opt-in. Missing identities,
coverage, or source artifacts remain explicit gaps.

## Deferred integration work

Later phases should extend the contract without changing fact ownership:

1. Bind workspace observations and artifacts produced outside Runtime tool calls to their appropriate source authorities.
2. Represent uncertain external-side-effect/commit windows in durable recovery lineage.
3. Derive baseline/candidate comparison transitions from target-bound result and lineage documents rather than accepting caller-authored labels.

The guiding invariant is simple:

> The evidence spine points to facts. It never becomes another place where those facts are rewritten.
