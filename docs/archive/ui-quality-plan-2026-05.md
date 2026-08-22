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

# Maka UI Quality Plan (one-month delivery contract)

> Archived on 2026-07-13. This month-one rollout plan and coverage snapshot are no longer current; use `docs/frontend-css-governance.md`, the local frontend READMEs, source, and contract tests.

This is the **UI-side delivery contract** complementing
the archived full-product roadmap (`docs/archive/full-product-test-plan-2026-05.md`, @xuan's) and
@kenji's `notes/maka-one-month-completion-test-plan.md` (cross-cutting
test/release matrix). Where those define "what features ship and how the
overall test matrix is laid out", this document defines the UI-specific
quality bar each visible surface must clear before its PR can merge.

Treat the contracts here as merge gates. A UI PR that violates any §3
invariant or skips a §5 testing layer for its surface does not merge.

---

## 0 — Scope

**UI = everything inside `apps/desktop/src/renderer/` and
`packages/ui/`.** This covers:

- Visual composition (layout, tokens, light/dark themes)
- Interaction (mouse, keyboard, touch later)
- Motion (durations, easings, reduced-motion)
- Accessibility (ARIA, focus management, screen reader)
- UX text (labels, errors, empty states, copy stance)
- Visual smoke fixtures + screenshots
- Renderer-only IPC helpers (`window.maka.*`)

Out of scope (covered elsewhere):

- IPC handlers in `apps/desktop/src/main/**` (xuan + kenji own)
- Backend runtime + telemetry (xuan)
- Storage + migration (xuan)
- Cross-cutting release process (kenji)

---

## 1 — Per-surface gate (the "is this surface done?" checklist)

Every UI surface MUST clear **all** of these gates before merging:

| # | Gate | What it means | Where it lives |
|---|---|---|---|
| 1 | **Contract** | Surface listed in `docs/design-system.md` §9.x with state machine + boundary rules | `docs/design-system.md` |
| 2 | **Pure helper test** | All derived state extracted into pure function + node:test cases covering state transitions | `apps/desktop/src/renderer/*.ts` + `apps/desktop/src/main/__tests__/*.test.ts` |
| 3 | **Component contract** | Component declared in `packages/ui/src/components.tsx` with typed props; no untyped `any` props; no implicit DOM events leaking up | `packages/ui/src/components.tsx` |
| 4 | **Fixture scenario** | At least one `MAKA_VISUAL_SMOKE_FIXTURE=...` scenario seeds the surface with realistic data | `apps/desktop/src/main/visual-smoke-fixture.ts` |
| 5 | **Smoke path** | Step-by-step manual verification with explicit Pass / Fail signals | `apps/desktop/tests/smoke.md` |
| 6 | **Light + dark screenshots** | Both theme variants captured in the fixture | screenshots dir (TODO PR-IR-01) |
| 7 | **Narrow viewport screenshot** | ≤ 990 px width captured to verify mobile-ish layout | screenshots dir |
| 8 | **Failure / empty state** | If the surface has a failure or empty state, that's a separate fixture + screenshot | fixtures + screenshots |
| 9 | **a11y assertion** | ARIA roles, labels, keyboard navigation declared + tested per §3 | component + tests |
| 10 | **Motion contract** | Animations respect `prefers-reduced-motion`; durations from token catalog | `packages/ui/src/maka-tokens.css` + component CSS |
| 11 | **i18n contract** | Visible strings are Chinese by default; no English fallback in user-facing copy | component source |
| 12 | **Security contract** | No raw user input rendered back; no secret in any path; redactSecrets applied | component + tests |

Skipping any single gate is a release-no-go (see §11).

---

## 2 — UI testing layers (the "what kind of test" matrix)

Use **the minimum sufficient** testing layer for each concern. Over-testing
adds maintenance burden and slows merges.

| Concern | Layer | Tool | Example |
|---|---|---|---|
| Pure derivation (badge tone, ordering, filtering) | node:test on pure helper | `node:test` | `deriveChatHeaderAlert` |
| CSS contract (no rule hides X, opacity restores on active) | grep-style assertion on styles.css | `fs.readFile + regex` | `stale-sessions.test.ts` |
| Component prop wiring (renderer → IPC → backend) | preload + ipc shape test | node:test on type | preload.ts shape check |
| User flow (rename, archive, send) | smoke.md manual path | manual | `smoke.md` Path 4 |
| Visual rendering (light/dark/narrow) | screenshot diff | TODO (PR-IR-01) | fixture screenshots |
| a11y semantics (ARIA, kbd) | smoke.md path with explicit Tab order assertion + AT spot check | manual | `smoke.md` Path 9-style |
| Motion (reduced-motion) | smoke.md path with system pref toggled | manual | dedicated path |
| Cross-platform (macOS / Win / Linux) | smoke.md per-platform run | manual | smoke.md preamble |
| Performance (cold start, scroll FPS) | smoke.md + dedicated metric | manual + future telemetry | smoke.md release section |

