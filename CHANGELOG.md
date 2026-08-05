# Changelog

## Unreleased

## 0.1.5 - 2026-08-05

### Highlights

- Added provider-native web search: one `WebSearch` routing layer that selects
  the current model provider or explicit Tavily execution, with OpenAI and
  Anthropic implementations, durable replay, citation metadata, and privacy-mode
  coverage across Desktop, CLI, Runtime Host, and opt-in Headless Harbor
  (#2152).
- Extended Runtime Host ownership to Plan turn transitions (#2169), Plan runtime
  state (#2082), Daily Review runtime (#2113), Deep Research state (#2099), and
  derived Session effects (#2066), and added its Desktop client foundation
  (#2134): session adapter (#2140), catalog (#2143) and execution (#2149) IPC,
  session domains (#2164), effective pricing projection (#2073) and its Pricing
  adapter (#2148), and the native Browser and Computer Use capabilities Desktop
  offers back to the host (#2178).
- Instructions now load from `~/.maka/AGENTS.md` (or `CLAUDE.md`/`GEMINI.md`)
  before the project's own, so a preference set once applies in every workspace
  (#2183).
- Bundled an English Computer Use Skill tailored to the shipping semantic action
  surface, auto-installed only when a Computer Use backend is available without
  overwriting modified or untrusted copies (#2147).
- Made app updates background and task-aware: discovery and download now live in
  Electron main, and restart/install is guarded by a main-owned activity
  snapshot that confirms how many tasks it interrupts (#1992).
- Restored the native application menu and unified platform command routing
  (#2098).
- Gated managed-workspace execution behind an owner-bound, short-lived authority
  scope (#2106) and sealed baseline admission with a durable Git receipt
  (#1872), so a capability is usable only while the storage root, workspace
  binding, and canonical head describe the same Git state.
- Continued the Astryx redesign of Settings: every capability gets its own
  disclosure (#2100), a settled value stays a row until you ask to edit it
  (#2139) behind one expandable row component instead of two (#2141), and the
  specs and jargon nobody can act on are gone (#2118, #2116, #2120); project
  files left Settings (#2081), the junk drawer emptied into the workbar toggle
  (#2123), and project and branch joined the composer footer control row
  (#2168). Usage (#2024) and Skills (#1973) followed, then three more surfaces:
  「计划提醒」and「每日回顾」became one dense row-and-inspector page instead of two
  unrelated implementations (#2155), the session workbar dropped its hand-rolled
  shell and the tokens that silently resolved to fallbacks (#2158), and the MCP
  page came down to one primary action (#2035).
- Let the Inspector trace filter by what a reader actually asks (#2115), and
  closed the follow-ups left on the trace panel (#2041).

### Performance

- Lazy-mounted sidebar session trees (#2021).
- Removed the swarm ledger full-scan hot path (#2040).

### Reliability and developer experience

- Fixed copied tool authority facts on branched tools (#2061), preserved stream
  liveness across filtered parts (#2124), returned proxied responses at headers
  instead of body EOF (#2159), landed the terminal fact a stop claims (#2078),
  and made the execution boundary the sole file-path authority (#2087) in one
  realpath space (#2059).
- Made realtime session creation single-flight (#2135), released settled bot
  typing listeners (#2150), honored the default permission mode immediately
  (#2109), reset incompatible operational state (#2122), resolved permission
  overlay assets in bundled dev (#2045), and honored TMPDIR for Runtime Host
  control endpoints (#2160).
- Bounded Headless teardown and marked the output replay (#2151), reaped the
  scoped command's replay (#2146), kept Harbor archive ids within ref grammar
  (#2130), stopped handing graded competitor arms this repo's tree (#2121) and
  misfiling their cells as infrastructure failures (#2090), let an authoritative
  reward survive a missing agent self-report (#2112), made Maka's settlement
  window reachable at the Harbor boundary (#2107, #2114), honored the
  command-timeout floor (#2110), resolved `host.docker.internal` for
  in-container arms (#2062), unified `canonicalJson` into a single serializer
  (#2005), pointed the AHE snapshot at the moved workspace-instructions source
  (#2092), added the Reasonix benchmark arm (#2079), and raised the A/B
  pair-concurrency cap to 16 (#2075).
- Rehydrated an unanswered user question the surface never received (#2086), and
  made thinking strength follow the chosen level on Kimi/StepFun/MiniMax coding
  plans (#2067).
- Polished the shell and chat surfaces: an opaque popover for selection quote
  actions (#2154), a centred empty-chat hero (#2153), traffic lights aligned
  with the sidebar icon column (#2144), a collapsed rail that stops repainting a
  third tone in dark mode (#2187), one 920px content column per settings section
  (#2080), a row hairline that stops bending on Astryx Item's corners (#2111),
  Astryx Link for the last bare anchors (#2138), a localized required/optional
  field marker (#2184), global shortcuts through Astryx `useHotkeys` (#2091),
  and Astryx `clickAction` owning the in-flight button state (#2089).
- Fixed the 计划提醒 inspector to sit two tab stops from any row (#2185) and
  seeded plan reminders with distinct `createdAt` (#2186).
- Added an a11y audit that flags `aria-label` on elements whose role cannot hold
  a name (#2108), and established the Windows support baseline (#2156).
- Replaced fixed waits with explicit barriers in runtime tests (#2162), owned
  the temp namespace in the test runners (#2068), isolated the dev bootstrap
  environment (#2131), seeded a real project in the sidebar rename spec (#2022),
  eliminated Desktop smoke false failures (#2101), stabilized Skill draft
  restoration (#2137) and invocable Skill projection (#2105), built an invalid
  UTF-8 path with Git plumbing (#2097), proved the Storybook autoplay contract
  the smoke harness stands on (#2071), and fixed the serial workspace batch that
  never ran after a parallel failure (#2136).

### Removed

- Removed dead storage modules (#2104), consumer-less Desktop IPC bridge surface
  (#2065), and dead shell CSS recipes along with the check-dead-css blind spots
  that hid them (#2070).

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP.
- Adds Windows x64: an NSIS installer and a ZIP, built and verified on Windows
  in the same release run (#2182). This build is not code-signed yet, so Windows
  SmartScreen warns on first launch.
- The bundled Computer Use skill ships with the app, but the Computer Use
  executor remains excluded from this release.

## 0.1.4 - 2026-08-04

### Highlights

- Rebuilt Computer Use around `maka-cu` as the executor that actually runs:
  rewrote what the model reads (observation, action surface, refusals), made the
  agent cursor land where it is aimed, mirrored the driven window instead of
  competing for the screen, and let a model read back the call it made.
- Gave driving the computer its own conversation row, stopped a run when the
  machine locks, and kept the machine awake while it runs.
- Made SQLite the sole operational authority in storage, moved the project
  catalog into the operational database, and converged concurrent fresh WAL
  initialization.
- Extended Runtime Host ownership over input and artifact preparation,
  interactive session actions, safe-boundary continuation authority, and
  sandbox boundary interactions.
- Added a session trace as a workbar Inspector tab, projected over both ledgers.
- Added configurable subagent model routing with its own settings page, and
  raised agent swarm concurrency to 32 ways.
- Added Mermaid rendering to Markdown.
- Switched Codex OAuth to the ChatGPT device-code flow and added Grok PKCE.

### Performance

- Streamed the transcript incrementally instead of re-deriving it per token.
- Subscribed to session UI state at the granularity each surface reads, and
  stopped idle-session event-health polling from re-rendering the whole shell.

### Reliability and developer experience

- Fixed turn execution scope isolation, streamed tool-call delta resolution
  against live aliases, streamed tool calls dropped when a gateway skips index
  0, tool-free child summaries, and AgentRun ledgers written by other versions.
- Made macOS development permission grants reliable and the dev TCC grant
  durable behind an opt-in, and made startup say which step has not come back.
- Told a refused tool call what to do next, not just what went wrong.
- Derived thinking-strength controls from models.dev reasoning options, and
  unified cron expression authority.
- Continued the Astryx redesign across Settings, the subagent page, the
  extensions page, plan reminders, skill chips and empty states, and the
  composer model and voice controls.
- Put every headless benchmark arm under the same tool surface and model
  budget, registered `ArchiveRead` for Harbor-archived tool results, and
  required validated verifier grades.
- Routed CI into dedicated lanes for heavy suites and the alignment audit, and
  measured Computer Use rendering changes against recorded trajectories.

### Removed

- Removed `cua-driver` now that `maka-cu` is the Computer Use executor.
- Removed isolated runtime utilities and the Cursor subscription integration.

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP.
- Computer Use remains excluded from this release.

## 0.1.3 - 2026-08-03

### Highlights

- Expanded Runtime Host ownership across hosted child agents, Agent Graph
  execution, Web Research, Goals, Automation, OAuth enrollment, session
  lifecycle, runtime resources, and live execution inspection.
- Strengthened Graph and Swarm coordination with structured operator handoffs,
  non-blocking supervisor turns, durable child summaries, and session-bound
  graph retirement.
- Migrated the Desktop shell, Settings, Composer, conversation surfaces,
  typography, navigation, resizing, and common controls to Astryx 0.2.0.
- Added SQLite-backed local memory, managed Git workspaces, verified operational
  backups, canonical model-call metering, and confirmed agent
  self-configuration tools.
- Added `opencode-free` as a zero-credential default provider and improved
  Runtime Host OAuth-backed execution.

### Reliability and developer experience

- Fixed Electron development and packaged startup failures, onboarding snapshot
  handoff, Runtime lifecycle races, PTY backpressure, clipboard writes, and
  several Graph, Headless, and UI regressions.
- Reduced low-signal, duplicate, source-shape, and happy-path tests; routed CI
  suites by affected surface; and kept build, typecheck, Storybook, and E2E
  gates intact.

### Removed

- Removed the desktop Open Gateway HTTP/SSE server and its Settings and IPC
  surfaces. Model providers, OpenAI-compatible connections, Vercel AI Gateway,
  and bot event gateways are unchanged.
- Removed the superseded Expert Team mode and its Notes-era architecture
  artifacts now that Graph and Swarm own multi-agent coordination.
- Retired legacy storage writer exports and Astryx compatibility adapters that
  no longer had active callers.

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP.
- Computer Use remains excluded from this release.

## 0.1.2 - 2026-07-31

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
