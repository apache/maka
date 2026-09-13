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

# UI Skills Deep Read — 2026-06-23 (yuejing)

> Archived on 2026-07-13. This research snapshot is not current product design authority.

3 parallel Explore agents deep-read 5 design-skill collections per WAWQAQ
ask `f424c6b5`. Synthesis below — converged rules + maka delta + 1 final
ship list.

## Sources

| Source | Type | Repo |
|--------|------|------|
| Impeccable | 26 commands + 44-rule SLOP catalog | github.com/pbakaus/impeccable |
| UI Skills | 15-skill collection (baseline-ui, fixing-a11y, fixing-motion-performance, 12-principles-of-animation, fixing-metadata, etc.) | github.com/ibelick/ui-skills + github.com/raphaelsalaja/skill |
| Taste-Skill | taste / redesign / soft variants | github.com/Leonxlnx/taste-skill |
| UI Design Brain | 60+ component best practices | github.com/carmahhawwari/ui-design-brain |
| Better Icons | MCP + skill, 200k icons | github.com/better-auth/better-icons |

## Convergent rules across all 5 sources

These showed up in **3+ sources** independently. Highest signal.

| Rule | Sources | Maka delta |
|------|---------|-----------|
| Body text ≥ 14-16px, weights 400/500/600 with semantic contrast | Impeccable /typeset, baseline-ui, Taste-Skill, UIDB | hint 13px → 14, no display face |
| **Tactile :active = `scale(0.98)` or `translateY(1px)`** | Taste-Skill, UIDB, 12-principles | rows/nav/back have no `:active` |
| Compositor-only motion (`transform`/`opacity` only, ≤ 200ms) | baseline-ui, fixing-motion-perf, Impeccable /animate | Maka may transition `background-color` on hover (paint) — acceptable but verify nothing animates layout |
| Reduced-motion guards | All 5 | ✅ done round 11 |
| Single accent, saturation < 80%, OKLCH neutrals tinted toward brand | Taste-Skill, Impeccable /colorize | maka uses raw `%foreground` overlays, no brand tint |
| 8px grid; double whitespace as redesign default | Taste-Skill, UIDB, Impeccable /layout | row padding 20/24 off-grid (should be 16/24 or 24/24) |
| Toggle/touch target ≥ 44px hit area | Taste-Skill, UIDB | switch 26×46 visual, no hit padding |
| Sidebar primary nav 5-7 items, distinct active state | UIDB, Taste-Skill | maka has more than 7 in "AI 与集成" group — could collapse; active state is light-fill, no accent bar |
| One CSS variable for all motion timings (no scattered ms values) | 12-principles "timing-consistent" | Maka has scattered 150ms values, no `--motion-fast` token |
| `text-balance` on heading, `text-pretty` on body | baseline-ui | not used |
| `tabular-nums` on data/numeric labels | baseline-ui, Impeccable /typeset | not used; value cells `已启用 / zai-live` would benefit |
| No display tracking modification unless explicit | baseline-ui | h2 has `-0.012em` (intentional, OK) |
| Em-dash ban | Taste-Skill, redesign | grep needed |
| Inter/system as default font flagged as "AI tell" | Taste-Skill, redesign, soft | maka is system-ui default — flagged |
| Lucide-as-default flagged | Taste-Skill | maka is lucide-react — flagged, Better Icons proposed |
| Card OR border, not both | Impeccable rule 36, UIDB, Taste-Skill | mostly ✅ (.settingsRows is border-only) but `.settingsConnectionRow` still has border + shadow |
| Visible focus ring (`:focus-visible` 2px) | fixing-a11y, Impeccable /audit | ✅ done round 11 |
| Page header height 56-72px | UIDB | maka uses padding stack, not a true bar — partial |

## Anti-patterns triggered by maka today