### What we do NOT test in the UI workspace

- React rendering via JSDOM (over-fragile; pure helper + smoke covers it)
- Backend logic (lives in @maka/runtime / @maka/storage workspaces)
- Network calls (mocked in pure helpers when needed; live calls live in
  @maka/runtime tests)

---

## 3 — Cross-surface invariants (always-on quality contract)

These are **non-negotiable** rules every UI PR must respect. They're the
same kind of "always-on" gate that linters enforce, except codified
prose because they're judgement calls.

### 3.1 Focus management

- Every modal MUST trap focus via `useModalA11y(ref, onEscape?)`.
- Every modal MUST restore focus to the previously-focused element on
  close.
- Focus ring MUST use `:focus-visible`, never bare `:focus`.
- All interactive elements MUST have `aria-label` if they have no visible
  text (icon-only buttons, etc.).

### 3.2 Keyboard

- All clickable controls MUST be reachable by Tab.
- All Tab stops MUST be in DOM order (no positive `tabIndex` except where
  documented in the design system).
- Roving tabindex pattern (Arrow keys) MUST be used for radio groups,
  toolbars, listboxes, menus — verified by node:test on the pure helper
  (see `model-table-keyboard.test.ts`).
- Cmd/Ctrl+K opens command palette (PR31). Esc closes it.
- ⌘/Ctrl+, opens Settings (PR98 menu).
- ⌘/Ctrl+F focuses session search (PR32).
- ? or ⌘/Ctrl+/ opens keyboard help (PR22).
- Enter sends message in composer; Shift+Enter newline (PR3).
- Esc cancels rename / dismisses modal / closes drawer.

### 3.3 Motion

- All durations use tokens from `--ease-out-strong / --ease-in-out-strong / --ease-drawer`.
- `@media (prefers-reduced-motion: reduce)` caps every animation to ~0.01ms
  (already global cap; do not override).
- Use `@starting-style` for entrance animations where supported.
- Animate `transform` and `opacity` only; never `width / height / top`.

### 3.4 Spacing + theme

- Every component MUST use stable spacing that matches its local
  information density; Maka does not expose a global UI density toggle.
- Every component MUST render correctly under light + dark theme via
  `.dark` class.
- Tokens MUST come from `maka-tokens.css`; **no hardcoded color** in
  component CSS (PR5 sweep; enforced by visual review).
- Theme picker preview tiles MUST mirror the actual chat surface (PR79).

### 3.5 Text + i18n

- All user-facing copy is **Chinese by default**.
- Errors go through `generalizedErrorMessage()` from `@maka/core` (PR58,
  PR74).
- UI-level `redactSecrets()` runs on any string that may contain user
  input or provider responses (PR60).
- **NEVER expose internal enums** ("演示版", "FakeBackend", reason codes,
  slugs) in user-visible labels. Put technical detail in tooltip.
- Empty / loading / error states are **first-class**; no surface ships
  with only a happy path.

### 3.6 Boundaries (renderer ↔ main)

- Renderer NEVER assembles absolute paths from a `relativePath`. (Artifact
  contract §9.1.5.)
- Renderer NEVER inspects credential storage directly. Provider secret presence
  goes through `window.maka.connections.hasSecret(slug)`; subscription OAuth
  safeStorage remains main-process only.
- Renderer NEVER opens a URL via `window.open(url)`. Goes through
  `shell.openExternal` in main via `setWindowOpenHandler` (PR96).
- Renderer NEVER drops a file into the DOM. `did-finish-load` blocks
  dragover/drop globally (PR96 follow-up).

### 3.7 Trust hierarchy (UI redactor + backend redactor)

- Backend `redactSecrets` from `@maka/core` is **authoritative**.
- UI `redactSecrets` is a **second layer** for runtime strings (tool
  output banner, copy-to-clipboard).
- Never display a raw error message from any IPC — always run through
  `cleanErrorMessage(error)` first.

---

## 4 — Per-surface coverage matrix (current state + month-1 plan)

Rows are **all UI surfaces** in Maka. Columns are §1 gates 1–12.

✅ = met. ❌ = gap. ⚙️ = partial.

