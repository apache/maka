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

# Frontend Simplification Map (2026-07-13)

Maintainer goal: the project has run long; prune redundant/messy frontend code at
architecture level. Method: measure first (knip + wc + grep), stage rounds, gate each
on the full suite + typecheck + dead-css + alignment auditor.

Baseline (this tip, 1301404d): 45.5K lines TS/TSX (non-test) + 22.0K lines CSS.
Hotspots: app-shell.tsx 1733 · chat-turn 970 · bot-chat 961 · OnboardingHero 955 ·
provider-oauth 870 · composer 866 · scheduled-task 865 · connection-detail 861.
CSS: maka-tokens 1509 · onboarding 916 · scheduled-tasks 864 · skills 833.

Knip verification notes: storybook stories + ui .test.tsx flagged "unused" are FALSE
positives (apps/desktop/.storybook globs both story roots; ui test runner executes
dist/**/*.test.js). Real finds verified by hand before acting.

## Rounds

- [x] **A — SHIPPED (b2a1afd6): knip governance + dead code + dep hygiene.** 6 symbols deleted, 1 demoted, dev-hmr.mjs removed; @base-ui/react→deps, streamdown→devDeps (test-only; deviation on correctness), overlayscrollbars NOT declared (overlay-scrollbars contract forbids it — knip ignoreDependencies instead); scroll-area.tsx retained (a contract reads its content — follow-up: remove file+test together); knip.json (entries per workspace, ignoreExportsUsedInFile, -knipignore tag) + 2 CI steps in the typecheck job; ignore reasons documented below. Gates: desktop 2397/2397, ui 125/125, typecheck, 4 static checks, auditor — all identical before/after.
  - Delete packages/ui/src/primitives/scroll-area.tsx (orphaned by overlay-scroll-area)
  - ~40 unused exports/types across desktop main+renderer and packages/ui — for each:
    grep __tests__ first (contract tests read source text; some pins assert the export
    form) — demote `export` or delete the symbol per-site, never break a pin silently
  - Declare real deps: apps/desktop needs streamdown, @base-ui/react, overlayscrollbars
    (currently resolving via hoisting — fragile)
  - Add knip.json (workspaces, storybook entry globs, test entry globs) + CI step so
    dead code cannot re-accumulate
- [~] **B — app-shell.tsx decomposition (flagship) — 4/5 blades SHIPPED (branch
  refactor/app-shell-decomposition), 1733 → 1666 lines, zero behavior change.**
  Gates identical each commit: desktop 2397/2397, ui 125/125, typecheck, dead-css,
  knip (desktop+ui); final alignment auditor (AUDIT_PORT_BASE=19300) clean on all 9
  fixtures + branch-vs-baseline CDP pixel captures identical (turn-narrative,
  module-skills, settings-general).
  1. use-pending-action-registry — SHIPPED first (only blade that removes dup). ONE
     generic useKeyedPendingRegistry replaces the four hand-rolled keyed sets
     (turnActions state+timers, sessionRow, permissionMode, sessionModel). keysRef
     stays a stable Set so factories + unmount cleanup are byte-identical. Re-pinned
     sticky-model / status-presentation / row-actions-fail-soft contracts.
  3. use-project-context — SHIPPED. appInfo, branchList/pending, recentProjectPaths,
     projectPicker pending+refs + createAppShellProjectActions wiring.
  4. use-module-data — SHIPPED. skills/managedSkillSources/bundledSkillCatalog/
     scheduledTasks + both skill/plan action factories; surface-active predicates
     injected.
  5. use-shell-connections — SHIPPED (partial). connections/defaultConnection +
     connectionsEqual + refreshConnections + handleConnectionEvent. theme/userLabel/
     defaultPermissionMode stayed: default-permission-mode contract pins the
     defaultPermissionMode useState + refreshShellSettings + closeSettings mirror to
     app-shell.tsx specifically, and the theme setters have multiple app-shell writers
     (visual-smoke, settings-overlay onChange) — moving them needs setter injection
     with no net simplification.
  2. use-shell-navigation — SKIPPED (disproportionately risky, per the "ship what's
     done" rule). Its two anchors — openSessionInChat and closeSettings — are pinned
     to app-shell.tsx by source-slice contracts, so they cannot move. Its highest-value
     movable code (the stable bridge callbacks searchModalOnNavigate /
     paletteOnSelectSession / paletteOnOpenSearchModal / useSkillInChat) carries
     PR-FE-BUG-HUNT-0 runtime identity-stability semantics that have ZERO source-pin or
     e2e coverage — a subtle extraction error would silently regress search-during-
     stream with no gate to catch it. A state-only move nets ≈0 app-shell lines because
     every setter (setNavSelection ×15 sites, setSearchScrollTarget via the pinned
     openSessionInChat/createSession, setSettingsOpen via the pinned closeSettings) must
     be threaded straight back out. Left in place with this note.
  Note: the map's < 900 target is not reachable through the five state-cluster blades
  alone — app-shell's bulk is the derived-value block (~210 lines of model/thinking/
  alert memos) and the JSX return (~340 lines), neither of which the blade definitions
  cover; reaching < 900 would require extracting those + splitting the JSX into
  sub-components (out of scope, separate risk).
