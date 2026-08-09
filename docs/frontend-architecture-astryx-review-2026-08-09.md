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

### 3.1 Inventory baseline (disk, 2026-08-09)

| Metric | Value |
|--------|--------|
| Files | 183 |
| blocker | **0** |
| polish | 4 (logo/swatch/session-context band heights — **decorative false positives**) |
| aligned | 179 |
| Raw `<button|input|select|textarea>` in product TSX | **none** (comment-stripped scan) |
| `role="button"` fakes | **ChatReasoning eject only** (+ composer querySelector for Astryx collapsibles) |

### 3.2 Gaps by surface family

#### Shell / transcript / plan / graph

| Sev | Gap | Anchors | Astryx / system fix |
|-----|-----|---------|---------------------|
| **high (P1)** | Plan plates: fill + border + **raw multi-shadow** | `styles/plan-mode.css` `.plan-proposal-card`, execution plate | `--surface-raised` + border **or** single `var(--elevation-raised)` — not both + freehand shadow |
| **high (P1)** | Agent graph plate same stack | `styles/agent-graph.css` `.maka-agent-graph-panel` | same |
| **high (P1)** | Plan status washes hand-rolled `oklch(from var(--warning)…)` | `plan-mode.css` status markers | `--warning-wash` / `--success-wash` / `--info-wash` |
| **high (P1)** | Quote companion composer raw shadow | `styles/quote-side-panel.css` | elevation token or flat |
| **medium (P2)** | Browser toolbar ad-hoc div | `browser-panel.tsx` `.maka-browser-toolbar` | Astryx `Toolbar` |
| **medium (P2)** | Workbar launcher `<kbd>` | `session-workbar.tsx` | Astryx `Kbd` |
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

| # | Item | Anchors |
|---|------|---------|
| P1.1 | Plan + agent-graph plates → ladder / single elevation | `plan-mode.css`, `agent-graph.css` |
| P1.2 | Plan status washes → `--*-wash` | `plan-mode.css` |
| P1.3 | Quote companion composer shadow → token or flat | `quote-side-panel.css` |

### P2 — Primitive consistency

| # | Item |
|---|------|
| P2.1 | Browser / usage toolbars → `Toolbar` |
| P2.2 | Workbar launcher → `Kbd` |
| P2.3 | Keyboard help headings → `Heading`/`Text` |
| P2.4 | Web tool links → `Link` (or document exception) |
| P2.5 | Optional StatTile for daily-review metrics |
| P2.6 | `SurfaceLoading` kit; retire ad-hoc fallbacks |

### P3 — CSS chrome debt & hygiene

| # | Item |
|---|------|
| P3.1 | Shrink quote-chip / turn-footer / lineage Button overrides |
| P3.2 | Inventory polish allowlist for logo/swatch/band heights |
| P3.3 | Freeze new `agents-*` class names; migrate module root class soup |
| P3.4 | Package/renderer CSS ownership rule (no new renderer selectors on tool cards) |

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
| Plan fill+border+shadow stack | `plan-mode.css` `.plan-proposal-card` | pass |
| Agent-graph plate stack | `agent-graph.css` | pass |
| Browser ad-hoc toolbar | `browser-panel.tsx` `.maka-browser-toolbar` | pass |
| ChatReasoning `role="button"` | `astryx-chat-reasoning.tsx` | pass |
| Quote remove chrome still product CSS | `packages/ui/src/styles.css` `.maka-quote-chip-remove` | pass |
| Settings kit exists | `settings-section.tsx` `SettingsPage` | pass |
| Module kit on Astryx Layout | `primitives/module-page.tsx` | pass |
| Workbar raw `<kbd>` | `session-workbar.tsx` | pass |
| Inventory blockers 0 | regen 2026-08-09 | pass (`blocker=0 polish=4 aligned=179`) |
| ChatLayout host identity seam | `patches/README.md` (conversation identity without remount) + `chat-surface-layout.tsx` | pass |

Inventory unit tests: `node --test scripts/check-astryx-surface-inventory.test.mjs scripts/check-astryx-alignment.test.mjs` → **5/5 pass** (evidence in scan log).

---

## 6. Summary for decision-makers

| Question | Answer |
|----------|--------|
| Are we still missing Astryx Buttons? | **No** — raw control blockers are zero. |
| Is the product “Astryx-native”? | **Mostly** for controls and empty/error; **not yet** for elevation hygiene or chrome CSS overrides. |
| Biggest architectural win? | **De-god AppShell** into Workbar + Session + Navigation controllers; treat settings as one route type. |
| Biggest design-system win? | **One Means** on plan/graph plates + wash tokens; then Toolbar/Kbd consistency. |
| What to leave alone? | ChatReasoning eject, tool preview content cards, providers multi-level IA, decorative logo/swatch sizes. |

This document is the analysis deliverable for the 2026-08-09 full frontend review goal. Implementation of P0–P3 is intentionally **out of scope** here.