| Surface | C | PH | CC | F | S | L+D | Nar | E/F | A11y | M | i18n | Sec |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Shipped (P0/V0.2)** |   |   |   |   |   |   |   |   |   |   |   |   |
| Sidebar session list | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chat header banner | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Composer | ✅ | ⚙️ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| EmptyChatHero | ✅ | ⚙️ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| OnboardingHero | ✅ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Settings · 模型 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Settings · 账号 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Settings · 数据 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ |
| Settings · 个性化 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ |
| Settings · 网络 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ |
| Settings · 机器人对话 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ |
| Settings · 关于 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ⚙️ | ✅ | ✅ | ✅ |
| Settings · 主题 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ⚙️ | ✅ | ✅ | ✅ |
| Settings · 4 Coming Soon | ✅ | n/a | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ⚙️ | ✅ | ✅ | ✅ |
| Permission dialog | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Tool result renderer | ✅ | ✅ | ✅ | ⚙️ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Turn summary chips | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Thinking block | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sidebar streaming dot | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sidebar stale pill | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Command palette | ✅ | ⚙️ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Toast | ✅ | ⚙️ | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Keyboard help modal | ✅ | n/a | ✅ | ❌ | ✅ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Error boundary | ✅ | n/a | ✅ | ❌ | ⚙️ | ❌ | ❌ | ✅ | ⚙️ | ✅ | ✅ | ✅ |
| Artifact pane | ✅ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session status grouping | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Session status icon + chat header badge | ✅ | ✅ | ✅ | ✅ | ✅ | ⚙️ | ⚙️ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Pending (month-1)** |   |   |   |   |   |   |   |   |   |   |   |   |
| Quick Chat (§9.7) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Workstation shell (§9.8) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Turn control (§9.9) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Sources/Skills/Auto (§9.10) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Health Center (§9.11) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| First-run stepper (§9.12) | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| ModelCatalog ext | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Memory drawer | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Voice composer | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Search service | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Open gateway admin | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| MCP client UI | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Legend: C = Contract, PH = Pure helper, CC = Component contract, F =
Fixture, S = Smoke path, L+D = Light + Dark, Nar = Narrow, E/F = Empty +
Failure states, A11y = a11y assertions, M = Motion, i18n = Chinese
default, Sec = Security (redact + no raw input).

**Total gap count: 13 shipped surfaces × 1–3 ⚙️ gates ≈ 30 cells. All
pending surfaces are full ❌.**

---

## 5 — Required testing infra (PR-IR-XX series)

These are infrastructure PRs the UI side owes the rest of the project.
Without them, the gates in §1 can't be enforced uniformly.

### PR-IR-01 — Screenshot capture pipeline

**What.** A playwright (or Electron-native + tape-recorder) runner that
boots Maka under each `MAKA_VISUAL_SMOKE_FIXTURE=...` scenario, applies
light + dark + narrow viewport variants, and captures PNGs to
`apps/desktop/tests/screenshots/<scenario>/<variant>.png`.

**Why.** Right now `smoke.md` paths require a human to eyeball the
screen. Screenshots provide a regression baseline.

**Gate it unlocks.** L+D and Nar columns in §4 can flip from ⚙️ to ✅.

**Owner.** @yuejing (this is UI infra, not feature).

### PR-IR-02 — Screenshot diff CI gate

**Status (2026-05-22).** Stage 1 is live as
`scripts/diff-screenshots.mjs`. The committed baseline in
`apps/desktop/tests/screenshots-baseline/` covers 3 stable scenarios × 8
variants = 24 PNGs: `artifact-pane`, `first-run`, and `artifact-errors`.
`npm --workspace @maka/desktop run screenshots:diff:stable` exits 1 on
hard failures: missing PNG, corrupt PNG, file < 1 KB, or wrong
dimensions. Size drift is a soft warning.

**Scope catches.**
- Capture pipeline regression: renderer crashes before paint, capture
  IPC breaks, or fixture seed throws.
- Viewport misconfiguration: `MAKA_VISUAL_SMOKE_WIDTH/HEIGHT` not
  honored by the main process.
- Truncated or empty PNGs.
- Scenario/variant matrix drift between capture and diff scripts.

**Out of scope.**
- Pixel-level UI regressions. Electron/font rasterization drift makes
  byte-level SHA/SHA256 equality unsuitable as a blocker (~70/88 PNGs
  change between runs even with @xuan's PR108k fixture clock + Date.now
  freeze).
- Layout shifts that keep the same viewport dimensions.
- Color, contrast, opacity, typography, and spacing regressions.

