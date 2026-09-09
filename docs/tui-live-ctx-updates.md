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

# TUI live ctx updates (#4545)

Status: design. Issue: https://github.com/apache/maka/issues/4545

## Problem

The TUI statusline `ctx used/window pct%` segment updates **once per turn**, when
the turn fully ends. During a long agentic turn — dozens of tool steps over
minutes, exactly when the context grows fastest — the indicator sits stale at
the previous turn's value, so the user loses the signal that says "time to
`/compact` or wrap up".

## Audit: how it works today

Every claim below was verified against `main` (`6c632b1339`).

### Current TUI path (push, once per turn)

| # | Claim | Evidence |
|---|-------|----------|
| 1 | The ctx segment renders `used = modelContextWindow - usage.contextRemaining`; window comes from the model catalog | `packages/cli/src/pi-transcript.ts` L1678–1693 (`renderMakaPiStatusLine`), window wired at `packages/cli/src/pi-tui-runner.ts` L618, L1266 |
| 2 | `usage.contextRemaining` is only written by `accumulateUsage`, reached from stored messages (transcript rebuild) or a live `token_usage` SessionEvent | `packages/cli/src/pi-transcript.ts` L248–267 (`accumulateUsage`), L472, L751, L1003 |
| 3 | The runtime emits `token_usage` with `contextRemaining` exactly once per send, in the *Final usage event* block after the agent loop breaks | `packages/runtime/src/ai-sdk-backend.ts` ~L2738–2800 |
| 4 | Mid-turn, every `step-finish` boundary already captures `stepUsage.inputTokens` into `lastStepInputTokens` — but it only feeds the end-of-turn computation and the durable `recordUsageCheckpoint` hook, which is fire-and-forget persistence, not a live event | `packages/runtime/src/ai-sdk-backend.ts` L2181–2202; hook contract L751–753 |
| 5 | `/context` is refused mid-turn, but the gate is the TUI's own `runControl` serial lock (exists to stop prompts racing session/model switches), not a protocol limit | `packages/cli/src/pi-tui-runner.ts` L3261–3265, L882–914 |

### Desktop prior art (pull, per settled request)

| # | Claim | Evidence |
|---|-------|----------|
| 6 | The Host commits a latest-context snapshot at **every provider request settlement** (each LLM step), carrying `inputTokens` and `contextWindow` | `packages/runtime/src/provider-request-telemetry.ts` `finalize` → `emitModelCallAttempt` → `accounting.record({ attempt, latestContext })` (~L469–640); `packages/runtime/src/latest-context-snapshot.ts` |
| 7 | The commit is awaited **before** the `finish` part is enqueued to the consumer, so any UI event that follows the step (e.g. `tool_start`) observes the snapshot already durable — no read race | `packages/runtime/src/provider-request-telemetry.ts` stream `pull` handler ~L368–390 |
| 8 | `context.diagnostics.query` is a plain read: header snapshot + run-store projection read; no execution authority, no busy gate | `packages/runtime-host/src/server/context-coordinator.ts` `#queryDiagnostics`; spec `mode: 'query'` in `packages/runtime-host/src/protocol/context.ts` L107–117 |
| 9 | The desktop inspector subscribes to the live session event stream and re-reads the diagnostics on trace-relevant events (`tool_start`, `tool_result`, `token_usage`, `provider_retry`, `error`, `complete`, `abort`), coalesced at 400 ms; a failed re-read leaves the last value standing | `apps/desktop/src/renderer/session-trace-refresh.ts` L21–37; `apps/desktop/src/renderer/features/workbar/tools/inspector/use-session-trace.ts` L59 (`TRACE_REFRESH_DEBOUNCE_MS = 400`), L255–274 |
| 10 | Desktop derives the bar as `used = inputTokens`, `ratio = used / contextWindow`, from the snapshot alone | `session-inspector-overview-model.ts` `contextBudget()` ~L210–241 |
| 11 | The TUI driver already exposes the same query; the TUI always talks to the Host | `packages/cli/src/runtime-host-session-driver.ts` L1117 (`getContextDiagnostics`); interface `packages/cli/src/session-driver.ts` L230 (optional) |
| 12 | The TUI runner's `onEvent` sees every live event mid-turn | `packages/cli/src/pi-tui-runner.ts` L1455–1483 |