- [x] **C — SHIPPED (refactor/css-token-consolidation): CSS strata consolidation.**
  Census (machine-generated, var() consumers across all CSS+TSX): reference-shell.css
  23 defined → 16 dead (removed), 3 live color-aliases moved to maka-tokens
  (--color-bg-container/--color-border-tertiary/--color-text-quaternary), 4 live
  layout-locals kept in-file (--agents-layout-bg/--agents-content-area-bg/-gap,
  --sidebar-width). theme-glass.css 2 token overrides (darwin --color-bg-container light+dark,
  --color-text-quaternary) relocated to maka-tokens; glass-material + text/label RULES stay.
  maka-tokens.css: added token-authority README (authoritative --background family vs
  compatibility --color-* aliases, alias policy) + condensed the superseded hue-80 archaeology
  (it named deleted tokens). Both themes migrated (light :root + .dark + darwin light/dark).
  NO computed value changed — pure reorg; the shipped `--color-bg-container: var(--background)`
  exception kept as-is. maka-tokens internal 0-consumer tokens are all governance-contract
  scale members (z-index/control-height/spacing/radius/406) — re-pinned, NOT deleted.
  Gates: desktop 2397/2397, ui 125/125, typecheck 0, check-dead-css clean, knip desktop+ui 0,
  auditor exit 0. CDP light+dark captures (turn-narrative/module-skills/settings-general/first-run)
  before/after — no visual diff.
- [x] **D-1 — SHIPPED: shared useMountedRef + last formatBytes fork.** Case-insensitive
  re-census found the mounted-guard boilerplate at ×38 (not ×6 — the first grep missed
  `fooMountedRef` casings). Shipped: `useMountedRef` lives in @maka/ui (exported from
  index) so both workspaces reach it; converted the 6 canonical `mountedRef/
  onboardingMountedRef` sites (OnboardingHero ×2, password-input, daily-review/
  general/permission-center settings pages) and re-pinned 5 contracts to the
  shared-hook form; voice formatVoiceBytes (last formatBytes fork) deleted in favor
  of the @maka/ui helper. Deliberately NOT converted: use-workspace-instructions-
  controller (lifecycle-counter variant, not boilerplate) and app-shell.tsx
  rendererMountedRef (Round B owns that file).
- [x] **A follow-up — orphan scroll-area.tsx removed.** primitives/scroll-area.tsx
  (34 lines, zero consumers, never exported from the ui index) deleted together with
  its knip ignore; the overlay-scrollbars contract's per-file assertion upgraded to a
  repo-wide ban on @base-ui react scroll-area imports (stronger invariant, no
  coverage lost).
- [x] **D-2 — SHIPPED: mounted-guard long tail.** Converted 34 of the 35 census
  `*MountedRef` sites to `useMountedRef` — 20 renderer settings sites, 4 other
  renderer sites (OnboardingHero readyHero, FirstRunChecklist, artifact-pane,
  browser-panel), 10 packages/ui panels (chat-turn, chat-model-switcher, search-modal,
  scheduled-task-panel, clipboard-feedback, skills-panel, composer, permission-dialog,
  session-history-list, daily-review-panel). Kept each site's companion-ref cleanup
  effect and its ref name; deleted the whole effect only where it did nothing but the
  mounted flag (browser-panel, permission-dialog). packages/ui sites import the hook
  from `./use-mounted-ref.js` per house style. Re-pinned ~30 contract assertions across
  ~20 test files to the shared-hook shape (definition lines + effect blocks). The
  useRef(false) variants all read the flag only inside async handlers — no pre-effect
  reads — so flipping to true-initial semantics is behavior-preserving. Deliberately
  NOT converted: use-memory-settings-controller (lifecycle-counter variant — cleanup
  reset is guarded by a lifecycle counter and reads combine mounted with lifecycle
  equality, same shape as use-workspace-instructions-controller) and app-shell.tsx
  rendererMountedRef (Round B owns that file).
