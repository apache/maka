# Frontend Architecture Map (2026-07-19)

Maintainer goal: the frontend has grown again since the 2026-07-13 simplification
campaign (#865–#887). Prune redundant/messy code at the architecture level — this time
the bulk sits in the two mega-modules that decomposition has not yet reached (main.ts,
provider-connection-detail.tsx) plus config/CSS rot. Method unchanged: measure first
(knip + wc + grep), stage rounds, gate each on the full suite + typecheck + dead-css +
alignment auditor + CDP spot captures, exit-code gated. Zero behavior change per round.

Baseline (this tip, d48183c2): 84.5K lines TS/TSX (non-test, apps/desktop/src +
packages/ui/src) + 15.1K lines CSS (all in apps/desktop/src/renderer; packages/ui ships
no CSS). Per-area non-test TS/TSX: main 28.4K · renderer 31.6K · ui/src 22.6K ·
preload 1.9K.

Top-10 hotspots (non-test TS/TSX, lines):

| Lines | File | Note |
|------:|------|------|
| 2521 | apps/desktop/src/main/visual-smoke-fixture.ts | **R3 DONE** — split into 689-line registry barrel + 6 `visual-smoke/` domain modules |
| 1871 | apps/desktop/src/main/main.ts | R4/R5/R6 targets (contract re-pins required) |
| 1686 | apps/desktop/src/renderer/app-shell.tsx | R2 target (resume cluster); down from 1733 pre-#887 |
| 1511 | apps/desktop/src/renderer/locales/shell-copy.ts | copy catalog — data, not logic |
| 1502 | apps/desktop/src/main/open-gateway.ts | — |
| 1418 | apps/desktop/src/main/skills.ts | — |
| 1141 | apps/desktop/src/main/explore-agent-tool.ts | — |
| 1114 | apps/desktop/src/preload/preload.ts | bridge surface — mostly declarations |
| 1008 | packages/ui/src/chat-turn.tsx | — |
|  983 | apps/desktop/src/renderer/settings/provider-connection-detail.tsx | R7 target (17 useState) |

CSS top files: maka-tokens 1490 · plan-reminders 824 · onboarding 809 · sidebar 787 ·
skills 691 · chat-detail 656 · mcp 626.

Knip verification notes: the 13 config hints this campaign clears (R1) are ALL
knip-reported redundant/stale config, not code finds — 7 desktop (`overlayscrollbars`
ignoreDependencies now redundant; `src/renderer/**/*.test.ts` matches nothing; 5 entry
patterns auto-detected by knip's vite/storybook/playwright/npm-scripts plugins) + 6 ui
(every explicit entry is already resolved from packages/ui `package.json#exports`). Both
workspaces are exit 0 today; R1 makes them also report ZERO hints. Storybook stories +
`.test.*` entries stay real entries and are not touched.

## Rounds

- [ ] **R1 — knip.json de-rot (this PR).** Clear the 13 config hints without weakening
  coverage: drop the now-redundant `overlayscrollbars` ignoreDependencies entry (the
  overlay-scrollbars contract forbids declaring it as a *desktop dep* — removing a
  redundant *ignore* is compatible; overlayscrollbars is owned by packages/ui), delete
  the dead `src/renderer/**/*.test.ts` entry glob (renderer has zero test files — all 338
  desktop tests live in `src/main/__tests__/*.test.ts`), and drop the 11 redundant entry
  patterns (5 desktop + 6 ui) that knip already auto-detects. Gate: `npx knip --workspace
  apps/desktop` and `packages/ui` both exit 0 AND zero config hints.
- [ ] **R2 — app-shell resume-cluster extraction (this PR, ~−45 lines).** The #1223
  safe-boundary resume cluster: state at app-shell.tsx:268–269
  (`resumePendingSessionId` + `resumeParkDescriptionBySession`) and the
  `resumeInterruptedSession` handler at :894–926. Extract into `use-shell-resume.ts`
  following the use-shell-connections / use-shell-chat-model house style (options object,
  stable identities preserved exactly, pure move, zero behavior change). JSX wiring at
  :1470–1472 (`pending` / `detail` / `onResume`) and the `safeResumeAction=` element stay
  in app-shell. Re-pin runtime-resume-routing-contract.test.ts to read the new hook file
  for the moved assertions (add `use-shell-resume.ts` to renderer-shell-source-helpers
  sourcePaths per the Round B/E precedent). CDP turn-narrative spot capture proves the
  render no-op.
- [x] **R3 — visual-smoke per-domain split behind a barrel (shipped `chore/arch-round-3`).**
  The #1 hotspot `visual-smoke-fixture.ts` (2538 lines at tip 78ac98e0) split into a thin
  registry barrel at the ORIGINAL path (689 lines: `VISUAL_SMOKE_SCENARIOS`,
  `VisualSmokeFixture`, `resolveVisualSmokeFixture`, `getVisualSmokeState`,
  `seedVisualSmokeFixture` — the 4-symbol public surface stays byte-identical for the 3
  non-test consumers) plus 6 per-domain seeder modules under `visual-smoke/`:
  `seed-helpers.ts` (145 — shared spine: `VISUAL_SMOKE_NOW`, session-id constants,
  scenario-set constants, `header`/`writeSession`/`writeJson`), `scenarios-settings.ts`
  (300 — settings/connections/plan-reminders/daily-review), `scenarios-modules.ts` (100 —
  skills-market + MCP), `scenarios-artifacts.ts` (280 — ArtifactPane seed + spec writer),
  `scenarios-chat.ts` (466 — turn/processing/streaming/permission/error + task-ledger +
  live-turn projections), `scenarios-sessions.ts` (672 — long-transcript / workstation-
  statuses / turn-control lineage / long-sidebar / stale). bot-onboarding boundary
  respected (bot-onboarding-visual-smoke.ts untouched). Tests re-pinned via new
  `__tests__/visual-smoke-fixture-source-helpers.ts` aggregator (visible-copy-hygiene +
  placeholder-copy contracts now scan all 7 fixture files); command-palette contract
  needed no change (its assertions target the barrel's scenario set + state switch). Pure
  move: desktop 2744 + ui 196 suites green, 4-tsconfig typecheck + ui typecheck clean,
  check-dead-css clean, knip ×2 exit 0 (zero hints), AUDIT_PORT_BASE=24300 alignment
  auditor exit 0 (all 11 fixtures clean). CDP byte-compare (light-1280-motion):
  module-skills IDENTICAL pre/post (sha256 796e8080…); settings-bots-onboarding is
  inherently nondeterministic at the byte level (4 captures → 4 hashes, ~1426 KB each,
  pre-existing — the onboarding modal renders a live countdown), so the auditor's
  structural walk is the meaningful proof there.
- [x] **R4 — main.ts tool-assembly + tool-artifact-persistence extraction (shipped
  `chore/arch-round-4`, main.ts 1903 → 1656, −247).** Two pure-move modules under
  `apps/desktop/src/main/`:
  `tool-assembly.ts` (277 lines) exports `assembleDesktopTools(deps)` — the sandbox /
  filesystem-worker init, the deferred capability groups (Rive, browser,
  computer-use, agent-orchestration), the WebSearch tool, the builtin + skill host surface,
  the deferred-group `toolAvailability`, and `childAgentTools`; returns the 11 collections
  main.ts consumes downstream (riveTools/officeTools/browserTools/computerUse/
  computerUseOverlay/computerUseTools/agentTeamLeadTools/desktopHostCapabilities/
  builtinTools/toolAvailability/childAgentTools). `tool-artifact-persistence.ts` (124
  lines) exports `createToolArtifactPersistence(deps)` → `{ persistToolArtifacts,
  snapshotReadImage, persistArchivedToolResult, readArchivedToolResult }` (internal
  `resolveToolArtifactSourcePath` / `isInsideOrSamePath`). main.ts keeps every call site
  and the module-scoped seams: `registerIpc`, the `backends.register('ai-sdk')` closure
  (`modelSupportsVision` NOT moved — it belongs to the R5 session-stream core),
  `systemPromptService`, `storeReadImage`, and the `onMainWindowClose = () =>
  computerUseOverlay.destroyAll()` teardown (it assigns a module `let`). Contract re-pins
  (maintainer-authorized): added the two module paths to the
  `main-process-contract-source-helpers` aggregator, so every combined-source consumer
  auto-covers the moved symbols; switched three direct-main.ts readers to the combined
  source keeping every assertion — `agent-swarm-host-contract` (buildParentAgentTools +
  buildDeferredToolGroupsFromCatalog), `agent-team-collaboration-contract` (childAgentTools
  + team tool builders), `attachment-frontend-contract` (snapshotReadImage); relaxed the
  block-closer regexes in `permission-response-ipc-boundary` to tolerate the now-indented
  in-function brackets. `main-process-wiring-contract` (registerIpc anchor) untouched —
  registerIpc stays in main.ts. Gates: desktop 2744 + ui 196 suites green, 4-tsconfig +
  ui typecheck clean, check-dead-css clean, knip ×2 exit 0 (zero hints),
  AUDIT_PORT_BASE=24500 alignment auditor exit 0 (all 11 fixtures clean — full-app boot
  proves main.ts still assembles), turn-narrative CDP smoke renders the chat surface (10
  turns + composer). R5/R6 line boundaries below shift up by ~247.
- [x] **R5 — main.ts settings-runtime-effects + session-stream core splits (shipped
  `chore/arch-round-5`, main.ts 1656 → 1372, −284).** Two pure-move modules under
  `apps/desktop/src/main/` (one commit each). Post-R4 the clusters had shifted far from
  the map's pre-R4 estimates — session-stream sat EARLY (modelSupportsVision + the ai-sdk
  register at ~L720–861, before registerIpc), settings runtime-effects at ~L1145–1204;
  true ranges were re-read at implementation time.
  `settings-runtime-effects.ts` (127 lines) exports `createSettingsRuntimeEffects(deps)`
  → `{ normalizeSettingsPatch, applySettingsRuntimeEffects, handleExternalSettingsChange }`
  (internal `syncDefaultPermissionModeToSessions`); deps = settingsStore / botRegistry /
  openGateway / keepSystemAwake / runtime / safeSendToRenderer / emitSessionsChanged.
  The keep-awake runtime-effect (#1207) rides `applySettingsRuntimeEffects` byte-identical.
  `session-stream.ts` (409 lines) exports `createAiSdkBackendFactory(deps): BackendFactory`
  (the entire `backends.register('ai-sdk', …)` closure + the internal `modelSupportsVision`)
  and `createSessionStreamer(deps): StreamEvents` (`streamEvents` + the two event
  classifiers + StreamEventsOptions/Result). Entanglement seams handled without behavior
  change: `getRuntime: () => runtime` (SessionManager is constructed AFTER the register
  point — the register call stays put so registry-construction order is preserved) and
  `getLookupPricing: () => lookupPricing` (the module-`let` is reassigned by usage IPC +
  startup; used in BOTH the snapshot `lookupPricing` field and the live-read
  `recordLlmCall` closure — a single accessor reproduces both exactly). `desktopSessionSkillHosts`
  Map + `sessionActivities` + the `lookupPricing` let + `runtime` + the fake/e2e backend
  registers + every `streamEvents` call site stay in main.ts. Contract re-pins
  (maintainer-authorized): added both module paths to the
  `main-process-contract-source-helpers` aggregator; switched three direct-main.ts readers
  to the combined source keeping every assertion — `attachment-frontend-contract`
  (modelSupportsVision + `const supportsVision` + `supportsVision,` vision pin, which was
  main.ts-anchored → re-pinned to the aggregator), `ipc-surface-contract` (memoryPromptSnapshot
  + buildBackendSystemPrompt childInstruction), `web-search-telemetry-scrub-contract`
  (argsSummary scrub); allowlisted the moved `[config-watcher]` console.error at its new
  path in check-console.mjs. `main-process-wiring-contract` (registerIpc anchor) untouched.
  Gates: desktop 2744 + ui 196 suites green, 4-tsconfig + ui typecheck clean, check-dead-css
  clean, knip ×2 exit 0 (zero hints), AUDIT_PORT_BASE=24700 alignment auditor exit 0 (all 11
  fixtures clean — full-app boot proves main.ts still assembles + registers the ai-sdk
  backend), CDP smoke: turn-narrative renders chat turns + composer + textarea (the hot
  path), settings-general renders 65 interactive controls (settings-runtime-effects feeds
  it). R6 line boundary below shifts up by ~284.
- [x] **R6 — main.ts startup/lifecycle module (shipped `chore/arch-round-6`, main.ts
  1372 → 1175, −197).** One pure-move module `apps/desktop/src/main/app-lifecycle.ts`
  (335 lines) exports `wireAppLifecycle(deps): void` — the entire post-`registerIpc()`
  startup/lifecycle tail: the `app.whenReady()` flow (dock icon / visual-smoke seeding /
  credential startup / window creation / background startup), `runCredentialStartup` /
  `runBackgroundStartup` / `ensureBootstrapConnection` / `recoverInterruptedSessionsOnStartup`,
  the `window-all-closed` + `before-quit` handlers, and `runBeforeQuitCleanup`. Startup
  ORDER (whenReady → credential migration → second-instance/activate → background startup →
  createWindow → await) and teardown ORDER (#1197 botOnboarding/botRegistry dispose,
  scheduler, keep-awake-dies-with-process) are byte-identical to the originals; every
  process-scoped collaborator is injected. Entanglement seams follow the R5 accessor
  precedent: `setLookupPricing` reassigns the module-`let` pricing lookup (read live by the
  session streamer + usage IPC) and `getSettingsIpc: () => settingsIpc` reads the handle
  assigned inside `registerIpc()`; `configWatcher` + the `beforeQuitCleanup{Started,Complete}`
  flags become `wireAppLifecycle` closure state. Stayed in main.ts (injected in): the
  single-instance lock + `registerIpc()` anchor, `focusOrCreateMainWindow` (next to the
  window controller), `emitConnectionListChanged` / `emitSessionsChanged`,
  `computerUseCapabilityInput`, the `lookupPricing` + `settingsIpc` module-`let`s, and
  `keepSystemAwake`. No entangled remainder — the tail moved whole. Contract re-pins
  (maintainer-authorized): added `app-lifecycle.ts` to the
  `main-process-contract-source-helpers` aggregator; switched five direct-main.ts readers
  of the moved slices to the combined source keeping every assertion —
  `session-startup-recovery-contract` (runBackgroundStartup block + recovery + whenReady
  ordering; block-closer regex relaxed for the now in-function indentation per the R4
  precedent), `runtime-resume-routing-contract` (recovery block, same relaxation),
  `subscription-shared-credential-store` (safeStorage-never-invoked + one-shot OAuth import
  + credential-migration ordering), `single-instance-lock-contract` (the second-instance/
  activate wiring case only — the lock + focusOrCreateMainWindow-definition assertions stay
  on main.ts). `credential-store-secret-kinds-contract` + `computer-use-capability` +
  `window-reveal-after-first-commit-contract` already read the combined source, so the
  aggregator addition carried them. Allowlisted app-lifecycle.ts's startup/shutdown console
  sites in check-console.mjs. `main-process-wiring-contract` (registerIpc anchor) untouched.
  Startup fail-soft contracts do NOT read main.ts slices (`renderer-startup-fail-soft`
  reads the renderer-shell + settings combined sources) — no re-pin needed. Gates: desktop
  2744 + ui 196 suites green, 4-tsconfig + ui typecheck clean, check-dead-css clean, knip
  ×2 exit 0 (zero hints), check-console OK, AUDIT_PORT_BASE=25100 alignment auditor exit 0
  (all 11 fixtures clean — every fixture is a full app boot AND teardown, the strongest
  lifecycle proof). CDP turn-narrative renders the chat surface (composer + textarea +
  data-turn-id turns). Quit-path independently verified past the auditor's SIGKILL: a manual
  boot + graceful `app.quit()` drove `before-quit` → `runBeforeQuitCleanup` → window
  torn-down → **process exited code 0 @265ms, no orphan, no cleanup failures** (window
  closes only after cleanup completes, so this proves the moved teardown ran end-to-end);
  confirmed behavior-identical to the pre-R6 baseline. Campaign main.ts total: 1903 → 1175
  (−728 across R4–R6).
- [x] **R7 — provider-connection-detail.tsx controller-hook decomposition (shipped
  `chore/arch-round-7-final`, detail view 983 → 373, −610).** Blade plan (from reading the
  file): the sheet was one entangled controller — 12 useState in `ConnectionDetailInner`
  plus a single `useKeyedActionGuard` covering save/test/fetch-models/save-enabled-models/
  set-default/delete (all mutually exclusive), one lifecycle/`isConnectionDetailCurrent`
  gate, an aggregated `detailActionBusy`, and a cross-call (`save` auto-fetches models). That
  interlock is one cohesive cluster, so it extracted whole into **one** controller hook
  rather than splitting per sub-cluster (which would have to thread the guard + lifecycle ref
  between hooks and risk behavior drift). Two extractions under
  `apps/desktop/src/renderer/settings/`:
  `use-connection-detail.ts` (522 lines) — `useConnectionDetail(props)` owns every useState,
  the 4 refs, all 4 effects (lifecycle reset, credential-presence probe, snapshot prop-sync,
  enabledModelIds sync), every derived flag (supportsApiKey / needsOAuth / oauthLoginService /
  hasFixedOAuthBaseUrl / credentialProbePending / hasUsableCredential / detailActionBusy /
  apiKeyStatusHint / issue / lastTestMessage / …), the 7 handlers (save / updateEnabledModels
  / runTest / refreshModels / setAsDefault / remove / refreshAfterRelogin), `oauthLoginServiceFor`
  + the `OAuthLoginService`/`ConnectionDetailProps` types, and the pure snapshot/equality
  helpers; returns a controller object.
  `provider-enabled-model-manager.tsx` (187 lines) — the roving-tabindex model-list editor
  (owns `query` + `activeRowId`), an independent cluster.
  `provider-connection-detail.tsx` (373 lines) is now a thin view that destructures the hook,
  keeping `ConnectionDetail` / `UnknownConnectionDetail` / `ConnectionDetailInner` (JSX) plus
  the presentation-only `ConnectionEndpointField` / `GitHubCopilotReloginNotice` /
  `OAuthReloginNotice`. Every identifier and statement moved verbatim — ZERO behavior change,
  stable identities preserved (destructured under the same names so `onClick={save}` etc. stay
  literal). Contract re-pins (maintainer-authorized): `provider-contract-source-helpers` joins
  `use-connection-detail.ts` + `provider-enabled-model-manager.tsx` into the combined source,
  adjacent to the detail view, so `function ConnectionDetail … function modelIdListsEqual(`
  slices span view + controller contiguously; the `model-oauth-section-contract` ConnectionDetail
  controller-slice terminators widened from `function GitHubCopilotReloginNotice` to
  `function modelIdListsEqual(` (the handler bodies / flags / effects / snapshot helpers now
  live in the hook), the `ConnectionDetailInner` view-order slice is unchanged, and the
  last-test-message-helper assertion re-points to the combined source; `web-search-boundary`
  adds the two new renderer files to its scanned set. Every behavior invariant preserved, none
  deleted. No entangled remainder — the whole controller moved. Gates: desktop 2744 + ui 196 +
  storage 396 suites green, 5-tsconfig (preload/main/renderer/storybook + ui) typecheck clean,
  check-console/a11y/copy clean, check-dead-css clean, knip ×2 exit 0 (zero hints),
  AUDIT_PORT_BASE=25300 alignment auditor exit 0 (all 13 fixtures clean incl. settings-usage).
  CDP: the **oauth-relogin** fixture (which opens this component's `codex-oauth` detail sheet)
  renders identically pre/post — OAuthReloginNotice with the 登录 button, EnabledModelManager
  (启用模型 1 · GPT-5.5 默认), test/refresh/delete actions, no error boundary.
- [ ] **R8 — CSS raw-hex residue (this PR). VERIFIED CLEAN — no residue on this tip.**
  Audit premise was stale: prose.css + sidebar.css carry NO raw hex/rgb/rgba/hsl color
  literals on d48183c2. The `#618`/`#546`/`#739` matches a naive grep surfaces are all
  GitHub issue references inside comments, not colors; #1085 (`chore(desktop): clean up
  CSS token governance`) already converted the real residue. The only raw hex anywhere in
  renderer CSS is `--brand-wechat: #07c160` in maka-tokens.css — a deliberate fixed
  external-channel brand identity, already documented in-file ("Fixed external channel
  identity; unlike palette-derived Maka accents"), correctly left as a special case.
  Inline byte-math sweep: the shared `formatBytes` (packages/ui/src/tool-activity/
  preview-utils.ts, re-exported through @maka/ui, governed by
  artifact-pane-format-dedup-contract) already owns the canonical B/KB/MB path. Two
  remaining local byte formatters are NOT trivial forks and are left in place: (1)
  `formatPreviewSize` (artifact-preview-registry.ts:315) returns a `未知大小` sentinel and
  an un-rounded `B` branch — a distinct public contract, not formatBytes; (2)
  voice-settings-page.tsx:156 renders an integer-MB cap (`Math.round(bytes/1024/1024) MB`,
  no decimal) inline with a duration — a different display format. The remaining `* 1024`
  hits are size *constants* (payload caps, stream limits), not formatting. Net: R8 needs
  no code change; recorded here for the record.

Update checkboxes as rounds ship. Every round: suite + typecheck + dead-css + alignment
auditor + CDP spot captures, exit-code gated. R4–R6 are gated additionally on
maintainer-approved contract re-pins; R7 needs its own blade plan; R3 is unblocked only
after the concurrent visual-smoke fixture branch lands.

## Campaign closing summary (2026-07-19 → 07-20)

The two mega-modules the campaign targeted are decomposed and the config/CSS rot is
resolved:

- **main.ts: 1903 → 1175 (−728)** across R4 (tool-assembly + tool-artifact-persistence),
  R5 (settings-runtime-effects + session-stream core), R6 (app-lifecycle) — each a pure
  move behind injected seams, contract-re-pinned through the
  `main-process-contract-source-helpers` aggregator.
- **provider-connection-detail.tsx: 983 → 373 (−610)** via R7 — the densest renderer state
  cluster extracted into `use-connection-detail.ts` (one controller hook for the whole keyed-
  action-guard state machine) + `provider-enabled-model-manager.tsx` (the model-list editor).
- **visual-smoke-fixture.ts: 2538 → 689 barrel + 6 domain modules** (R3), the #1 hotspot.
- **app-shell.tsx: 1654** (R2 resume-cluster extraction — the `use-shell-resume.ts` mechanical
  move — remains open/optional; the file is no longer a campaign hotspot after the 2026-07-13
  simplification pass).
- **R1 (knip de-rot)** and **R8 (CSS raw-hex / byte-formatter residue)** are analysis-complete:
  R8 verified no code change needed; R1 clears the 13 config hints when scheduled. knip ×2
  already reports zero hints on the current tip.

Files split this campaign (new modules): `main/tool-assembly.ts`,
`main/tool-artifact-persistence.ts`, `main/settings-runtime-effects.ts`,
`main/session-stream.ts`, `main/app-lifecycle.ts`, the 6 `main/visual-smoke/*` seeders +
barrel, `renderer/settings/use-connection-detail.ts`,
`renderer/settings/provider-enabled-model-manager.tsx`.

**Also shipped this round (out-of-band bug from #1252's report):** `settingsStore.usageStats`
aggregated `byTool` PER-SESSION (`sessions.flatMap(toolStatsFromMessages)`), so Settings →
使用统计 → 工具统计 showed the same tool name on multiple rows (several Bash rows).
`byProvider`/`byModel` were already global (`aggregateBy` over the flattened `modelLogs`) —
only `byTool` was affected. Fixed by `aggregateToolStats(sessions, since)`: tool_call ↔
tool_result matching stays session-scoped (ids are only unique within a session) while
counts/success/errors/durations merge into one row per tool name, sorted by call count desc.
Regression test added (two sessions × Bash → one merged row). Verified on the settings-usage
fixture via CDP (`window.maka.settings.usageStats('all')`): `byTool` = 6 unique rows (Bash 6,
Read 4, Grep 2 [1✓1✗], Write 2, Edit 1, WebSearch 1), no duplicate tool names.
