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

# Runtime Kernel Extraction

> Archived on 2026-07-13. This is a point-in-time extraction record, not current architecture authority. Start with `ARCHITECTURE.md`.

This document explains the runtime-kernel work in this change set: what changed,
why it was needed, what stayed stable, and how it was verified.

## Summary

Maka already had the pieces of a local desktop coding agent: sessions, model
streams, tool calls, permission prompts, abort handling, usage telemetry, bot and
gateway entry points, and persisted session messages. The problem was that the
core execution responsibilities were still concentrated in a few large runtime
paths, especially `AiSdkBackend` and `SessionManager.sendMessage()`.

This change set keeps the product surfaces stable but introduces clearer
internal runtime boundaries:

```text
SessionManager
  -> AgentRun
      -> AiSdkBackend
          -> ModelAdapter
          -> ToolRuntime
      -> RunTrace
      -> AgentRunStore
```

The intent is not to rewrite the runtime or replace the Vercel AI SDK. The goal
is to make the existing runtime easier to reason about, easier to recover after
interruption, and easier to extend with future backends or workflow integrations.

## What Changed

### ToolRuntime

`ToolRuntime` is now the internal boundary for the lifecycle of model-requested
tools. The extracted runtime owns the work that used to be interleaved inside the
AI SDK backend:

- validate tool input before execution
- evaluate permission policy
- wait for parked permission decisions with timeout behavior
- pause and resume the stream watchdog around tool execution
- propagate abort signals into tools
- classify tool failures
- record tool telemetry and artifacts
- emit tool and permission trace events

`AiSdkBackend` still bridges model stream behavior, but it no longer needs to own
every detail of tool execution.

### ModelAdapter

`ModelAdapter` is the provider-facing stream and error normalization layer. It
keeps AI SDK-specific stream chunks, provider setup, usage normalization, and
provider error mapping out of the higher-level backend orchestration shell.

This makes the boundary explicit:

```text
provider / AI SDK details
  -> ModelAdapter
  -> Maka runtime events and usage records
```

That separation matters because future providers should not need to duplicate
permission, tool, run, or session-state behavior.

### RunTrace

`RunTrace` is an internal best-effort trace path for runtime events. It records
milestones such as:

- turn started
- model resolved / stream started / stream completed / stream failed
- tool started / completed / failed
- permission requested / decided / failed
- usage recorded
- abort requested

Trace recorder failures are intentionally non-fatal. A failed trace write must
not alter model or tool execution.

### AgentRun Types and Store

The core package now defines internal AgentRun contracts:

- `AgentRunHeader`
- `AgentRunEvent`
- `AgentRunStatus`
- `AgentRunStore`

The storage package adds a file-backed run store:

```text
sessions/<sessionId>/runs/<runId>/run.json
sessions/<sessionId>/runs/<runId>/events.jsonl
```

The store provides:

- atomic `run.json` writes
- append-only run event JSONL
- same-run write serialization
- session run listing
- corrupt committed event-line recovery via `event_corrupt`
- malformed unterminated tail tolerance

This ledger is separate from the existing session message JSONL so runtime
diagnostics and recovery state do not pollute user-visible conversation history.

### AgentRun Execution

`SessionManager.sendMessage()` now delegates the heavy turn lifecycle to
internal `AgentRun.execute()`.

`AgentRun` owns:

- generating and recording run identity
- appending the user message
- writing initial turn state
- locking the connection snapshot for the run
- ensuring the active backend exists
- driving backend stream events
- projecting session status changes
- writing turn completion, failure, abort, or permission-wait states
- recording run started/completed/failed/cancelled status
- routing `RunTrace` events into the durable run ledger
- preserving abort source diagnostics such as `renderer.stop_button`

`SessionManager` remains the public runtime API and continues to own session
CRUD, backend registry orchestration, active run lookup, and legacy recovery
entry points.

### Active Run Registry

The old active stream counters and turn-id side maps were replaced with:

```ts
activeRuns: Map<string, AgentRun>
turnToRunId: Map<string, string>
```

This makes overlapping run behavior explicit. It also avoids masking active
stream accounting bugs with defensive counter clamping.

### Startup Recovery

`recoverInterruptedSessions()` now prefers the AgentRun ledger when run rows are
available. It scans persisted run headers and events, classifies stale
non-terminal runs, repairs them, and then converges the existing session/turn
projection.