**PR-IR-02 v3 plan.** Add `pixelmatch` + `pngjs` with calibrated
tolerance and ignored dynamic regions. Pilot only on the stable subset
(`artifact-pane` / `first-run` / `artifact-errors`) before expanding to
all 18 scenarios. Configure per-scenario tolerance based on observed
drift.

**Owner.** @yuejing. Baseline rollout coordinated with @xuan.

### PR-IR-03 — A11y assertion library

**What.** A small node:test helper that, given a fixture HTML snapshot,
verifies:
- Every `<button>` either has visible text or `aria-label`.
- Every modal has `role="dialog"` and `aria-labelledby` / `aria-label`.
- Every `<input>` / `<select>` has an associated `<label>` (via `for` or
  wrapping).
- No `tabIndex` > 0 in the snapshot.

**Why.** Today a11y is checked manually in smoke.md; this adds an
automated floor.

**Owner.** @yuejing.

### PR-IR-04 — Reduced-motion fixture variant

**What.** Add `MAKA_VISUAL_SMOKE_REDUCED_MOTION=1` env var that forces
`prefers-reduced-motion: reduce` regardless of OS setting. Screenshot
pipeline (PR-IR-01) captures a `reduced-motion.png` variant per scenario.

**Why.** Verifies the motion contract per surface.

**Owner.** @yuejing.

### PR-IR-05 — i18n string extractor

**What.** Build-time script that walks `packages/ui` + `apps/desktop` for
all string literals in JSX text nodes and `aria-label` / `title`
attributes; flags any that contain only ASCII letters as "untranslated
English fallback".

**Why.** Locks down the "Chinese-default" contract.

**Owner.** @yuejing.

### PR-IR-06 — Strict component prop typing audit

**What.** ESLint rule (or tsc strict + grep) that bans `any` /
`Record<string, unknown>` / unsealed object types in component props.

**Why.** Component contracts must be enforced by the type system, not
docs.

**Owner.** @yuejing.

---

## 6 — UI PR template (every UI PR must answer)

```markdown
## Contract
- Surface: <name + design-system.md §9.x reference>
- State machine: <list states>
- Boundary: <renderer ↔ main contract this PR touches>

## User Flow
1. <step>
2. <step>
3. <observable signal>

## Tests
- [ ] Pure helper test added in `apps/desktop/src/renderer/<name>.ts` +
      `apps/desktop/src/main/__tests__/<name>.test.ts`
- [ ] CSS contract test if styles touched
- [ ] Fixture scenario seeded in `visual-smoke-fixture.ts`
- [ ] Smoke path added in `smoke.md` with Pass + Fail signals
- [ ] Light + dark + narrow screenshots captured (or noted as PR-IR-01
      blocker)
- [ ] a11y assertions: <list — ARIA roles, kbd nav, focus trap, screen
      reader label>

## Security
- [ ] No raw user input rendered back without `redactSecrets`
- [ ] No secret in any IPC path (uses `hasSecret` envelope when needed)
- [ ] No absolute path in renderer (uses `relativePath` + storage helper)
- [ ] No `dangerouslySetInnerHTML` outside the artifact pane sandboxed
      iframe

## Not Included
- <explicit list of things out of scope this PR, link follow-ups>
```

If a UI PR doesn't answer all five sections, the PR doesn't merge.
Empty "Not Included" is fine; missing is not.

---

## 7 — Release no-go conditions (UI-specific)

A release is **blocked** if any of these is true at tag time:

### 7.1 Functional

- Any P0 user flow regressed (send / open settings / pick model / archive).
- Old sessions can block sending when a ready default exists (the P0 we
  just fixed; verify via smoke Path 12 + new chat from old session).
- "无法发送" / "已过期" banners appear with no actionable CTA.

### 7.2 Visual

- A surface ships with no light/dark or no narrow-viewport baseline.
- Screenshot diff CI red on main without an explicit baseline-update
  commit.
- Tokens drift detected (hardcoded color in component CSS).

### 7.3 Accessibility

- Any modal regresses focus trap or focus restoration.
- Any icon-only button without `aria-label`.
- Reduced-motion fixture variant shows animation > 0.1s.

### 7.4 Text / privacy

- Any user-facing string contains "fake" / "演示版" / internal enum reason
  codes.
- Any error toast contains raw user input or unredacted secret.
- Any tooltip / aria-label is English when the visible label is Chinese
  (mixed-language fallback is worse than fully-translated).

### 7.5 Boundary

- Any renderer-side absolute filesystem path.
- Any `window.open` outside the `setWindowOpenHandler` route.
- Any IPC channel returning `errno` / native errors without going through
  `generalizedErrorMessage`.

---

## 8 — Cross-platform gates

