---
name: Maka
description: A companion command center for completing real work with agents.
colors:
  brand-mark: "#71a8fd"
  accent-light: "oklch(0.70 0.135 250)"
  accent-dark: "oklch(0.74 0.15 250)"
  primary: "oklch(0.52 0.135 250)"
  accent-solid-dark: "oklch(0.76 0.15 250)"
  on-accent-light: "#ffffff"
  on-accent-dark: "#171717"
  surface-raised-light: "oklch(1 0 0)"
  surface-base-light: "oklch(0.975 0 0)"
  surface-sunken-light: "oklch(0.945 0 0)"
  ink-light: "oklch(0.17 0.005 286)"
  surface-raised-dark: "oklch(0.205 0.004 286)"
  surface-overlay-dark: "oklch(0.225 0.004 286)"
  surface-base-dark: "oklch(0.18 0.004 286)"
  surface-sunken-dark: "oklch(0.14 0.004 286)"
  ink-dark: "oklch(0.95 0.004 286)"
  info-light: "oklch(0.50 0.13 240)"
  info-dark: "oklch(0.74 0.13 240)"
  success-light: "oklch(0.50 0.17 145)"
  success-dark: "oklch(0.60 0.17 145)"
  warning-light: "oklch(0.50 0.18 55)"
  warning-dark: "oklch(0.66 0.18 55)"
  destructive-light: "oklch(0.50 0.24 28)"
  destructive-dark: "oklch(0.70 0.19 22)"
typography:
  display-1: { fontSize: "28px", fontWeight: 400, lineHeight: 1.4286 }
  display-2: { fontSize: "25px", fontWeight: 400, lineHeight: 1.44 }
  display-3: { fontSize: "22px", fontWeight: 400, lineHeight: 1.4545 }
  heading-1: { fontSize: "20px", fontWeight: 600, lineHeight: 1.4 }
  heading-2: { fontSize: "18px", fontWeight: 600, lineHeight: 1.5556 }
  heading-3: { fontSize: "16px", fontWeight: 600, lineHeight: 1.5 }
  heading-4: { fontSize: "14px", fontWeight: 600, lineHeight: 1.4286 }
  heading-5: { fontSize: "12px", fontWeight: 600, lineHeight: 1.6667 }
  body: { fontSize: "14px", fontWeight: 400, lineHeight: 1.4286 }
  label: { fontSize: "14px", fontWeight: 500, lineHeight: 1.4286 }
  supporting: { fontSize: "12px", fontWeight: 400, lineHeight: 1.6667 }
  code: { fontSize: "14px", fontWeight: 400, lineHeight: 1.4286 }
  badge-label: { fontSize: "12px", fontWeight: 500, lineHeight: 1.6667 }
rounded:
  control: "6px"
  card: "10px"
  container: "12px"
  pill: "999px"
spacing: { space-0-5: "2px", space-1: "4px", space-1-5: "6px", space-2: "8px", space-2-5: "10px", space-3: "12px", space-4: "16px", space-5: "20px", space-6: "24px", space-8: "32px", space-10: "40px", space-12: "48px", space-16: "64px" }
components:
  button-default: { typography: "{typography.label}", rounded: "{rounded.card}", padding: "8px 12px", height: "32px" }
  button-primary-light: { backgroundColor: "{colors.primary}", textColor: "{colors.on-accent-light}", typography: "{typography.label}", rounded: "{rounded.card}", height: "32px" }
  button-primary-dark: { backgroundColor: "{colors.accent-solid-dark}", textColor: "{colors.on-accent-dark}", typography: "{typography.label}", rounded: "{rounded.card}", height: "32px" }
  input-default: { typography: "{typography.body}", rounded: "{rounded.card}", height: "32px" }
  badge: { typography: "{typography.badge-label}", rounded: "{rounded.pill}", padding: "0 8px", height: "20px" }
  card-default: { rounded: "{rounded.container}", padding: "12px" }
---
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

# Design System: Maka

## 1. Overview

**Creative North Star: "The Companion Command Center"**

Maka is a desktop workspace for directing, supervising, and completing real work with agents. The task stays central; activity, permissions, failures, recovery, and generated work remain inspectable without turning the window into a monitoring dashboard.

The system is calm, native, and compact: spacious around reading and decisions, dense where comparison matters. Humanity comes from useful language and continuity, not simulated personality.

This document governs the default light and dark themes. Optional palettes may change canvas, ink, accent, and semantic colors, but must preserve their roles, contrast, and hierarchy.

