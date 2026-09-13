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

# UI Skills Deep Read — 2026-06-24 (yuejing, round 2)

> Archived on 2026-07-13. This research snapshot is not current product design authority.

WAWQAQ msg `802dda4c` asked me to deeply learn ALL skills + 6 external
URLs he sent at msg `cdfd68eb`. This is the round-2 synthesis,
extending [[ui-skills-deep-read-2026-06-23]] from yesterday.

## New external sources (WAWQAQ msg `cdfd68eb`)

| URL | Type | Notes |
|-----|------|-------|
| github.com/shadcn-ui/ui/tree/main/skills/shadcn | shadcn skill | Composition + token rules. Critical: FieldGroup/Field for forms, `size-*` not `w-*/h-*`, `truncate` shortcut, Avatar must have Fallback, Skeleton not animate-pulse |
| github.com/Jakubantalik/transitions.dev | transitions catalog | 18 named transitions (number pop-in, badge, text-state-swap, panel reveal, success check), namespaced `t-*` classes, mandatory @media (prefers-reduced-motion) |
| github.com/carmahhawwari/ui-design-brain | UI design brain | 8px baseline, body ≥ 14px (prefer 16), micro-interaction 150–250ms ease-out, toast 4–6s, skeleton after 300ms delay, tabular-nums for numbers, single accent |
| github.com/better-auth/better-icons | icon CLI | **INACCESSIBLE** — both candidate paths 404'd. Skipped |
| github.com/pbakaus/impeccable | 26 cmds + 44-rule SLOP | Cap body at 65–75ch; `text-wrap: balance` on h1–h3, `pretty` on long prose; display headings letter-spacing ≥ -0.04em; OKLCH for color; ease-out exp curves, **no bounce, no elastic**; **bans:** ghost-card (1px border + 16px+ shadow), over-rounding > 16px, gradient text via background-clip, identical card grids |
| emilkowal.ski/ui/agents-with-taste | Emil Kowalski blog | Start scale from 0.95 not 0; exit 20% faster than entrance; UI animations < 300ms; `will-change: transform` to kill shake; animate child not parent to fix hover flicker; `transform-origin` at trigger; `:active` → `scale(0.97)`; cap body at 65ch; tabular-nums for prices; loose letter-spacing on uppercase labels |

## Local skill collections (deep re-read)