UI works on macOS by default (that's the primary dev box). Before any
release tag:

| Platform | Owner | Smoke run | Required passes |
|---|---|---|---|
| macOS arm64 | @yuejing | All 12 smoke paths | 12/12 |
| macOS x86_64 | TBD | First-run + send + permission | 3/3 |
| Windows | TBD | First-run + send + permission | 3/3 |
| Linux (Ubuntu LTS) | TBD | First-run + send + permission | 3/3 |

Cross-platform owners TBD — @WAWQAQ to assign when CI infrastructure is
ready.

---

## 9 — Performance gates

These are budget ceilings; we don't optimize past them without need.

| Metric | Budget | How measured |
|---|---|---|
| Cold start to first paint | < 1.5s on M1 air | manual stopwatch |
| Composer key-to-glyph latency | < 16ms (one frame) | manual eye check |
| Streaming text render | 60fps (no jank) | DevTools perf panel |
| Sidebar scroll with 200 sessions | 60fps | manual scroll test |
| Settings modal open | < 300ms (post @starting-style) | manual eye check |
| ⌘K palette open | < 100ms | manual eye check |

Regressions investigated, not blocked, unless the regression > 2x budget.

---

## 10 — Surface delivery checklist template

When picking up a pending surface (e.g. Health Center, Quick Chat), the
pattern is:

1. **Read** `docs/design-system.md` §9.x for the target surface.
2. **Write** pure derivation helper(s) under `apps/desktop/src/renderer/`
   with explicit input/output types. Locate by `<surface>.ts`.
3. **Write** node:test cases in `apps/desktop/src/main/__tests__/<surface>.test.ts`
   covering all state transitions + edge cases + invariants.
4. **Write** React component(s) under `packages/ui/src/components.tsx` (or
   a new file if surface is large enough). Wire the pure helper.
5. **Wire** the component into `apps/desktop/src/renderer/main.tsx` (or
   the matching App-level mount point). Pass IPC handles via
   `window.maka.*`.
6. **Add** styles to `apps/desktop/src/renderer/styles.css` using tokens
   only. Include light / dark / motion variants.
7. **Add** ARIA roles + keyboard navigation per §3.
8. **Add** fixture scenario in `visual-smoke-fixture.ts` with realistic
   data including the failure / empty state.
9. **Add** smoke path in `apps/desktop/tests/smoke.md` with Precondition /
   Steps / Pass signal / Fail signal.
10. **Capture** light + dark + narrow + reduced-motion screenshots once
    PR-IR-01 lands.
11. **Update** §4 matrix in this file to reflect the new ✅ row.
12. **PR description** fills the §6 template.

A surface typically needs 3–8 PRs (component scaffold → wire IPC →
states → keyboard → smoke + fixture). Avoid mega-PRs > 1000 LOC; split
along the checklist boundary.

---

## 11 — Owner directory

| Domain | Primary | Backup |
|---|---|---|
| Per-surface UI components | @yuejing | (none yet) |
| Visual smoke fixture seeding | @xuan (data) + @yuejing (consumption) | — |
| Screenshot pipeline (PR-IR-01) | @yuejing | — |
| Cross-platform smoke | TBD | TBD |
| UX text + i18n | @yuejing | @WAWQAQ for stance reviews |
| a11y contract | @yuejing | @kenji for invariant review |
| Theme tokens (`maka-tokens.css`) | @yuejing | — |
| @maka/ui package exports | @yuejing | @xuan (build chain) |

---

## 12 — Open questions / pending decisions

- Cross-platform: who owns Win + Linux runs? Need a CI runner or a
  human on those machines.
- Screenshot diff tooling: playwright vs custom Electron runner? See
  PR-IR-01.
- Visual regression baselines: stored in repo (git LFS?) or external
  bucket?
- Accessibility testing: native AT (VoiceOver, NVDA, Orca) coverage —
  manual + cadence?
- Performance regression: do we instrument or just rely on manual?

These get filed as `notes/open-questions.md` after this doc lands and
get answered as the month-1 work progresses.

---

## 13 — How this doc evolves

- Each new surface adds a row to §4.
- Each new gate violation discovered in PR review adds a rule to §3.
- Each new infra need adds a PR-IR-XX row to §5.
- Release-no-go conditions grow when a regression makes it to main
  uncaught — that's a sign the corresponding gate was missing.

This doc is **a living contract**, not historical record. If a rule
becomes obsolete (a feature got cut, an invariant got automated away),
delete the rule and link to the commit that removed it.

Last updated: 2026-05-22 — initial publication after the P0 stale-session
wave (PR108e/g shipped, send-path rebind by @xuan landed).