Recovered cases include:

- stale `created` or `running` runs
- runs whose last event is `run_started` or `model_stream_started`
- stale tool tails after `tool_started`
- stale permission waits after `permission_requested`
- `model_stream_completed` without a terminal run event
- corrupt run event lines represented as `event_corrupt`

Legacy sessions without run ledger rows still use the prior message and
turn-state recovery path.

## What Stayed Stable

This work intentionally does not change:

- `window.maka.*` preload API
- Electron IPC channel names
- renderer-visible `SessionEvent` behavior
- user-visible permission modes
- session message JSONL compatibility
- builtin tool names or public tool behavior
- model provider settings UI
- bot and OpenGateway public entry points
- Rive workflow integration semantics

The runtime kernel is internal. Public behavior should remain compatible while
the internals become more explicit and recoverable.

## Why This Was Needed

Before this work, a single turn execution was spread across session management,
backend stream handling, tool wrapping, permission policy, telemetry, and abort
logic. That made several questions difficult to answer after a failure:

- Did the model stream start?
- Which backend/model/connection did the turn use?
- Was the run waiting for permission?
- Which tool was running when the app exited?
- Did the user press stop?
- Was usage recorded?
- Did a stale session status reflect a real active run or a crashed process?

The AgentRun ledger gives the runtime a durable fact record for those answers.
ToolRuntime and ModelAdapter then reduce the amount of model/tool/provider logic
that has to be understood at once.

## Recovery Model

The new recovery path is conservative. It does not replay model streams or tools.
Instead, it repairs stale state into deterministic terminal states so the app
does not reopen with sessions permanently stuck in `running` or
`waiting_for_user`.

When a stale non-terminal run is recovered, the runtime:

1. Updates the AgentRun header to terminal state.
2. Appends a durable recovery event such as `run_failed` or `run_completed`.
3. Writes the existing session `turn_state` projection.
4. Updates the session header out of active running/waiting states.

The failure class for app-restart recovery is recorded as `app_restarted`.
Diagnostics are limited to small reason-code fields such as `recovered`,
`failureClass`, `recoveryReason`, `lastEventType`, and `eventCorrupt`; raw user
text and raw event payloads are not copied into recovery diagnostics.

## Files Added

- `packages/runtime/src/tool-runtime.ts`
- `packages/runtime/src/model-adapter.ts`
- `packages/runtime/src/run-trace.ts`
- `packages/core/src/agent-run.ts`
- `packages/storage/src/agent-run-store.ts`
- `packages/runtime/src/agent-run.ts`
- `packages/runtime/src/agent-run-recovery.ts`

## Tests Added or Expanded

The runtime test suite now covers:

- ToolRuntime permission allow/block/prompt/timeout paths
- watchdog pause/resume behavior around tools
- tool abort and failure classification behavior
- tool telemetry and artifact recording behavior
- ModelAdapter stream, usage, and provider error normalization
- RunTrace recording and best-effort failure behavior
- overlapping AgentRuns
- backend build failure after user-message append
- permission handoff without stuck run state
- stop button abort source preservation
- late complete after stop not overwriting aborted state
- durable trace redaction
- AgentRunStore create/read/update/list behavior
- same-run AgentRun event append serialization
- corrupt AgentRun event JSONL recovery
- startup recovery from stale AgentRun ledger states
- legacy startup recovery fallback
- terminal AgentRun recovery idempotency

## Verification

The changes were verified with:

```sh
npm --workspace @maka/core run typecheck
npm --workspace @maka/storage run test
npm --workspace @maka/runtime run typecheck
npm --workspace @maka/runtime run test
npm --workspace @maka/desktop run build:main
git diff --check
```

The final runtime suite included 315 passing tests after the AgentRun recovery
work.

## Follow-Up Work

This PR establishes the internal runtime-kernel shape, but it does not finish
every possible cleanup. Good follow-up slices are:

- merge usage and cost accounting more tightly with the run ledger
- expose an internal run-inspection/debug read model
- reduce the remaining `SessionManager` hook surface used by `AgentRun`
- consider Gateway/Bot policy unification through the same run policy layer
- consider Rive workflow/run mapping only after there is a product need
