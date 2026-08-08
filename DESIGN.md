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
  inner: "4px"
  control: "6px"
  card: "10px"
  container: "12px"
  page: "16px"
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

# Design System: Maka

## 1. Overview

**Creative North Star: "The Companion Command Center"**

Maka is a desktop workspace for directing, supervising, and completing real work with agents. The task stays central; activity, permissions, failures, recovery, and generated work remain inspectable without turning the window into a monitoring dashboard.

The system is calm, native, and compact: spacious around reading and decisions, dense where comparison matters. Humanity comes from useful language and continuity, not simulated personality.

This document governs the default light and dark themes. Optional palettes may change canvas, ink, accent, and semantic colors, but must preserve their roles, contrast, and hierarchy.

**Authority:** `apps/desktop/src/renderer/astryx-theme/makaTheme.ts` owns type, neutral remaps, and theme-level component overrides; `apps/desktop/src/renderer/maka-tokens.css` owns product palettes, spacing, radii, product motion, and the Astryx bridge; Astryx owns primitive geometry, states, and internal motion; product source owns Maka-specific compositions. Generated `apps/desktop/src/renderer/astryx-theme/maka.css` is not an editing authority.

Frontmatter is a snapshot of the current default theme. When it diverges from source or contract tests, source and tests win and this document must be refreshed.

## 2. Surfaces

Depth is a ladder, not a decoration. Every background in the app resolves to one of four semantic tiers, each derived from `--background` with cumulative offsets (palettes override only `--background`; the ladder follows).

| Tier | Token | Role | Light | Dark |
|---|---|---|---|---|
| sunken | `--surface-sunken` | sidebar rail, recessed chrome | 237 | 9 |
| base | `--surface-base` | shell canvas behind plates | 247 | 17 |
| raised | `--surface-raised` | cards, content plates, reading surfaces | 255 | 23 |
| overlay | `--surface-overlay` | menus, popovers, dialogs, toasts | 255 | 27 |

(Values are measured rendered pixels, not aspirations; the ink/surface contract tests hold them.)

**The Height Rule.** Height maps monotonically to lightness in both modes, and reading surfaces always occupy the brightest tier of their mode. In light mode the ladder tops out at pure white, so `raised` and `overlay` share the fill and overlay separation hands off to the floating recipe (§5). Light mode "higher = darker" is permanently forbidden — it makes elevation shadows contradict the fill.

**The Canvas Recedes Rule** (owner decision 2026-06-20). The canvas is gray; content surfaces are white. The sidebar sits on `sunken`, the shell on `base`, and content plates on `raised`. Contrast between canvas and plate — not hairlines — is the primary separator of the shell.

**Legacy names.** The semantic tiers are canonical. Old names are aliases and their resolved values never change out from under consumers: `--surface-canvas` → base, `--background` → raised (it is the card fill, not the page color), `--background-elevated`, `--color-background-card`, `--color-background-popover` → overlay, `--card-bg`, `--color-background-surface` → raised.

## 3. Ink

Prose uses exactly three tiers, spaced at an even ~2× contrast rhythm, all above WCAG AA. Measured against `--surface-raised`:

| Tier | Token | Light | Dark |
|---|---|---|---|
| primary | `--foreground` | 19.1:1 | 15.5:1 |
| secondary | `--foreground-secondary` | 9.8:1 | 9.2:1 |
| muted | `--muted-foreground` | 4.8:1 | 4.7:1 |

- **The Three-Tier Reading Rule.** Prose uses primary, secondary, or muted. Neutral washes are surfaces, not extra text tiers. `--foreground-dimmed` is an alias of secondary and must never regain its own definition (contract-tested).
- **The One Colorspace Rule.** Every derivation inside a token family uses one colorspace (`oklch` for ink, contract-tested). Mixing `srgb` and `oklch` derivations produces "same literal, different value" drift. Known exception: dark `--surface-overlay` still derives via an srgb mix — a scheduled unification in T2–T4, not a precedent.
- **Links use the solid accent tier** (`--accent-solid`), never raw `--accent` — the accent identifies interaction; the solid tier is the only accent variant that clears text contrast on every palette.

