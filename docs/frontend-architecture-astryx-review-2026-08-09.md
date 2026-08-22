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

# Frontend architecture & Astryx coverage review

**Date:** 2026-08-09 (UTC)  
**HEAD:** `0ad579d33` (`feat(ui): align high-traffic chrome with Astryx primitives (#2580)` on `main`)  
**Scope:** `apps/desktop/src/renderer/**`, `packages/ui/src/**`  
**Method:** file-level inventory regen + pattern scan + deep reads of shell/settings/modules/ui; prior art `docs/astryx-full-surface-audit.md`, `DESIGN.md`, `docs/astryx-surface-file-inventory.md`  
**Evidence log:** goal scratch `frontend-review-scan.log` (inventory totals, greps, spot-checks, inventory unit tests)

---

## Executive verdict

The product already has a **correct intended layering**:

```
Astryx primitives/theme  →  @maka/ui compositions  →  desktop host (shell, settings, workbar)
```

Post-#2580, **raw interactive control blockers are cleared** (inventory: **183 files · blocker 0 · polish 4 · aligned 179**). Empty/loading/error contracts are largely on Astryx `EmptyState` / `Spinner` / `Banner`.

Remaining risk is not “missing Buttons.” It is:

1. **Architecture concentration** — `app-shell.tsx` is still the application; settings and workbar behave as mini-apps; CSS has three historical dialects.
2. **Visual system debt** — in-chat plates (plan, agent-graph) still stack fill + border + raw shadow (violates DESIGN.md One Means / surface ladder).
3. **Product CSS on top of Astryx controls** — quote chip / turn footer / lineage still re-author chrome geometry.

---

## 1. Layering map (as shipped)

```
Electron frame
└── appFrame (app-shell.tsx ~3.1k lines)
    ├── window titlebar (drag + chrome actions)
    ├── Astryx AppShell
    │   ├── SideNav → SessionListPanel (@maka/ui)
    │   └── content
    │       ├── Module routes → ModulePage (@maka/ui → Astryx Layout)
    │       ├── ChatSurfaceLayout (@maka/ui → Astryx ChatLayout + conversationKey patch)
    │       │   ├── ChatView / turns / tool-activity
    │       │   └── Composer
    │       └── ChatWorkbar → SessionWorkbar (custom tab WM)
    └── Overlays
        ├── SettingsModal → SettingsSurface (second Layout + SideNav)
        └── palette / search / help / import
```

| Layer | Owner | Job |
|-------|--------|-----|
| Window chrome | desktop `app-shell*` | drag region, titlebar actions |
| Columns | Astryx `AppShell` | sideNav + content plate |
| Chat page shell | `@maka/ui` `ChatSurfaceLayout` | scroll / dock / follow |
| Transcript product | `@maka/ui` chat-turn, tool-activity | turns, tools, heroes |
| Settings | desktop `settings/*` kit | modal IA + rows |
| Modules | `ModulePage` + desktop MCP | dense list + inspector |
| Substrate | Astryx + `maka-tokens.css` + generated theme | primitives / tokens |

**Healthy seams (do not “fix” away):**

- `ChatSurfaceLayout` as the published chat shell (`packages/ui/src/chat-surface-layout.tsx`)
- Settings kit (`SettingsPage` / `SettingsSection` in `settings-section.tsx`) after the card-chaos convergence
- Module kit (`primitives/module-page.tsx` on Astryx `Layout` / `ResizeHandle`)
- Cascade layers + dead-CSS / astryx inventory gates (`cascade-layers.css`, `scripts/check-astryx-*.mjs`)
- Stream isolation intent via desktop chat surface adapters so shell chrome does not re-render every token

---

## 2. Architecture review (simplification / elevation)

Severity: **blocker** = structural cost that blocks every feature; **high** = clear multi-surface tax; **polish** = cleanups that can wait.

### A1 — AppShell is still a god-orchestrator (blocker)

**Anchors:** `apps/desktop/src/renderer/app-shell.tsx` (~3099 lines); siblings `app-shell-*.tsx`, `use-app-shell-*.ts`, many `*-actions.ts` factories.

**Smell:** Logic was **file-sharded**, not **boundary-split**. Nav routing, workbar lifecycle, side-chat, settings close cascades, composer prop fan-out, and module data wiring still close over one React component.

**Why it hurts:** Every new feature still converges on AppShell locals → prop drilling and re-render risk. Tests that pin handlers into `app-shell.tsx` freeze further extraction.

**Direction:**

1. AppShell as composition root only (mount regions + inject controllers).
2. Promote real controllers with stable identity:
   - `SessionWorkspaceController` (messages, live turn, send/stop)
   - `WorkbarController` (tabs + terminal / side-chat IPC)
   - `ShellNavigationController` (navSelection + settings intents)