**Authority:** `apps/desktop/src/renderer/astryx-theme/makaTheme.ts` owns type, neutral remaps, and theme-level component overrides; `apps/desktop/src/renderer/maka-tokens.css` owns product palettes, spacing, radii, and product motion; Astryx owns primitive geometry, states, and internal motion; product source owns Maka-specific compositions. Generated `apps/desktop/src/renderer/astryx-theme/maka.css` is not an editing authority. The bridge into Astryx is not one file: `makaTheme.ts` remaps the neutral stack, `maka-tokens.css` bridges the accent family, and `astryx-mount.css` carries a text/icon/border seam scoped to named containers. Changing what a primitive paints means checking all three files.

Frontmatter is a snapshot of the current default theme. When it diverges from source or contract tests, source and tests win and this document must be refreshed.

## 2. Surfaces

Depth is a ladder, not a decoration. Every background resolves to one of four semantic tiers, each derived from `--background` with cumulative offsets — palettes override only `--background` and the ladder follows. Note that `--background` is the card fill, not the page color; older surface names are aliases onto these tiers, and `maka-tokens.css` is where that mapping lives.

| Tier | Token | Role |
|---|---|---|
| sunken | `--surface-sunken` | recessed chrome inside a plate |
| base | `--surface-base` | shell floor: sidebar + canvas behind plates |
| raised | `--surface-raised` | cards, content plates, reading surfaces |
| overlay | `--surface-overlay` | menus, popovers, dialogs, toasts |

**The Height Rule.** Height maps monotonically to lightness in both modes, and reading surfaces always occupy the brightest tier of their mode. In light mode the ladder tops out at pure white, so `raised` and `overlay` share the fill and overlay separation hands off to the floating recipe (§5). Light mode "higher = darker" is permanently forbidden — it makes elevation shadows contradict the fill.

**The Canvas Recedes Rule** (owner decision 2026-06-20). The canvas is gray; content surfaces are white. Shell floor is two colours: sidebar and canvas share `base`, content plates sit on `raised`. Contrast between canvas and plate is the primary separator.

**Paper.** `--surface-paper` sits outside the ladder on purpose and has no dark override. It backs content whose contrast we neither author nor may invert: the sandboxed HTML-artifact iframe and the PDF embed, and QR codes, where dark-on-light is a scanning requirement rather than a preference. It is not a fifth tier and app chrome never uses it.

## 3. Ink

Prose uses exactly three tiers — `--foreground`, `--foreground-secondary`, `--muted-foreground` — spaced at an even ~2× contrast rhythm against `--surface-raised`, every one of them clearing WCAG AA in both modes. Any new tier must hold that rhythm and that floor.

- **The Three-Tier Reading Rule.** Prose uses primary, secondary, or muted. Neutral washes are surfaces, not extra text tiers. `--foreground-dimmed` is retired — its call sites name secondary directly — and must never come back with a definition of its own (contract-tested).
- **The One Colorspace Rule.** Every derivation inside a token family uses one colorspace (`oklch` for ink, contract-tested). Mixing `srgb` and `oklch` derivations produces "same literal, different value" drift, and the ladder is where it bites hardest because its rungs only mean anything relative to each other.
- **Astryx's `secondary` is not this ladder's secondary.** `Text color="secondary"` reads `--color-text-secondary`, which resolves to a fixed neutral literal outside the containers `astryx-mount.css` bridges and to `--muted-foreground` inside them. Neither is `--foreground-secondary`. One word, three results — so pick an ink tier by the token, and treat a primitive's color prop as its own vocabulary.
- **Links use the solid accent tier** (`--accent-solid`), never raw `--accent` — the accent identifies interaction, and the solid tier is the only accent variant that clears text contrast on every palette. A selection wash or outline is not link text and derives from `--accent` instead — deriving a surface from the link name lets a text-contrast rule silently govern a background.

## 4. Borders

Three strengths, each a job, spaced at ~1.6× like the ink ladder:

- `--border-soft` (6% ink): quiet separation inside a plate — rails, row dividers that fills can't carry.
- `--border` (10% ink): structural boundaries between regions.
- `--border-strong` (16% ink): emphasis chrome — selected and active outlines, emphasized region boundaries, and the scrollbar thumb (§9). It is not "the border for when you're unsure," and it is not the general-purpose strong neutral: anything wanting a neutral *tint* at that weight takes `--foreground-alpha-16`. A hairline drawn with `background` is still a border and keeps it.
- `--ring-soft` is a 1px ring drawn with box-shadow (`0 0 0 1px`) at the soft tier's own 6% alpha. It belongs to this chapter, not §5: a token is filed by the job it does, not by the CSS property it happens to use, and a shadow-shaped name on a border attracts call sites that wanted lift.

