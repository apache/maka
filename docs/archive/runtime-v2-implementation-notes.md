# Runtime v2 implementation notes

> Archived on 2026-07-13. These notes describe the initial Phase 1–4 skeleton; the backend architecture chapters and current source now describe the active runtime.

Status: Phase 1–4 skeleton landed (compile-safe, tested). The production
`SessionManager.sendMessage` hot path is **unchanged**; the v2 seam exists
in parallel so future work can migrate onto it incrementally.

Source plan: `docs/archive/runtime-v2-architecture-evolution.md`.

## What landed

### Core contract (`@maka/core`)

- `packages/core/src/runtime-event.ts` — the canonical `RuntimeEvent` fact
  model (role / author / status enums, content discriminated union, actions,
  refs, pure helpers `isTerminalRuntimeEvent` /
  `runtimeEventHasModelVisibleContent` / `createRuntimeEventId`).
- `packages/core/src/__tests__/runtime-event.test.ts` — focused contract
  tests.
- New subpath export `@maka/core/runtime-event`. The later public-API cleanup
  removed the package root barrel, so this subpath is now the only public route.

### Runtime v2 seam (`@maka/runtime`)

Five new modules, each importable via its canonical subpath AND re-exported
(selectively) from the runtime barrel:

| Module | Subpath | Role |
|---|---|---|
| `model-history.ts` | `@maka/runtime/model-history` | Policy-driven `buildModelHistoryFromRuntimeEvents()` replacing ad-hoc `StoredMessage` filtering. |
| `invocation-context.ts` | `@maka/runtime/invocation-context` | `InvocationRequest` / `InvocationContext` spine, injectable `newId`/`now` providers, `InvocationResult` envelope. |
| `runtime-runner.ts` | `@maka/runtime/runtime-runner` | `RuntimeRunner.run()` collecting shell: preflight gate → context → user event → flow dispatch → terminal collection. |
| `agent-flow.ts` | `@maka/runtime/agent-flow` | Formal `AgentFlow` / `AgentFlowControl` / `FlowInput` seam. |
| `ai-sdk-flow.ts` | `@maka/runtime/ai-sdk-flow` | `AiSdkFlow` wrapping an `AgentBackend`; `mapSessionEventToRuntimeEvent()` placeholder mapping. |

Each module shipped with co-located tests for the initial migration seam.

### Exports consolidated by the steward

- `packages/core/package.json` — added `"./runtime-event"`.
- `packages/runtime/package.json` — added the runtime-v2 subpath exports.
- The later public-API cleanup removed both package root barrels in favor of
  explicit domain subpaths.

## Reconciled: single `InvocationContext` type

`InvocationContext` is now owned by `invocation-context.ts` and reused by the
formal flow seam:

- `invocation-context.ts` — the canonical runner/flow spine (required
  `source`, `startedAt`, `request`, `newId`, `now`).
- `agent-flow.ts` — imports and re-exports that canonical type for the
  `AgentFlow.run(ctx, input)` contract.

The runtime barrel re-exports the canonical `InvocationContext` from
`invocation-context.ts`; the previous duplicate flow-local context was removed
so runner and flow code share the same identity/provider spine.

## What remains (by phase)

- **Phase 5 — Tool-event actions:** promote `tool_output_delta` /
  `tool_progress` `SessionEvent`s to a dedicated tool-progress runtime
  action (currently partial tool-role heartbeats). Refine
  `mapSessionEventToRuntimeEvent` role/author policy.
- **Phase 6 — RuntimeGate:** implement the real preflight (connection
  readiness/rebind, blocked/running/waiting guards) behind `RuntimeGate`
  and inject it into desktop + bot/gateway entrypoints.
- **Phase 7 — Projection:** drive `StoredMessage` / `TurnRecord` /
  `SessionHeader` / `AgentRunStore` / `RunTrace` / `TelemetryRepo` writes
  from `InvocationResult.events`. Wire
  `buildModelHistoryFromRuntimeEvents()` into the live
  `AiSdkBackend.materializePriorMessages` path.
- **SessionManager delegation:** replace the body of
  `SessionManager.sendMessage` with `RuntimeRunner.run(...)` behind a
  feature flag, mapping `InvocationResult.events` → existing
  `SessionEvent` projection. A streaming `async *stream()` variant may be
  added then if the renderer needs live deltas. Today `RuntimeRunner.run()`
  is **collecting** (returns `Promise<InvocationResult>`), not streaming.
- **`abort` + `complete` coalescing:** `AiSdkFlow` is a faithful translator
  (the backend emits `abort` then a trailing `complete`, and the flow emits
  both). Coalescing into a single terminal event is a runner/projection
  concern.
- **Flow runnable surface:** `RuntimeRunner` depends on the centrally owned
  `RunnableAgentFlow` (`Pick<AgentFlow, 'run'>`) so it remains decoupled from
  flow metadata (`kind`, `sessionId`) while sharing the formal `AgentFlow.run`
  signature.

## Verification snapshot

All commands run from the repository root (`$RIVE_WORKSPACE`):

```
npm run build                                    # all workspaces — clean
npm run typecheck                                # all workspaces — clean
npm --workspace @maka/core   run test            # 613 pass / 0 fail
npm --workspace @maka/runtime run test           # 384 pass / 0 fail
git diff --check                                 # clean
```

No production source (`session-manager.ts`, `ai-sdk-backend.ts`,
`agent-run.ts`, `materializer.ts`) was modified. The v2 seam is purely
additive.