3. Replace the section ternary forest with a `ShellMainRoute` map.
4. Stop growing `createAppShellXActions({…40 deps})` stars; co-locate action + state.

### A2 — Dual chrome ownership (high)

**Anchors:** titlebar in `app-shell.tsx`; Astryx `AppShell`; settings modal re-shell (`settings-modal.tsx` / `settings-surface.tsx`); workbar tab strip (`session-workbar.tsx`); session identity in both titlebar and `SessionContextLayer`.

**Smell:** Four chrome systems answer “where am I / what can I do.”

**Direction:** One owner per axis — columns → AppShell; session tools → workbar as content region; settings long-term as a shell route (or keep modal but stop copying `agents-layout-root` dual-app styling); titlebar owns name, context layer owns runtime chips only.

### A3 — Workbar is a second window manager (high)

**Anchors:** `session-workbar-tabs.ts`, `use-shell-layout.ts`, `session-workbar.tsx` (~932 lines), AppShell side-chat / terminal effects.

**Smell:** Dual docks, reorder, preview/pin, resource-backed tabs (`terminal:*`, `side-chat:*`) with process lifecycle split between pure reducers and AppShell effects.

**Direction:** `WorkbarController` owns panel state + IPC; split static tool kinds vs ephemeral resource tabs into explicit stores; keep custom tab strip (dnd + `role=tab` is justified) but freeze chrome state explosion behind one Tab model.

### A4 — Settings multi-channel routing (high)

**Anchors:** `settings-surface.tsx` (section + localStorage + `maka:jumpToSettingsSection` + parent intents); `ProvidersPanel` nested catalog/setup/detail; five openers on the host.

**Smell:** Navigation has four channels that can resurrect stale intents (comments in surface already document this class of bug).

**Direction:** Single `SettingsRoute` value (section + optional models sub-route); one opener; kill window event; registry-driven `SettingsPageBody` so nav and body cannot diverge.

### A5 — Chat stack over-composition + composer kitchen sink (high)

**Anchors:** `ChatSurfaceLayout` → desktop message surface → `ChatView` → turns; `Composer` (~1803 lines) with dozens of parallel mode props from AppShell.

**Smell:** Isolation is right; the prop surface is not. Product modes land as parallel booleans instead of one session model.

**Direction:** Keep `ChatSurfaceLayout`; introduce `ComposerSessionModel` (model / permission / plan / swarm / attachments / quotes); assemble desktop chat props in one pane module, not AppShell JSX.

### A6 — Tool preview parallel design system (high)

**Anchors:** `packages/ui/src/tool-activity.tsx` + `tool-activity/**`; `previewVariants` / `ToolOutputSurface` in `primitives/chat.tsx`; ~254 `.maka-*` rules in `packages/ui/src/styles.css`; renderer `chat-message.css` still reaches into tool cards.

**Smell:** Tool UI is a second visual language beside Astryx CodeBlock/Banner. Partial unification (`ToolOutputSurface`) proves the problem was real — the fix grew a package-local DS.

**Direction:** Freeze new preview cards; pure `toolName → PreviewKind` map; generic mono/error → Astryx; structured multi-part results only as product kinds; ban new renderer selectors on `.maka-tool-*` (move overrides into package/theme).

### A7 — CSS dialect sprawl (high)

**Anchors:** three eras on one node — e.g. module mains `maka-main detailPane maka-module-main agents-chat-panel` (`module-pages.tsx`); settings camelCase under `styles/settings/**`; package vs renderer dual ownership.

**Direction:** freeze new `agents-*` / `detailPane` names; package owns chat/tool/module composition CSS; renderer owns shell/workbar/settings only; finish folding transitional `reference-shell` / token-recipe dumps.

### A8 — Module ownership split MCP vs package modules (polish → high if MCP diverges)

**Anchors:** Skills/Plan/Daily in `@maka/ui` `module-pages.tsx`; MCP in desktop `mcp-page.tsx` with its own skeleton dialect.

**Direction:** bridge MCP like DailyReview, or extract only shared list/inspector recipes; one module root class.

### A9 — Action-factory star graph (polish)

**Anchors:** many `app-shell-*-actions.ts` factories re-bound only by AppShell.

**Direction:** hooks that own state; remaining factories take a small `ShellContext`, not 40 named deps.

---

## 3. Astryx style / component coverage gaps

### 3.1 Inventory baseline

| Metric | Post-#2580 audit | After review-debt fix (this branch) |
|--------|------------------|-------------------------------------|
| Files | 183 | 183 |
| blocker | **0** | **0** |
| polish | **4** (exact rows below) | **0** |
| aligned | 179 | 183 |