## 4. Borders

Three strengths, each a job, spaced at ~1.6× like the ink ladder:

- `--border-soft` (6% ink): quiet separation inside a plate — rails, row dividers that fills can't carry.
- `--border` (10% ink): structural boundaries between regions.
- `--border-strong` (16% ink): emphasis chrome only. Its legitimate jobs, from the live inventory: selected/active outlines and emphasized boundaries (onboarding, plan-mode, chat turn/quote chrome, the Astryx `--color-border-emphasized` mapping). Two call sites borrow it as a strong neutral *tint* rather than a border — a scrollbar thumb color and a separator glyph color — and are queued to migrate onto ink-derived tokens in T2–T4. It is not "the border for when you're unsure."
- `--shadow-minimal-flat` is historically a 1px ring wearing box-shadow clothing (`0 0 0 1px`), not an elevation step; it belongs to this chapter in spirit and migrates to a ring-named border token in T2–T4 (cross-package consumers exist in `packages/ui`).

**The One Means Rule.** Each boundary picks one separator: a fill step, a line, or a shadow — never stacked on the same edge.

## 5. Elevation

Default surfaces are flat. Depth comes first from the surface ladder, then a line, then shadow only when an element genuinely floats above the plane.

- Product elevation names alias the theme scale: `--elevation-raised` (low), `--elevation-overlay` (med), `--elevation-drag` (high). A scale only gets used when product code can name it — the theme shipped three shadows for months and product CSS consumed one, because the names meant nothing at a call site.
- **The Floating Recipe.** Every portal surface (menu, popover, dialog, toast) is: `--surface-overlay` fill + `--border-soft` ring + `--elevation-overlay` + `overflow: hidden` + container radius. No portal invents its own mix.
- Dark mode relies on tone and rings before shadow. Neon edges and lifted-everything styling are forbidden.
- Native shell vibrancy is allowed only in designated material; generic glassmorphism is not.

**The One Working Plane Rule.** Dividers separate responsibilities; cards and shadows do not fragment the workspace into a dashboard grid.

## 6. Radius

Nothing interactive is square. One ladder, assigned monotonically by box height:

| Radius | Tier | Assign to |
|---|---|---|
| 4px | inner | chips, keycaps, nested inlays inside a control |
| 6px | control | buttons, inputs, segmented items (≤ 36px tall) |
| 10px | card | cards, rows-as-cards, list containers (the single card value — 8/10/12 coexistence is over) |
| 12px | container | modals, panels, portal surfaces |
| 16px | page | page-level plates and hero surfaces |
| full | pill | badges, pills, circular controls |

- **The Full-Bleed Rule.** `border-radius: 0` is legal only on true full-bleed rows — an element flush with its container on both sides. Radius and gap move together: if it has breathing room, it has corners.
- **Proportional marks.** Product-drawn icon plates use ratio-owned radius (~25–27% of the box edge), recorded in prose because Stitch accepts only absolute units.

## 7. Typography

Use the system UI stack with explicit platform CJK fallbacks; Geist Variable is a late fallback. Code uses Geist Mono Variable, JetBrains Mono, then platform monospace. Chinese and Latin must read as one interface.

- **Display 1–3:** rare large statements and empty-state anchors.
- **Heading 1–5:** page, panel, section, and compact-title hierarchy.
- **Body:** conversation and normal reading.
- **Label:** controls and interactive labels.
- **Supporting:** metadata and compact secondary copy.
- **Code:** code, paths, commands, identifiers, and machine evidence.

**The Role, Not Axes Rule.** Choose an Astryx text role or a Maka role composed from it. Never assemble literal family, size, weight, or line height at a product call site.

**The Four-Pixel Line Rule.** Text line boxes land on the 4px grid. Mono is technical, never decorative.

## 8. Color Specification

The palette is cool-neutral and quiet; color is generated to spec, not picked by eye.