**The One Means Rule.** Each boundary picks one separator: a fill step, a line, or a shadow — never stacked on the same edge.

## 5. Elevation

Default surfaces are flat. Depth comes first from the surface ladder, then a line, then shadow only when an element genuinely floats above the plane.

- Three steps, named for their job: `--elevation-raised`, `--elevation-overlay`, `--elevation-drag`. Product CSS names these rather than the theme scale underneath — a shadow whose name means nothing at a call site is how the scale sat unused for months while one raw atom did all the work.
- **The Floating Recipe.** Every portal surface (menu, popover, dialog, toast) is: `--surface-overlay` fill + `--border-soft` ring + `--elevation-overlay` + `overflow: hidden` + container radius. No portal invents its own mix, including Astryx's own shared layer surface — it is held to the recipe through a vendor patch that supplies a hook class and no values, on the terms recorded in `patches/README.md`. Tooltips are out of scope: a transient label is not a surface that holds content.
- Dark mode relies on tone and rings before shadow. Neon edges and lifted-everything styling are forbidden.
- Native shell vibrancy is allowed only in designated material; generic glassmorphism is not.

**The One Working Plane Rule.** Dividers separate responsibilities; cards and shadows do not fragment the workspace into a dashboard grid.

## 6. Radius

Nothing interactive is square. One ladder, assigned monotonically by box height:

| Radius | Maka tier | Astryx tier | Assign to |
|---|---|---|---|
| 6px | control | inner | chips, keycaps, nested inlays, and product-drawn compact controls |
| 10px | card | element | cards, rows-as-cards, list containers; Astryx `Button`, `Input`, `SegmentedControl` |
| 12px | container | container | modals, panels, portal surfaces; Astryx `Card`, `Dialog`, `DropdownMenu` |
| 28px | chat | chat | the conversation surface as one shape: user bubble, assistant bubble, composer dock. Sourced from Astryx's `--radius-chat` by `ChatMessageBubble` and `ChatComposer` themselves; product CSS never restates it |
| full | pill (999px) | full (9999px) | badges, pills, circular controls |

- **The Two-Name Rule.** These are one ladder under two vocabularies, and the names never line up: Maka's `control` is Astryx's `inner`, Maka's `card` is Astryx's `element`, Maka's `modal` is Astryx's `container`. Resolve a tier from the box, never from the token name that sounds right. The paired values agree *today* but are independent literals, not aliases — an Astryx upgrade can move one side silently, so a mismatch is a real failure mode rather than an impossibility. The chat rung is the one tier the product does not assign: `ChatMessageBubble` and `ChatComposer` both resolve `--radius-chat` on their own, which is why the bubble and the dock round together, and why setting a bubble radius or a non-default `density` in product code silently breaks the pair. Astryx's `--radius-page` carries the same 28px literal but is a different token with no Maka tier and no product consumer; reaching for it to match the chat surface is inventing a rung.
- **The Full-Bleed Rule.** `border-radius: 0` is legal only on true full-bleed rows — an element flush with its container on both sides. Radius and gap move together: if it has breathing room, it has corners.
- **Proportional marks.** Product-drawn icon plates use ratio-owned radius (~25–27% of the box edge), recorded in prose because Stitch accepts only absolute units.

## 7. Typography

Use the system UI stack with explicit platform CJK fallbacks; Geist Variable is a late fallback. Code uses Geist Mono Variable, JetBrains Mono, then platform monospace. Chinese and Latin must read as one interface.

- **Display 1–3:** rare large statements and empty-state anchors.
- **Heading 1–6:** page, panel, section, and compact-title hierarchy, down to an 11px semibold rung.
- **Body:** conversation and normal reading.
- **Large:** body-sized lead-in copy at semibold — the only role above body that is not a heading.
- **Label:** controls and interactive labels.
- **Supporting:** metadata and compact secondary copy.
- **Code:** code, paths, commands, identifiers, and machine evidence.

**The Role, Not Axes Rule.** Choose an Astryx text role or a Maka role composed from it. Never assemble literal family, size, weight, or line height at a product call site.

**The Four-Pixel Line Rule.** Text line boxes land on the 4px grid. Mono is technical, never decorative.

## 8. Color Specification

The palette is cool-neutral and quiet; color is generated to spec, not picked by eye.

