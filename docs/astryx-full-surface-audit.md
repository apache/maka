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

# Astryx full surface audit

Date: 2026-08-09  
Branch: `feat/astryx-surface-alignment`  
Scope: every product surface under `apps/desktop/src/renderer/**` and `packages/ui/src/**` (183 inventory files).

This pass **read and analyzed** settings pages/modules, shell/chat/workbar/panels, module hubs, packages/ui compositions, and product CSS — not only inventory scripts.

## Verdict

| Layer | State |
|-------|--------|
| Raw `<button>` / `<input>` / `<select>` / `<textarea>` | **Clear** (product TSX) |
| Inventory blockers | **0** |
| Empty / loading / error contract | **Mostly aligned** after this pass |
| Module kit (Skills / Plan / Daily / MCP) | **Aligned** |
| Settings kit (`SettingsPage` / `SettingsSection`) | **Aligned** (providers multi-level intentional) |
| Remaining debt | CSS control-chrome overrides, plan/graph plate elevation, ChatReasoning lab eject, Deep Research progress card |

## Surfaces reviewed

### Settings (all `*-page.tsx` + major modules)

Aligned: about, appearance, general, data, memory, projects, subagent, web-search, health, permission, usage, bot overview/detail/onboarding/wechat, providers multi-level, catalog, oauth, connection detail, personalization, password-input, skeleton, route header, expandable rows.

### Shell / panels

Aligned core: app-shell family, chat-message-surface, chat-composer-region, chat-workbar, session-workbar (tabs as Button), browser, terminal, review, inspector, import dialog, command palette, onboarding, mcp-page, side-chat confirm, error-boundary.

### Modules / packages/ui

Aligned: skills-panel, scheduled-task-*, daily-review-panel, module-pages, composer, chat-view (loading now Spinner), prompt rail, quote chip, session sidebar/history/list, search-modal, model/permission pickers, mermaid, toast, tool-activity shell.

## Fixed in this pass

| Area | Change |
|------|--------|
| plan-mode | error → `Banner` |
| quote-companion | error → `Banner`; preparing → `Spinner` |
| task-ledger | error → `Banner` |
| web-search | live error → `Banner`; no results → `EmptyState` |
| memory settings | warning callouts → `Banner`; dead CSS removed |
| daily-review settings | loading → `SettingsSkeletonStack` |
| permission center | error wrap in `SettingsPage` |
| provider oauth | error → `Banner` |
| custom pet | empty → `EmptyState isCompact` |
| artifact preview | FailureCard / Unsupported → `Banner` |
| mcp delete | `variant="destructive"` (no inline color) |
| agent-graph empty | compact EmptyState without mixed tier icon |
| chat-view | `messageLoading` → centered `Spinner` |

## Intentional exceptions (do not “fix” without product decision)

1. **`astryx-chat-reasoning.tsx`** — ejected Astryx lab ChatReasoning; keeps official `role="button"` header until stable peer lands.
2. **Providers multi-level** — catalog/setup/detail are nested routes inside SettingsPage, not separate SettingsSection pages.
3. **Usage analytics layout** — metrics/tabs, not settings rows.
4. **Tool / agent / web-search preview cards** — product transcript content chrome, not generic controls.
5. **DeepResearchProgressPanel** — product progress composition; kit-ify is a dedicated design task.
6. **Quote chip / turn footer CSS** — still product-geometry overrides on Astryx controls; shrink chrome gradually.
7. **Logo 44 / swatch 34 / session-context 40** — decorative or band heights, not control rhythm 28/32/36.
8. **ChatReasoning / markdown density contracts** — documented product overrides.

## Remaining backlog (priority)

### P1 — visual system

- plan-mode / agent-graph plate: avoid fill + border + raw shadow stack; prefer raised ladder or single elevation token.
- plan-mode status washes → semantic `--*-wash` tokens.
- quote companion composer elevation → token.

### P2 — primitives consistency

- browser toolbar → Astryx `Toolbar`.
- workbar launcher shortcut → `Kbd`.
- keyboard-help headings → `Heading`/`Text`.
- web tool result links → Astryx `Link`.
- daily-review metrics → optional `StatTile`.

### P3 — CSS chrome debt

- shrink `.maka-quote-chip-remove` / `.maka-turn-footer-action` / lineage badge overrides.
- retire dead tool-terminal CSS if unused.
- inventory polish false-positives for logo/swatch heights.

## Method

1. Regenerated path inventory (183 files).
2. Pattern scan: raw controls, role=button, hand empties, role=alert.
3. Parallel deep-read audits: settings · shell · packages/ui.
4. Implemented P0/P1 semantic gaps from those audits.
5. Typechecked `@maka/ui` + desktop renderer.