Semantics line up: the statusline's `contextRemaining = window − lastStepInputTokens`
(#1067) and the snapshot's `inputTokens` describe the same settled request, so
`contextRemaining ≡ diagnostics.contextWindow − diagnostics.inputTokens`.

## Design: reuse the desktop pull model in the TUI

Add a live-refresh hook to the TUI runner. No protocol, runtime, or persistence
changes.

### New module: `packages/cli/src/tui-context-refresh.ts`

- `isCtxRefreshRelevantEvent(event: SessionEvent): boolean` — same event set as
  desktop's `TRACE_RELEVANT_EVENT_TYPES` (audit #9). `tool_start`/`tool_result`
  are the mid-turn step boundaries; the rest close or annotate the turn.
  Keeping the set identical to desktop's keeps one answer to "when is the
  context worth re-reading".
- `createCtxRefresher({ query, apply, delayMs, schedule, cancel })` — a
  restart-on-call debounce with a monotonic revision counter, mirroring
  desktop's `createRefreshCoalescer` plus the `contextRevisionRef` guard:
  only the latest issued query may apply; a late or failed resolution leaves
  the current value standing (audit #9). Clock and timer injected, following
  the runner's existing `shellRunTicker` seam, so tests drive it
  deterministically.

### Wiring in `pi-tui-runner.ts`

In `onEvent` (audit #12), after `applyMakaSessionEventToTranscript`:

1. `if (isCtxRefreshRelevantEvent(event)) ctxRefresher.request()`.
2. The refresher calls `input.driver.getContextDiagnostics?.()` directly —
   deliberately **not** through `runControl`, whose serial lock exists for
   mutations (audit #5).
3. On `status: 'available'` with both `inputTokens` and `contextWindow`
   present, set `state.usage.contextRemaining = contextWindow − inputTokens`
   and `requestRender()`. The statusline keeps its existing formula, color
   thresholds, and degradation states untouched; the catalog window stays the
   displayed denominator, matching what the `token_usage` path already does
   (both windows derive from the selected model's metadata).
4. Stale-session guard: the query captures `driver.getSessionId()` at request
   time and `apply` drops the result when it changed — session switches reset
   `state.usage` (`replaceTranscript`), and a pre-switch value must not land
   afterwards. This guard covers every switch path uniformly, so no per-switch
   cancellation wiring is needed; a refresh scheduled across a switch simply
   queries the adopted session, which is the value the statusline should show.
5. Lifecycle: `ctxRefresher.cancel()` on teardown (alongside the existing
   ticker disposal), which also retires any in-flight query.
6. Event coverage: every live turn drains through `runMakaPiTuiTurn`'s
   `onEvent` (user-submitted and Host-attached turns alike) and the
   `resumeLatest` loop — both hooked. `/compact` is deliberately not hooked:
   its own `token_usage` already writes the authoritative post-compact value.

The end-of-turn `token_usage` event stays the authoritative **persisted**
record; the pull only enriches the live turn. Both derive from the same
settled request, so they cannot disagree.

### Out of scope (recorded, not forgotten)

- Unlocking `/context` mid-turn over the same query path — a free follow-up,
  kept out of this PR to stay small.
- Desktop needs nothing; it already has this granularity.
- Token-level updates during one streaming request: providers only report
  input tokens at completion, so exact mid-request values do not exist; the
  pre-dispatch `bytes/4` estimate is too rough (base64 attachments) to show.

### Why not a new push event

- Protocol surface: a new SessionEvent type touches the core schema, the
  backend emission point, the host mapper, and rebuild/persistence semantics.
- It creates a second derivation of the same number; pull keeps TUI and
  desktop on one source of truth (the snapshot row), so resume / backfill /
  compact edge cases cannot drift between two paths.
- Reusing `token_usage` with partial fields was rejected: `accumulateUsage`
  treats it as cumulative billing input, and "incomplete usage is no usage"
  (#972).

## Test plan (`packages/cli/src/__tests__/`)

- Mid-turn `tool_start` with a diagnostics result → statusline ctx reflects
  the new value before turn end.
- Debounce: a burst of relevant events within the window issues one query.
- Revision guard: two overlapping queries resolve out of order → the older
  resolution is dropped.
- Query failure / `status: 'unavailable'` → previous value stands.
- Session switch between request and resolution → value not applied.
- Driver without `getContextDiagnostics` (optional method) → no-op, no crash.
- Turn-end `token_usage` still lands exactly as today (regression guard on
  `accumulateUsage`).