- **Brand mark** is fixed `#71a8fd`; it identifies Maka and is never the general CTA color.
- **Interaction accent** follows the active palette for focus, selection, and live state; **links and accent-colored text use the solid tier** (§3). Astryx's own semantic components are the exception — `Badge` and `StatusDot` carry fixed literals inherited from the neutral theme and follow neither the palette nor the families below.
- **Status families** — `--info`, `--success`, `--warning`, `--destructive` — are generated, not picked: one lightness per mode, each hue keeping its own chroma, every member clearing AA. The residual contrast spread within a mode is hue physics — at equal lightness, yellow carries more luminance than blue — and flattening it would abandon the shared-lightness premise that makes them a family. All four are declared in one block per mode, because the time warning sat thirty lines from its siblings is the time it lost its dark override and dropped under AA unnoticed. A louder band at ~90% gamut chroma exists only for 8px status dots: dots must read at a glance, washes must not shout. These are colors; what a state *means* is a separate vocabulary (§9).
- **Tinted surfaces** (status washes behind rows and banners) derive from the same status hues; hand-rolled `oklch()` status washes at call sites are forbidden — consume the family. The family is `--{status}-wash` (0.08 fill) and `--{status}-wash-border` (0.24, ~3x the fill), every member derived with `oklch(from var(--{status}) ...)` so a status regeneration flows through it. A **strong** tier (0.12 / 0.40) exists for warnings about data destruction or an action the user cannot undo, and for nothing else — it is not the loud option for a notice that wants attention. Palette swatches are not washes: a swatch's job is to show a palette's real colour, so its literals stay. The family is kept complete even where a rung has no consumer yet: a family with holes in it sends the next author back to hand-rolling an alpha, which is the etiology of the fourteen that drifted.
- **Identity colors** (avatars, channel marks) live in one 4.2–4.8:1 contrast band; desaturation for muted states happens at constant OKLab lightness.

**The Signal, Not Texture Rule.** Accent communicates action or state. Never use it as a background flood, gradient, glow, or substitute for hierarchy.

## 9. Components

Use Astryx primitives as the default seam. New work composes product meaning through published props, tokens, and stable `themeProps` extension points; internal-DOM overrides are acknowledged transitional states, not precedent.

- **Controls:** Maka uses a 20/24/28/32/36/40px height ruler with 32px as the default; Astryx owns the 28/32/36px variants. Hover is restrained; press may use `scale(0.98)`; keyboard focus is always visible. At most one inverted (filled) element per control. Hover washes come in exactly two lanes: product rows and controls take `--state-hover-bg`; chrome that must stay in lockstep with Astryx internals takes `--color-overlay-hover`. Hand-mixed hover alphas are drift.
- **Fields:** labels, descriptions, and validation belong to the field primitive; input focus belongs to its control. Keep disabled reasons discoverable through the owning control's tooltip; do not rebuild field chrome around a bare input.
- **Badges and status:** Badge is 20px high and pill-shaped. Choose variants by meaning, not hue.
- **Status vocabulary:** what a state means is named once, in `packages/ui/src/status-vocabulary.ts`, and every status dot resolves its color through it — a surface never maps its own domain state onto a color. The semantics are `success` (proven healthy), `active` (the system is working), `attention` (waiting on a person), `error` (broken now), `neutral` (a settled fact); collapsing `active` and `attention` is the mistake that vocabulary exists to prevent. It deliberately has no `info` — two callers meant opposite things by it — but that is a statement about *dot semantics*, not about the `--info` color, which is live. Note that Astryx's `Badge` and `StatusDot` render fixed inherited literals, so an Astryx `info` pill and Maka's `--info` are two unrelated blues that merely look alike; a dot's color does not come from the family in §8.
- **Counters:** a count is one step smaller and quieter than its label (supporting role, muted ink, `tabular-nums`) and follows its parent's active state back to full ink. Never bolder than the label it counts.
- **Scrollbars:** one app-wide recipe — a 6px pill (10px hit area, 2px transparent inset), thumb at `--border-strong`, one step darker on hover, no painted track. Surfaces may hide their own bars; none may restyle them.
- **Cards:** Astryx Card uses container radius, 12px default padding, and no resting elevation. Astryx components own their geometry.
- **Workspace:** conversation, tool activity, artifacts, browser state, and generated files stay connected to the task that produced them. Assistant messages remain quiet and avatar-free.
- **Custom companion:** a desktop pet is the sole mascot exception: user-supplied, disabled by default, decorative, pointer-transparent, hidden from assistive technology, and reduced-motion aware. It never conveys required status or speaks for the agent.

## 10. Empty & Loading States

An absence and a wait are both states of real content, and both are composed from Astryx primitives — never hand-rolled.

### Empty states: three tiers, one component