- [~] **E — app-shell derived-value extraction (Round B follow-on) — blade 1 SHIPPED,
  blade 2 SKIPPED. branch refactor/app-shell-view-split. app-shell.tsx 1680 → 1562.**
  1. **Derived-value extraction — SHIPPED (2 commits).** The whole ~210-line derived
     block moved into two pure-derivation hooks following the use-shell-connections /
     use-project-context house style, zero behavior change, every memo keeping its exact
     dep array + referential stability:
     - `use-shell-chat-model.ts` (195 lines): model/thinking selection (chatModelChoices,
       active/new-chat model+label, thinking-variant lists, sticky-pick validation, both
       pending new-chat states) + the two chat-header alert memos. openSettingsSection is
       injected so chatConnectionAlert keeps its identical exhaustive-deps-excluded memo.
     - `use-shell-live-turn.ts` (112 lines): live-turn projection (activeShellRunUpdates,
       streaming/thinking slices, streamingSessionIds pulse set, liveTools/
       hasInFlightLiveTools) + the #646 turn-wait cues. `activeLiveTurn` stays pinned in
       app-shell.tsx (streaming-timeline source-slice contract) and is passed in.
     Re-pinned: added both files to renderer-shell-source-helpers combined allowlist;
     added use-shell-chat-model.ts to the composer-new-chat model-picker contract's two
     subset reads (pendingNewChatModel / validPendingNewChatModel / newChatThinkingLevel
     declarations moved into the hook). All other model/live-turn contracts read combined
     source and auto-followed via the allowlist.
  2. **JSX return split — SKIPPED (disproportionately risky + net-negative, per the
     ship-what's-done rule; Round B skip note is the model).** The ~340-line return's
     content area is irreducibly coupled to ~110 AppShell locals, and every meaningful
     chunk is pinned to app-shell.tsx by a DIRECT-read (non-combined) contract: ChatView
     `liveTurn={activeLiveTurn}` (streaming-timeline), Composer `onPickAttachments`/
     `onAttachFilePaths` (attachment-frontend) + `onPickNewChatModel` (composer-new-chat),
     SessionListPanel `statusGroups={sessionListGroups}` (session-project-view), the
     DailyReviewPage `onCopyMarkdown` (daily-review-copy-feedback), and the onboarding
     `onSkip` handler (onboarding-one-time-regression). Extracting any of them into a
     layout sub-component (a) forces ~50–110 props of straight-through drilling that ADDS
     net interface/destructure boilerplate rather than pruning it (counter to the round's
     goal), (b) requires structurally re-pinning 5+ behavioral contracts that specifically
     assert "the shell orchestrator wires handler X into element Y", and (c) still lands
     app-shell.tsx ≈ 1300 — the ≤1100 target is not safely reachable without over-
     extraction under the zero-behavior mandate. Left in place with this note; the
     derived-value extraction (blade 1) captures the genuine simplification.
  Gates (each commit): desktop 2399/2399, ui 125/125, full typecheck 0, check-dead-css
  clean, knip desktop+ui 0. Final: alignment auditor (AUDIT_PORT_BASE=19900) exit 0, all
  9 fixtures clean. CDP branch-vs-baseline captures (real Electron, light+dark 1280) of
  turn-narrative / module-skills / settings-general / first-run: module-skills + first-run
  byte-identical; settings-general independently non-deterministic (baseline itself yields
  two hashes across repeated passes — pre-existing capture flake, unrelated); turn-narrative
  differs ONLY in a 311×24px region at the very bottom of the frame — the composer footer
  git-branch chip, which renders the worktree's real HEAD (the baseline had to be captured
  in DETACHED-HEAD state since the `main` branch ref is held by the concurrent worktree, so
  the chip shows `—` vs the feature-branch name). Pixel-diff bbox confirmed x:[1106-1417]
  y:[1570-1594]; every other pixel identical, and the chip-less fixtures are byte-identical
  — i.e. the derivation extraction is a proven render no-op.

Update checkboxes as rounds ship. Every round: suite + typecheck + dead-css +
alignment auditor + CDP spot captures, exit-code gated.