**Post-#2580 polish rows (historical, for accuracy):**

| Path | Flagged height | What it was |
|------|----------------|-------------|
| `styles/chat-header.css` | `min-height: 40px` | `.maka-session-context__inner` band |
| `styles/settings/bot.css` | `height: 44px` | `.settingsBotLogo[data-large]` |
| `styles/settings/models.css` | `height: 44px` | `.providerLogo` default plate |
| `styles/settings/theme-preview.css` | `height: 34px` | `.settingsPaletteSwatch` |

These were **not** invent-from-whole-cloth “logo false positives” in the abstract — they were the four inventory rows. They were **fixed to the 28/32/36 control rhythm** (36 band / 36 plates / 32 swatch) rather than allowlisted away.

| Metric | Value |
|--------|--------|
| Raw `<button|input|select|textarea>` in product TSX | **none** (comment-stripped scan) |
| `role="button"` fakes | **ChatReasoning eject only** (+ composer querySelector for Astryx collapsibles) |

### 3.2 Gaps by surface family

#### Shell / transcript / plan / graph

| Sev | Gap | Anchors | Status |
|-----|-----|---------|--------|
| **high (P1)** | Plan plates: fill + border + raw multi-shadow | `plan-mode.css` | **Fixed** → `--surface-raised` + border only |
| **high (P1)** | Agent graph plate same stack | `agent-graph.css` | **Fixed** → `--surface-raised` + border only |
| **high (P1)** | Plan status washes hand-rolled oklch | `plan-mode.css` | **Fixed** → `--info-wash` / `--warning-wash` / `--success-wash` |
| **high (P1)** | Quote companion composer raw shadow | `quote-side-panel.css` | **Fixed** → `var(--elevation-raised)` |
| **medium (P2)** | Browser toolbar ad-hoc div | `browser-panel.tsx` | **Fixed** → Astryx `Toolbar` |
| **medium (P2)** | Workbar launcher raw `<kbd>` | `session-workbar.tsx` | **Fixed** → Astryx `Kbd` + token shortcuts |
| **medium (P2)** | Keyboard help raw `<h3>` | `keyboard-help.tsx` | **Fixed** → `Heading level={3}` |
| **medium (P2)** | Web tool result raw `<a>` | `tool-result-preview.tsx` | **Fixed** → Astryx `Link` |
| **medium (P1/P2)** | Deep Research plate washes | `deep-research.css` | **Fixed** → wash tokens |
| **medium (P2)** | Keyboard help raw `<h3>` | `keyboard-help.tsx` | `Heading` / `Text` |
| **low (P3)** | Quote chip / remove / turn footer / lineage re-chrome Astryx Button | `packages/ui/src/styles.css`, `quote-ref-chip.tsx`, `chat-turn.tsx` | shrink overrides; prefer Badge/Token for lineage |
| **low (P3)** | Workbar tab busy uses `Loader2` | `session-workbar.tsx` | `Spinner` if it means loading |

#### Settings / modules

| Sev | Gap | Anchors | Fix |
|-----|-----|---------|-----|
| **medium** | Usage ad-hoc toolbar CSS | `usage-settings-page.tsx`, `settings/usage.css` | `Toolbar` |
| **medium** | Daily review metrics hand layout | `daily-review-panel.tsx` | optional `StatTile` |
| **aligned** | Settings empty/error/skeleton after #2580 | memory, permission, web-search, providers list… | keep kit |
| **intentional** | Providers catalog/setup not own `SettingsPage` | nested multi-level under Models | do not force rows kit |

#### packages/ui compositions

| Sev | Gap | Anchors | Fix |
|-----|-----|---------|-----|
| **medium** | DeepResearchProgressPanel hand plate + washes | `chat-view.tsx` `DeepResearchProgressPanel`, `deep-research.css` | wash tokens; optional later kit |
| **medium** | Web tool result raw `<a>` | `tool-activity/tool-result-preview.tsx` | Astryx `Link` (or document as preview exception) |
| **intentional** | Tool/agent/web preview card chrome | `primitives/chat.tsx`, `styles.css` tool families | content DS, not form controls |
| **intentional** | Chat empty heroes | `chat-empty-hero.tsx` | welcome surface ≠ EmptyState |
| **intentional** | ChatReasoning lab eject | `astryx-chat-reasoning.tsx` | keep until stable peer |
| **intentional** | Astryx patches | `patches/@astryxdesign+core+0.3.0.patch`, `patches/README.md` | conversationKey / tool row / List aria / UA-CH |

### 3.3 Loading kit sprawl (architecture × Astryx)

Empty/error largely share Astryx. **Loading** still has 6+ dialects:

| Recipe | Example |
|--------|---------|
| `maka-lazy-fallback` + Spinner | overlays, workbar suspense, modules |
| `WorkbarPanelLoading` | `session-workbar.tsx` |
| `SettingsSkeletonStack` | settings pages |
| `maka-module-list-skeleton` | `mcp-page.tsx` |
| chat message Spinner | `chat-view.tsx` |
| onboarding Skeleton bars | chat-message-surface |

**Direction:** one product `SurfaceLoading` / `SurfaceEmpty` / `SurfaceError` kit (thin wrappers over Astryx Spinner/Skeleton/EmptyState/Banner).

---

## 4. Prioritized backlog (actionable)

### P0 — Architecture (no visual swap required)

| # | Item | Outcome |
|---|------|---------|
| P0.1 | Extract `WorkbarController` from AppShell | terminal/side-chat lifecycle + tabs in one place |
| P0.2 | `ShellMainRoute` map; AppShell JSX = region mount | kill section ternary forest growth |
| P0.3 | Define `SettingsRoute` single atom | kill multi-flag openers + window event races |

### P1 — Astryx / DESIGN visual system

| # | Item | Status |
|---|------|--------|
| P1.1 | Plan + agent-graph plates → ladder / One Means | **Done** (this branch) |
| P1.2 | Plan status washes → `--*-wash` | **Done** |
| P1.3 | Quote companion composer shadow → elevation token | **Done** |
| P1.4 | Off-rhythm heights (chat-header 40, bot/models 44, swatch 34) | **Done** → 36/36/32 |

### P2 — Primitive consistency

| # | Item | Status |
|---|------|--------|
| P2.1 | Browser toolbar → `Toolbar` | **Done** |
| P2.2 | Workbar launcher → `Kbd` | **Done** |
| P2.3 | Keyboard help headings → `Heading` | **Done** |
| P2.4 | Web tool links → `Link` | **Done** |
| P2.5 | Optional StatTile for daily-review metrics | Open (polish) |
| P2.6 | `SurfaceLoading` kit; retire ad-hoc fallbacks | Open (architecture follow-up) |
| P2.7 | Usage settings toolbar → `Toolbar` | Open (polish) |

### P3 — CSS chrome debt & hygiene

| # | Item | Status |
|---|------|--------|
| P3.1 | Shrink quote-chip / turn-footer / lineage Button overrides | Open (gradual) |
| P3.2 | ~~Allowlist decorative heights~~ | **Superseded** — real polish paths fixed to rhythm |
| P3.3 | Freeze new `agents-*` class names; migrate module root class soup | Open (architecture) |
| P3.4 | Package/renderer CSS ownership rule | Open (architecture) |

### Explicit non-goals (from this review)

- Bulk rewrite of tool preview content language in one PR  
- Forcing providers multi-level into SettingsSection rows  
- Deleting ChatReasoning eject without upstream stable ChatReasoning  
- Expanding residual patches beyond documented host seams  

---

## 5. Spot-check log (verification)

Claims re-checked on disk at review time:

| Claim | Path | Result |
|-------|------|--------|
| AppShell concentration | `app-shell.tsx` ~3099 lines | pass |
| Plan plate uses surface-raised, no freehand shadow | `plan-mode.css` | fixed |
| Agent-graph plate uses surface-raised | `agent-graph.css` | fixed |
| Browser `Toolbar` | `browser-panel.tsx` | fixed |
| Workbar `Kbd` | `session-workbar.tsx` | fixed |
| ChatReasoning `role="button"` (intentional) | `astryx-chat-reasoning.tsx` | exception |
| Settings kit | `settings-section.tsx` | pass |
| Module kit | `primitives/module-page.tsx` | pass |
| Inventory after debt fix | regen | `blocker=0 polish=0 aligned=183` |


---

## 6. Summary for decision-makers

| Question | Answer |
|----------|--------|
| Are we still missing Astryx Buttons? | **No** — raw control blockers are zero. |
| Is the product “Astryx-native”? | **Controls + empty/error yes**; elevation/wash + several layout primitives **fixed in this follow-up**; quote/turn CSS chrome still product dialect. |
| Biggest remaining architectural win? | **De-god AppShell** (P0) — multi-week; not done in this pass. |
| What to leave alone? | ChatReasoning eject, tool preview content cards, providers multi-level IA, residual quote/turn Button geometry until a dedicated chrome pass. |

## 7. Implementation note (follow-up branch)

P1 elevation/wash, off-rhythm heights, and P2 Toolbar/Kbd/Heading/Link were implemented on branch `fix/astryx-review-debt-2026-08-09` after the analysis-only review. Architecture P0 (AppShell controllers) remains backlog.