Every empty state is Astryx `EmptyState`; the tiers are parameter combinations, not new components, wrappers, or product CSS re-creating its layout. The tier count is three and not arbitrary, because the component's props offer exactly two real steps — adding a description and adding an action. That is the spec's anti-inflation lock: a fourth tier is a component-change proposal, not a casual decision.

| Tier | Use | `icon` | `description` | `actions` | `isCompact` |
|---|---|---|---|---|---|
| 1 inline | a section's local absence | no | no | no | yes |
| 2 panel | a whole list/panel/inspector is empty | yes | yes | no | no |
| 3 first-run | the page's reason to exist has not happened yet | yes | yes | exactly one | no |

- **Tier 1 carries no icon.** Both reference systems converged on this independently: a local absence must not be amplified into an event — and it is what keeps three tiers three (an icon on tier 1 leaves only a description between it and tier 2).
- **There is no tier 4.** No second button, no extra link, no help caption below the action. Anything else worth saying goes in `description`.
- **No illustrations.** The `icon` slot takes an icon glyph only — never an illustration, large graphic, or brand mark.
- **Search/filter empties always carry a clear action** (`ghost` + `sm`), on any tier. This is usability, not decoration: the user is in a state they caused themselves and must be able to exit. The canonical example is the MCP market's no-match state. Ghost/small because clearing is an exit, not the page's main action.
- **Titles are noun phrases without a period**; `description` holds the full sentence and may echo the user's query. `headingLevel` follows the document-outline ladder (§9-adjacent; ratified in the typography chapter's hierarchy), never a pinned number.
- The chat first-run hero is the sanctioned exception: a prompt-suggestion hero exceeds tier 3's single action by design and owns its layout; nothing else does.

### Loading: reserve the ready geometry

The loading state occupies the same box the ready content will occupy — loading is the same box in an unready state, not filler. The hard criterion: switching from loading to ready causes zero layout shift. This is screenshot-verifiable and reviewed as such.

Three mutually exclusive forms, chosen by structural predictability — never by expected speed:

| Form | When | Geometry |
|---|---|---|
| skeleton | structure predictable (known rows/cards) | bar heights encode type (10/12/16); row count is that surface's measured ready-state constant, never a global default — a one-row skeleton grows the page on arrival, which violates the criterion above |
| spinner | structure unpredictable (single result, unknown-size body) | three placements only: inline (metadata icon size), page-centered large, or one quiet muted line inside a card (block-level unpredictable content only — lists always take skeletons) |
| `isLoading` | busy buttons and pressable controls | the Astryx prop, always — no hand-swapped labels, icons, or disable-plus-spinner recreations |

- One region never shows a skeleton and a spinner at the same time.
- A state attribute nobody reads is worse than none — it convinces the next reader that feedback already exists. Wire state markers (`data-pending` and kin) to visible feedback or delete them.

## 11. Do's and Don'ts

### Do:

- **Do** keep task, agent state, permissions, failures, recovery, and produced work obvious.
- **Do** preserve generous reading space with compact controls and comparison-friendly density.
- **Do** extend Astryx primitives and established Maka composition slots.
- **Do** preserve keyboard focus, disabled reasons, loading and error states, and reduced-motion behavior.
- **Do** keep optional palette inventories in source while preserving documented roles and contrast.

### Don't (the forbidden list — some items are contract-tested, the rest are review-blocked):

- **Don't** write a bare `oklch()` status color at a call site, or hand-roll a status wash — consume the families (§8).
- **Don't** use `border-radius: 0` off a full-bleed row (§6).
- **Don't** put an illustration in an empty-state icon slot, add anything past tier 3's single action, or ship a state attribute with no visible feedback (§10).
- **Don't** hardcode `background: white` or any literal surface color — resolve a ladder tier (§2), or `--surface-paper` when the content's own contrast is not ours to control (foreign documents, QR codes) and inverting it would break the content rather than restyle it.
- **Don't** put more than one inverted element in a single control.
- **Don't** mix `srgb` and `oklch` derivations inside one token family (§3).
- **Don't** make light mode's "higher" darker (§2), stack two separators on one edge (§4), or invent a portal recipe (§5).
- **Don't** use generic AI gradients, glowing borders, sparkle, decorative "thinking," or default glassmorphism.
- **Don't** personify the agent through mascots, fake emotion, excessive avatars, or chat ornament; the optional user-supplied pet is the only exception.
- **Don't** turn every region into a card or every status into a colored pill.
- **Don't** introduce another accent, spacing ruler, radius tier, icon system, text axis, or parallel component path.
- **Don't** copy primitive internals, progress, versions, palette inventories, or surface inventories into this document.