- **Brand mark** is fixed `#71a8fd`; it identifies Maka and is never the general CTA color.
- **Interaction accent** follows the active palette for focus, selection, and live state; **links and accent-colored text use the solid tier** (§3).
- **Status families** (success / active / attention / error / neutral — there is no "info" status semantic) are generated, not picked: one lightness per mode with each hue keeping its own chroma. Light mode is generated at L=0.50 (contrast vs white spans 5.5–6.3:1; the residual spread is hue physics — at equal L, yellow carries more luminance than blue — and flattening it would abandon the shared-L premise that makes them a family). This regeneration fixed two AA failures the old hand-picked values shipped (info 2.82:1, warning 3.29:1). Dark mode keeps its pre-2.0 values (all ≥4.5:1); regenerating dark at its own single L is a scheduled separate round. A louder band at ~90% gamut chroma exists only for 8px status dots — dots must read at a glance; washes must not shout.
- **Tinted surfaces** (status washes behind rows and banners) derive from the same status hues; hand-rolled `oklch()` status washes at call sites are forbidden — consume the family.
- **Identity colors** (avatars, channel marks) live in one 4.2–4.8:1 contrast band; desaturation for muted states happens at constant OKLab lightness.

**The Signal, Not Texture Rule.** Accent communicates action or state. Never use it as a background flood, gradient, glow, or substitute for hierarchy.

## 9. Components

Use Astryx primitives as the default seam. New work composes product meaning through published props, tokens, and stable `themeProps` extension points; internal-DOM overrides are acknowledged transitional states, not precedent.

- **Controls:** Maka uses a 20/24/28/32/36/40px height ruler with 32px as the default; Astryx owns the 28/32/36px variants. Hover is restrained; press may use `scale(0.98)`; keyboard focus is always visible. At most one inverted (filled) element per control.
- **Fields:** labels, descriptions, and validation belong to the field primitive; input focus belongs to its control. Keep disabled reasons discoverable through the owning control's tooltip; do not rebuild field chrome around a bare input.
- **Badges and status:** Badge is 20px high and pill-shaped. Choose semantic variants by meaning, not hue; use status dots for success, active, attention, error, or neutral.
- **Cards:** Astryx Card uses container radius, 12px default padding, and no resting elevation. Astryx components own their geometry.
- **Workspace:** conversation, tool activity, artifacts, browser state, and generated files stay connected to the task that produced them. Assistant messages remain quiet and avatar-free.
- **Custom companion:** a desktop pet is the sole mascot exception: user-supplied, disabled by default, decorative, pointer-transparent, hidden from assistive technology, and reduced-motion aware. It never conveys required status or speaks for the agent.

## 10. Do's and Don'ts

### Do:

- **Do** keep task, agent state, permissions, failures, recovery, and produced work obvious.
- **Do** preserve generous reading space with compact controls and comparison-friendly density.
- **Do** extend Astryx primitives and established Maka composition slots.
- **Do** preserve keyboard focus, disabled reasons, loading and error states, and reduced-motion behavior.
- **Do** keep optional palette inventories in source while preserving documented roles and contrast.

### Don't (the forbidden list — each item is contract-tested or review-blocked):

- **Don't** write a bare `oklch()` status color or wash at a call site — consume the generated families (§8).
- **Don't** use `border-radius: 0` off a full-bleed row (§6).
- **Don't** hardcode `background: white` or any literal surface color — resolve a ladder tier (§2).
- **Don't** put more than one inverted element in a single control.
- **Don't** mix `srgb` and `oklch` derivations inside one token family (§3).
- **Don't** make light mode's "higher" darker (§2), stack two separators on one edge (§4), or invent a portal recipe (§5).
- **Don't** use generic AI gradients, glowing borders, sparkle, decorative "thinking," or default glassmorphism.
- **Don't** personify the agent through mascots, fake emotion, excessive avatars, or chat ornament; the optional user-supplied pet is the only exception.
- **Don't** turn every region into a card or every status into a colored pill.
- **Don't** introduce another accent, spacing ruler, radius tier, icon system, text axis, or parallel component path.
- **Don't** copy primitive internals, progress, versions, palette inventories, or surface inventories into this document.