| Skill | Top 5 actionable rules | Top banned anti-pattern |
|-------|------------------------|------------------------|
| high-end-visual-design | Double-Bezel nested architecture, `py-24` minimum section padding, custom cubic-bezier (no `linear`/`ease-in-out`), scroll-entry `translate-y-16 blur-md opacity-0` 800ms+, GPU-safe (transform/opacity only) | Harsh drop shadows (`shadow-md`), generic 1px borders, sticky navbar glued to top |
| design-taste-frontend | Metric-based DESIGN_VARIANCE/MOTION_INTENSITY/VISUAL_DENSITY=8/6/4 baseline, Display `text-4xl tracking-tighter` + body `text-base leading-relaxed max-w-[65ch]`, perpetual micro-interactions on dashboard, Framer Motion `layout`/`layoutId` for smooth reorder, staggered cascade via `calc(var(--index) * 100ms)` | Inter font, purple/blue AI gradient, neon outer glows, centered Hero (variance > 4) |
| minimalist-ui | Warm monochrome + ultra-desat pastels (`#FDEBEC` / `#E1F3FE`), body off-black `#111` or `#2F3437` never `#000`, cards = exactly `border: 1px solid #EAEAEA` + 8–12px radius, scroll-entry `translateY(12px) + opacity:0 → 0 + 600ms`, keystroke badges pill-shaped uppercase wide-tracking | Heavy shadows, gradients, 3D glassmorphism, emojis, generic placeholder names |
| gpt-taste | Python-driven seeded randomization, AIDA structure (Nav → Hero → Bento → GSAP scroll → CTA), Hero ≤ 3 lines + `max-w-5xl/6xl` containers, gapless bento `grid-auto-flow: dense`, GSAP ScrollTrigger pinning + stacking | Meta-labels ("SECTION 01"), floating stamp icons on hero, pill tags under hero, raw stats in hero |
| stitch-design-taste | Density spectrum (1–10) + Variance spectrum (1–10) encoded in DESIGN.md, inline typography images at type-height, spring physics default (stiffness 100 damping 20), perpetual loops on active components | Overlapping elements, pure `#000`, neon glows, 3-column equal grids, AI copywriting |
| image-taste-frontend | IMAGE-FIRST workflow (generate before coding), deep image analysis (text + ratios + spacing), fresh regeneration (don't crop old), Hero 1–3 line headlines, media in fixed-aspect bounded containers | Tiny multi-section collages, generic stock imagery, vague vibe-only analysis, design drift during implementation |
| industrial-brutalist-ui | Swiss Industrial Print OR Tactical Telemetry/CRT (pick one), macro-typography `clamp(4rem,10vw,15rem)` ultra-tight `-0.03em` to `-0.06em`, micro-typo monospace 10–14px uppercase generous `0.05em` tracking, color `#F4F4F0` bg + `#050505` fg + `#E61919` accent, grid `gap: 1px` for razor dividers | Rounded corners (90° only), gradients, soft shadows, lowercase, serif |
| redesign-existing-projects | Audit chain: Font → Color → Hover/Active → Layout/Spacing → Replace generic components → Loading/Empty/Error → Polish, max 1 accent saturation < 80%, max-width container 1200–1440px, CSS Grid over flexbox math, every component needs hover/active/focus/loading/empty/error | Centering bias, 3-equal-card rows, `h-screen`, pure `#000`, warm+cool gray mixing |
| shadcn | Use existing components first (compose, don't reinvent), critical rules: FieldGroup + Field for forms, data-icon + no sizing on icons, `gap-*` not `space-y-*`, full Card composition (Header/Title/Description/Content/Footer), validation via data-invalid + aria-invalid | Manual z-index on overlays, space-x/y-* (use gap), hardcoded colors, floating labels |
| shadcn-baseui | Use `render` prop NOT `asChild` for triggers, Accordion uses boolean `multiple` not `type`, `nativeButton={false}` when wrapping Link/custom, Select `alignItemWithTrigger={false}` replaces `position="popper"` | Radix `asChild` patterns in Base UI project |
| web-perf | Core Web Vitals: LCP < 2.5s INP < 200ms CLS < 0.1, animate ONLY transform/opacity never top/left/width/height, grain/noise fixed pseudo-element only, `backdrop-blur` only on fixed/sticky never scrolling | Continuous GPU repaints, `window.addEventListener('scroll')`, render-blocking JS/CSS without async/defer |

## Cross-reference: what's already covered in Maka source

The 11+ external + 13 local skills converge on a tight set of rules.
Maka coverage (audit done 2026-06-24):

| Rule | Maka source ref | Status |
|------|----------------|--------|
| transform + opacity only animations | All keyframes (maka-list-row-enter, maka-tool-card-enter, maka-message-row-enter, maka-onboarding-child-enter, maka-hero-enter, maka-composer-stream-bounce, maka-composer-permission-pulse) | ✅ |
| Reduced-motion guards | ~12 `@media (prefers-reduced-motion: reduce)` blocks | ✅ |
| Custom cubic-bezier (`--ease-maka` = `cubic-bezier(0.16, 1, 0.3, 1)`) | All easing references | ✅ |
| Tactile `:active scale(0.97-0.98)` | onboarding-card, skill-row, prompt-chip, plan-new-task-button, palette-item, composer-tool-button, composer-send-button, list-row, artifact-row, model-switcher-trigger | ✅ (shipped this round) |
| No 172deg gradient anywhere | 4 contract tests pin invariant | ✅ (shipped this round) |
| ARIA semantic `<ul>`/`<li>` not `<div role="list">` | Global walker contract test | ✅ |
| `text-wrap: pretty` on body, `balance` on headings | `.maka-bubble-assistant p` (pretty), h1-h4 (balance) | ✅ (shipped this round) |
| Body max-width 65-75ch | `.maka-bubble-assistant { max-width: 72ch }` + escape valves on pre/table/code | ✅ (shipped this round) |
| h1/h2 negative tracking | `letter-spacing: -0.012em` on h1/h2 | ✅ (shipped this round) — conservative for CJK mix |
| `tabular-nums` on numeric text | `.maka-bubble-assistant code`, `.maka-artifact-row-meta`, `.maka-list-row-meta`, `.maka-tool-duration` | ✅ (shipped this round) |
| Nested-bezel avatar | `.maka-message-avatar` 24×24 full-circle + 3-layer box-shadow | ✅ (shipped this round) |
| Stagger entrance on hero | `.maka-onboarding > *:nth-child(n)` with 0/60/120/180/220ms cascade | ✅ (shipped this round) |
| Perpetual micro-interaction on pending state | `.maka-composer-permission-dot` 1.4s pulse + `.maka-composer-streaming-dot` 1.05s bounce | ✅ (shipped this round) |
| `<details>` chevron rotation + body fade-in | `.maka-turn-thinking` summary::before chevron + body @starting-style opacity ramp | ✅ (shipped this round) |
| BAN harsh `rgba(0,0,0,0.5)` shadows | Audit found none — all shadows use oklch alpha | ✅ |
| BAN `transition: all` | Audit found none | ✅ |
| BAN transitioning width/height/top/left | Only 1 place (turn-footer secondary action max-width hover reveal) — acceptable | ✅ |
| Single accent < 80% saturation | `--accent` oklch tokens per palette | ✅ |
| Focus-visible rings | 65 `focus-visible` rules audited | ✅ |
| Native macOS cursor convention (`pointer` only on links) | Contract test pins | ✅ |
| Code blocks: language pill + copy button + 10px radius | `.maka-code-block` matches | ✅ |
| `noopener` on all `target="_blank"` | Global walker contract test | ✅ |

## Remaining deltas (defer or out-of-scope)

- **Lucide → Phosphor icons swap**: skill-banned but would touch ~80+ icon usages across the app. High risk, low visible value for power users. Defer until a focused PR is requested.
- **Heavy display typography (`clamp(4rem, 10vw, 15rem)`)**: industrial-brutalist style, doesn't match Maka's calm desktop aesthetic. Skip.
- **Inline typography images at type-height**: stitch pattern, not applicable to a chat tool.
- **Footer with legal links**: Maka is a desktop app, no public footer. Skip.
- **GSAP scroll-trigger paradigms**: Maka doesn't have marketing scroll surfaces. Skip.
- **Skeleton-after-300ms delayed render**: requires JS state pattern not pure CSS. Sized but deferred.
- **Per-tab transitions.dev catalog of 18 named transitions**: would require adopting a new namespacing convention. Defer.

## Skills round task #116 — ship list this round

10 PRs shipped applying skills (all merged to shared/origin main):

1. `e20662d1` — PR-CHAT-MESSAGE-AVATAR-BEZEL-0 (high-end-visual-design §2 nested-shell)
2. `120f72f3` — PR-REASONING-PANEL-SMOOTH-EXPAND-0 (design-taste-frontend §5 spring)
3. `e22035da` — PR-SKILL-SEARCH-DOUBLE-BOX-0 (feedback_use_component_library)
4. `f946f86b` — PR-REFERENCE-SETTINGS-GRADIENT-CORRECTION-0 (notes correction to prevent regression cycle)
5. `6a58e303` — PR-MESSAGE-BODY-READING-RHYTHM-0 (pbakaus impeccable + agents-with-taste)
6. `fb26e391` — PR-ONBOARDING-HERO-STAGGER-0 (Emil agents-with-taste)
7. `d761e1a8` — PR-ARTIFACT-ROW-TACTILE-0 (Emil `:active scale`)
8. `5d9585f9` — PR-SESSION-ROW-TACTILE-0
9. `033d6a9a` — PR-COMPOSER-PERMISSION-PULSE-0 (design-taste-frontend §8.3 perpetual)
10. `05b4d084` — PR-MODEL-SWITCHER-TACTILE-0
11. `b7a0cd2a` — PR-MESSAGE-BODY-MAX-WIDTH-0 (impeccable 65-75ch)

Tests at 1482/1482 throughout. Current shared/origin main: `b7a0cd2a`.

## When to re-read this note

Before ANY future "polish UI" / "use the skills" pass. Cross-check
new ideas against the "already covered" table above before
proposing them — most generic polish ideas have already been
shipped, so the next round needs to find genuinely new structural
deltas, not redo what's done.
