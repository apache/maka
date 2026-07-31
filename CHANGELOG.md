# Changelog

## Unreleased

### Open Gateway removal

Removed the desktop Open Gateway HTTP/SSE server, its Settings and IPC surfaces,
and its dedicated credential/capability types. Model providers, OpenAI-compatible
connections, Vercel AI Gateway, and bot event gateways are unchanged. Persisted
settings from older builds are accepted with the retired section ignored.

### Runtime kernel extraction

This change set turns the runtime execution path from a large implicit
`SessionManager` / `AiSdkBackend` flow into an internal runtime-kernel shape.
It keeps the existing desktop, renderer, IPC, session JSONL, settings, and bot
surfaces stable while moving model, tool, trace, run-ledger, and
startup-recovery responsibilities behind explicit internal boundaries.

| Area | Summary |
| --- | --- |
| Tool runtime | Extracted an internal `ToolRuntime` around tool input validation, permission checks, watchdog pause/resume, abort propagation, telemetry, artifact recording, and failure classification. |
| Model adapter | Extracted a minimal `ModelAdapter` so provider stream/error/usage normalization no longer lives directly in the backend orchestration shell. |
| Runtime trace | Added best-effort `RunTrace` events for model, tool, permission, abort, and usage milestones without changing renderer-visible `SessionEvent` behavior. |
| AgentRun ledger | Added core `AgentRun` types and a file-backed `AgentRunStore` at `sessions/<sessionId>/runs/<runId>/run.json` plus `events.jsonl`. |
| AgentRun execution | Moved the heavy turn execution lifecycle from `SessionManager.sendMessage()` into internal `AgentRun.execute()`, including user-message append, backend stream drive, status projection, abort/failure handling, and durable trace writes. |
| Startup recovery | Made `recoverInterruptedSessions()` prefer the AgentRun ledger when available, repairing stale non-terminal runs and preserving the legacy message/turn-state fallback for older sessions. |

See `docs/archive/runtime-kernel.md` for the historical design rationale, boundaries, and
verification details.

### Hardening phases 1-5

This change set collects the first five maintenance hardening phases from the
Rive deep-read follow-up work.

| Phase | Area | Summary |
| --- | --- | --- |
| 1 | Runtime permission and usage handling | Made stream watchdog pause/resume accounting robust for concurrent tool calls, added permission timeout handling, integrated Office document abort propagation, and fixed cache/reasoning token usage extraction. |
| 2 | Session JSONL recovery | Recovered sessions with corrupt JSONL rows by parsing message lines independently, surfacing landed corrupt rows as `system_note`, and dropping malformed truncated tail rows. |
| 3 | Bot and OpenGateway abuse controls | Added bot inbound rate and session-binding limits, bounded bot dedupe state, forced bot-bound sessions to `explore`, and capped OpenGateway SSE connections with idle cleanup. |
| 4 | Credential-store secret kind expansion | Extended encrypted credential-store support for bot tokens, bot app secrets, proxy passwords, gateway tokens, and Tavily API keys while preserving legacy API-key/OAuth-token key formats. |
| 5 | Connection credential IPC input hardening | Added shared main-process validation for renderer-controlled connection slugs and API keys before store, credential, or provider side effects. |

### Active tool-result pruning default-on

`activeToolResultPrune` (current-turn large tool-result pruning) is now
enabled by default on both desktop and headless. Tool results above the
2048 estimated-token threshold are archived and replaced with a
metadata-only placeholder (artifact id + content hash) in the next
provider-visible request; the raw payload is preserved in the archive
and is not lost. On desktop this runs before the already-default-on
`semanticCompact` summary step. On headless the placeholder reaches the
next provider step directly (no default compaction/retrieval), which
benchmark A/B evidence in #340 showed is non-inferior within the 10pp
margin while saving ~31.6% cost.

Opt out with `MAKA_CONTEXT_ACTIVE_TOOL_RESULT_PRUNE=off` (both sides).
Tune the threshold with `MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MAX_ESTIMATED_TOKENS`
and the start step with `MAKA_CONTEXT_ACTIVE_TOOL_RESULT_MIN_STEP_NUMBER`.

### Verification

- Headless and desktop context-budget tests for activeToolResultPrune
  default-on, opt-out, and env knobs.
- Runtime package typecheck/build and full runtime test suite.
- Desktop main build/typecheck.
- Storage package build and AgentRun store tests.
- Runtime package typecheck/build and focused runtime tests.
- Storage package build and focused session-store tests.
- Desktop main build/typecheck and focused bot/OpenGateway, credential-store,
  settings/web-search, connection IPC, OAuth, and model-provider regression
  suites.
- `git diff --check` before each pushed phase.