- **Impeccable rule 11 (card overuse / nested cards):** every settings page renders multiple `.settingsRows` blocks stacked, each with own card chrome. Could be one card with section dividers (per /distill).
- **Impeccable rule 25 (raw neutrals not tinted toward brand):** `.settingsRows` border is `oklch(from var(--foreground) l c h / 0.08)`. Tinting toward `--accent` at 0.005-0.01 chroma would carry brand into chrome.
- **Taste-Skill banned: border-b on every row.** ❌ — wait, maka DOES use `border-bottom` hairlines between rows. WAWQAQ asked for this explicitly in PR-GROUPED-CARD-0 ("内容紧密、用分隔线划开"), so this disagreement stays unresolved between Taste-Skill and WAWQAQ. Defer to WAWQAQ.

## 10 highest-value action items for maka

Ranked by impact / effort:

1. **Tactile `:active` scale** on rows, nav items, back button. 
   - `.settingsFormRow:active, .settingsRow:active, .settingsNavItem:active, .settingsBackButton:active { transform: scale(0.985); transition: transform 100ms cubic-bezier(0.16, 1, 0.3, 1); }`
   - Reduced-motion gate already in place — fires inside the `@media (no-preference)` branch.

2. **Sidebar active accent bar** (Redesign-Skill).
   - `.settingsNavItem[data-active="true"] { box-shadow: inset 3px 0 0 var(--accent); }`
   - Carries brand into the most-used surface.

3. **`tabular-nums` on value cells**.
   - `.settingsRow > span { font-variant-numeric: tabular-nums; }`
   - Numeric values like `zai-live`, version strings, counts align cleanly.

4. **`text-balance` / `text-pretty`** on page header.
   - `.settingsPageHeader h2 { text-wrap: balance; }`
   - `.settingsPageHeaderDescription { text-wrap: pretty; }`

5. **Hint floor 13 → 14px**.
   - `.settingsFormRow small, .settingsField small { font-size: 14px; }` (currently 13)
   - Crosses the 14px legibility floor that baseline-ui + UIDB + Impeccable converge on.

6. **Switch hit-area shim**: 44×44 invisible hit target around the 26×46 visual.
   - Wrap `<Switch>` in a `min-width:44px; min-height:44px;` flex container.

7. **One motion token**.
   - `--motion-fast: 160ms` + `--motion-ease-out: cubic-bezier(0.16, 1, 0.3, 1)`.
   - Reuse across nav / row / switch / input transitions.

8. **OKLCH brand tint on settings chrome**.
   - `.settingsRows` border from `from var(--foreground) ... / 0.08` to `oklch(from var(--accent) l c h / 0.08)`.
   - Subtle brand carry without changing perceived neutrality.

9. **Em-dash + AI-slop copy grep**.
   - Audit `apps/desktop/src/renderer/settings/SettingsModal.tsx` for `—`, "Seamless", "Elevate", "Unleash".
   - Quick mechanical cleanup.

10. **Better Icons MCP install (deferred ship)**.
    - Add to `.mcp.json`. Don't migrate icons in this lane — let it learn preferred families per surface first. Lucide stays default for now.

## Defer / out-of-lane

- **Font swap** (Geist/Cabinet Grotesk/Satoshi instead of system-ui): meaningful but needs font files in the bundle, license check, and broad visual regression. Worth its own PR.
- **Nav consolidation to ≤7 in big group**: would re-split AI 与集成. Defer; WAWQAQ already approved 3 groups in round 7.
- **Card overuse / merge stacked cards**: contradicts WAWQAQ's grouped-card direction. Don't change.

## Round 15 (final) PR plan

Bundle action items 1, 2, 3, 4, 5, 7 (highest-impact, single-CSS-file). Skip 6 (component wrap), 8 (brand tint risk), 9 (audit), 10 (config) — those need their own PRs.

PR-SETTINGS-MOTION-TYPO-TOKENS-0:
- `:active` scale on rows/nav/back (item 1)
- accent bar on active nav (item 2)
- tabular-nums on row value (item 3)
- text-balance / text-pretty on header (item 4)
- hint 13→14 (item 5)
- shared `--motion-fast` token (item 7)
