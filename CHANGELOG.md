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

# Changelog

## Unreleased

### Added

- Added `/transcript` to browse long TUI sessions without depending on terminal
  scrollback, with line, page, and first/last navigation.

## 0.1.11 - 2026-08-18

### Highlights

- Expanded Runtime Host from a local execution service into the shared authority for multiple connected Hosts, remote project registration, live run state, and archived session lifecycle (#3097, #3145, #3079, #3074, #3151).
- Added the installable Maka CLI package and its protected staged npm release pipeline, including cross-platform artifact and Eval validation (#3169, #3173, #3185, #3188, #3192, #3197, #3200, #3201).
- Added brokered Windows AppContainer sandbox support and tightened local IPC ownership and ACL enforcement (#2961, #3179, #3182).
- Added Work Board storage foundations, Host-scoped task creation, prompt-history completion, and first-run viewport containment (#3028, #3122, #1874, #3195).
- Added native Desktop and TUI locale authorities and Qwen3.8 Max Token Plan support (#2686, #2691, #3157).

### Reliability and developer experience

- Preserved live turns across refresh and projected authoritative live execution state through Runtime Host (#3189, #3079).
- Kept restored tasks safe from concurrent removal, queued busy-raced sends as steering, bounded summarizer inputs, and retired obsolete compact and compatibility paths (#3056, #3032, #3113, #3128, #2742).
- Hardened MCP rediscovery, provider failure diagnostics, rate-limit handling, session stream completion, and scheduled-task ownership (#2989, #2675, #3115, #2682, #2655).
- Added fair multi-arm Eval infrastructure and the DeepSeek Harness benchmark arm, while isolating subject metering from framework accounting (#2668, #2971, #3176).
- Strengthened Windows installer, crash-recovery, remote service restart, and release artifact coverage (#2650, #2562, #3186, #2941).

### Fixed

- Disabled TUI taskbar-progress keepalives by default on native Windows and
  Windows Terminal sessions, where repeated OSC 9;4 updates can make Explorer's
  taskbar unresponsive. `MAKA_TASKBAR_PROGRESS=1` restores the prior behavior,
  while `MAKA_TASKBAR_PROGRESS=0` disables it explicitly.

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP, and for Windows x64 as an unsigned NSIS installer and ZIP, built and verified in the same release run.
- The bundled Computer Use skill ships with the app, but the Computer Use executor remains excluded from this release.

## 0.1.10 - 2026-08-10

### Highlights

- Rebuilt the Runtime Host around durable ownership and recovery: clients now
  reconnect across host restarts, incompatible host epochs retire cleanly, and
  evicted session streams recover without losing the active conversation
  (#2613, #2618, #2630, #2633).
- Added remote capability provider mode and stopped agent graph supervisors
  from generating unnecessary wake-ups (#2625, #2626).
- Made the changes panel Git-authoritative, restored slash command discovery,
  exposed archived conversations, and added an About-page update check
  (#2610, #2612, #2573, #2629).
- Added managed dependency artifact authority to storage and routed DeepSeek V4
  Flash edits through ApplyPatch (#2485, #2606).

### Reliability and developer experience

- Recovered stuck xAI login attempts and stale connection deletion, kept
  settings-controlled session chrome hidden, rendered subagents as compact
  rows, and aligned the workbar picker with Astryx (#2615, #2617, #2619,
  #2632).
- Removed obsolete Runtime Host transition residue and preserved the storage
  hydration crash fixture (#2635, #2576).
- Reduced Windows CI work by scoping the baseline to affected surfaces and
  gating expensive storage coverage, while retrying transient Electron
  downloads (#2599, #2637, #2594).
- Updated bundled Computer Use and WebContent dependency pins, including the
  frame reflow fix (#2627, #2631, #2638).

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP, and for
  Windows x64 as an unsigned NSIS installer and ZIP, built and verified in the
  same release run.
- The bundled Computer Use skill ships with the app, but the Computer Use
  executor remains excluded from this release.

## 0.1.9 - 2026-08-09

### Highlights

- Completed the Runtime Host M5 production cutover (#2420), then established
  the local standalone service (#2583), authenticated WebSocket access
  (#2591), and Host-owned project catalog authority (#2603).
- Added external session import end to end: the shared foundation (#2500), a
  Codex session adapter (#2502), and the Desktop import flow (#2507).
- Shipped Visual System 2.0 from its foundations through the full theme sweep
  and detail polish (#2525, #2536, #2538), aligned high-traffic chrome with
  Astryx primitives (#2580), and closed the remaining elevation, rhythm, and
  primitive review debt (#2593).
- Made task submission readiness a shared product contract (#2498), exposed it
  in Desktop (#2519), added CLI preflight (#2524), and consumed the readiness
  result at submission time (#2523).
- Expanded implementation-agent capabilities with portable terminal input
  (#2526), semantic terminal mouse input (#2533), interactive shell controls
  (#2561), and OpenAI native ApplyPatch (#2532).
- Replaced the CodeMode `Self` evaluator with QuickJS (#2549).

### Reliability and developer experience

- Runtime recovery now handles idle and incomplete provider streams (#2535,
  #2604), preserves compaction projection after overflow (#2602), retains
  imported session context (#2579), and keeps full access available in Plan
  mode (#2581).
- Stabilized Runtime Host session lifecycle races (#2548), added client request
  backpressure (#2539), made task refusals actionable (#2527), recovered CLI
  sessions after workspace moves (#2531), and kept renamed Claude model ids
  stable across catalog refreshes (#2482).
- Matured the generated-files workbar (#2506), kept generated files under user
  control (#2585), restored composer drafts across remounts (#2584), exposed
  diagnostics from error toasts (#2540), and added per-connection model request
  customization (#2565).
- Cut CI wall-clock time with impact gates and a single end-to-end job (#2589),
  reduced Storybook to render smoke (#2582), and expanded Windows process,
  named-pipe, artifact, workspace, and crash-recovery coverage.

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP, and for
  Windows x64 as an unsigned NSIS installer and ZIP, built and verified in the
  same release run.
- The bundled Computer Use skill ships with the app, but the Computer Use
  executor remains excluded from this release.

## 0.1.8 - 2026-08-08

### Highlights

- Added Codex-style side conversations: branch a side thread from the one you
  are in and come back with the answer (#2428).
- Gave projects a first-class Settings page: manage every project Maka knows,
  pick the default one new conversations open in (explicit default beats
  last-used; the composer can still switch per conversation) (#2446), rename
  and reveal a project from its row menu (#2447), and carried the list on the
  entity-list components with folder anchors and tail-preserving path
  truncation (#2451).
- Closed three self-serve gaps reported by users: the Models page can set the
  default connection where the 默认 badge lives (#2421), new conversations
  take a configurable default thinking level and the composer menu says
  模型默认 instead of a deceptive 默认 (#2430), and the 外观 page structure,
  grouping, and copy were brought under the settings idiom (#2343).
- Introduced custom pets end to end: a pack contract with atomic storage
  (#2422), safe pack import (#2423), a pack library (#2427), persisted
  selection (#2437), management in Settings (#2440), rendering (#2442), and
  runtime-state-driven animation (#2444).
- Enabled Mimo and DeepSeek free models by default for OpenCode Free (#2431)
  and seeded its default inventory on create (#2443).
- Removed the product Voice module end to end (#2426).
- Closed the Runtime Host M4 readiness gaps (#2419).

### Reliability and developer experience

- Windows: serialized root marker repair (#2438), stabilized portable path
  tests (#2395), enabled long paths for bare Git fixtures (#2435), normalized
  CI process identities (#2334), and refreshed the test skip inventory
  (#2434).
- Storage: removed worktrees outside their cwd (#2424).
- Renamed the desktop UI components to kebab-case (#2417), finished two CI
  cleanups and reformatted what landed unformatted (#2432), and trimmed
  low-value guard and CSS-contract suites while fixing sqlite warning noise
  (#2425).

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP, and for
  Windows x64 as an unsigned NSIS installer and ZIP, built and verified in the
  same release run.
- The bundled Computer Use skill ships with the app, but the Computer Use
  executor remains excluded from this release.

## 0.1.7 - 2026-08-07

### Highlights

- Rebuilt the composer attachment experience: staged attachments are Token
  chips with tooltip metadata and a lightbox (#2393), with preview thumbnails
  and file cards (#2367).
- Unified the app's status language: what a status means is now named in one
  place (#2397), the Settings surfaces state semantics instead of colours
  (#2401), and the migration finished by deleting its own bridge (#2403) —
  every status dot draws from a single definition, and five formerly
  "active-blue" informational dots settled into their true quiet states.
- Added bounded long-term memory extraction (#2117) and a runtime `WebFetch`
  tool (#2362).
- Moved the CLI onto Runtime Host: `maka run` (#2337) and TUI sessions
  (#2308), and scanned finished runs' trajectories for retrieval (#2319).
- Kept a running status line up for the whole live turn (#2356), opened linked
  subagents from stream tools instead of the sidebar (#2383), restored the
  transcript's markdown rhythm (#2348), handed the chat meta row back to
  Astryx primitives (#2358), and exposed recovery for empty failed turns
  (#2381).
- Rebuilt the extension module pages on the shared ModulePage shell (#2266),
  led the session trace with an Astryx-native overview (#2289), and unified
  the workspace picker onto the composer's ghost-menu family (#2287).
- The window titlebar states the session's project and name (#2327), and the
  Pinned and Recent group headers carry a new-task trigger (#2364).
- Upgraded Astryx 0.2.0 → 0.3.0 (#2288), unified lucide-react onto one major
  (#2275), added a dependency audit lane (#2223), and published the bundled
  Git runtime's source materials (#2235).

### Reliability and developer experience

- Provider transport: hardened incremental OpenAI Responses (#2247), stopped
  reporting a truncated provider stream as a finished turn (#2297), sent the
  Responses wire the options it reads and read the reasoning it returns
  (#2328), settled stop cleanly when it aborts a pending question (#2257), and
  bounded oversized prior turns (#2378).
- Sessions and storage: made session copy retries idempotent (#2398),
  preserved operational state across schema upgrades (#2361), imported legacy
  JSONL session transcripts into SQLite (#2263), closed usage stores after
  lease revocation (#2365), made active session joins replay-safe (#2368), and
  validated swarm resume by agent id (#2375).
- Chat and UI details: kept quote layer geometry stable during entry (#2377)
  and shown only for settled selections (#2350), made the tool diff readable
  with its counts on a collapsed group (#2300), kept the prompt rail clickable
  on macOS (#2338), used standard tab order in the provider catalog (#2306),
  and served Claude OAuth models from the curated catalog with real error
  causes (#2336).
- Desktop platform: isolated the dev build's userData root from release
  (#2292), closed xAI OAuth callback connections and retried a busy port
  (#2302), enforced a metadata-free renderer startup boundary (#2176), and
  dropped the consumer-less update-download bridge (#2326) while giving the
  update action a slot instead of a row (#2320).
- Runtime and headless: compacted and sanitized agent tool contracts (#2349),
  classified an expired probe budget as timeout (#2344), decided the tool call
  event's ledger lane at push time (#2240), separated request latency from
  liveness (#2392), measured the wire the Maka runtime actually dials (#2286),
  and mounted build outputs into the task container rather than the repo root
  (#2298).
- Trimmed low-value and redundant tests across suites (#2404, #2406), and made
  ordering assertions independent of fixed wall-clock budgets (#2304).

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP, and for
  Windows x64 as an unsigned NSIS installer and ZIP, built and verified in the
  same release run.
- The bundled Computer Use skill ships with the app, but the Computer Use
  executor remains excluded from this release.

## 0.1.6 - 2026-08-06

### Highlights

- Extended Runtime Host with a Bot adapter (#2192), candidate composition
  (#2194), and complete opt-in parity (#2216): restored the Desktop Computer Use
  capability (#2233) and its presentation parity (#2254), and resolved OAuth
  tokens for connection effects (#2246).
- Added restricted CodeMode execution in the runtime (#1648), and made
  Edit/Write/FormatJson emit `file_diff` results for both renderers (#2264) so
  tool output renders consistently across Desktop and CLI.
- Bundled and verified a hermetic Git runtime for managed workspaces (#2199),
  and gated managed workspace reads behind owner-bound Runtime Host execution
  (#2129).
- Implemented the Session Bundle filesystem codec in storage (#2013).
- Rebuilt the tool detail panel as one surface with one type scale and real diff
  colours (#2227), kept it visible during live turns (#2244), kept tool-call
  groups collapsed until the reader opens them (#2226), and kept composer
  model/thinking pickers mounted mid-turn, unified as ghost menus (#2230).
- Pinned the prompt anchor rail to the Astryx chat scrollport (#2161) and gave
  it motion (#2215), dropped the branch picker and rebuilt the project picker on
  Selector (#2217), and localized the Astryx chrome adopted since #1795 (#2202).
- Let the Maka benchmark arm run where its competitors run (#2177), bound
  managed shell sessions to the in-container tool surface (#2258), and recorded
  the four-arm Terminal-Bench 2.1 comparison (#2208).
- Pinned GitHub Actions and configured Dependabot (#2212), added a non-blocking
  Windows baseline lane (#2173), and bumped the AI SDK while re-porting the
  tool-call tracker patch (#2193).

### Performance

- Streamed OpenAI Responses incrementally (#2238), coalesced partial stream
  persistence (#2157), mounted a switched-to transcript progressively (#2191),
  and seeded transcript geometry before progressive fill (#2237).

### Reliability and developer experience

- Enforced swarm failure boundaries (#2203), kept PTY tool results JSON-safe
  (#2209), replayed provider-facing MCP arguments (#2243), preserved reasoning
  across provider steps (#2249), and made the tool-result archive capability
  indivisible (#2255).
- Preserved a new task across renderer reloads (#2174), exposed thinking levels
  for discovered Codex OAuth models (#2250), completed the macOS quit lifecycle
  (#2251), cleared the "New messages" indicator at the bottom and per
  conversation (#2211), and replaced the unhealthy opencode-free bootstrap model
  (#2166).
- Repaired the five regressions from the 定时任务 rebuild (#2261).
- Kept modal dialogs out of the window drag region (#2210), drew the reasoning
  chevron from the Astryx icon registry (#2228), preserved Astryx List
  accessible names (#2225), stripped ATX heading markers from quote chip display
  (#2214), dropped the dead `[data-trow]` chat rules (#2231), landed a
  switched-to session at its latest turn instead of flying there (#2239), and
  bounded progressive fill idle so long transcripts settle (#2259).
- Aligned the Models header and back button (#2198), and aligned the Settings
  chat-defaults column with a resizable assistant-tone textarea (#2256).
- Made attachment drop readiness atomic in e2e (#2229), and extracted the shared
  `sanitizeUnicodeText` into core (#2190).

### Distribution

- Ships for Apple Silicon macOS as a signed and notarized DMG and ZIP, and for
  Windows x64 as an unsigned NSIS installer and ZIP, built and verified in the
  same release run.
- The bundled Computer Use skill ships with the app, but the Computer Use
  executor remains excluded from this release.

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
- Fixed the 定时任务 inspector to sit two tab stops from any row (#2185) and
  seeded scheduled tasks with distinct `createdAt` (#2186).
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
  extensions page, scheduled tasks, skill chips and empty states, and the
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
