---
name: Maka
description: A companion command center for completing real work with agents.
colors:
  brand-mark: "#71a8fd"
  accent-light: "oklch(0.70 0.135 250)"
  accent-dark: "oklch(0.74 0.15 250)"
  accent-solid-light: "oklch(0.52 0.135 250)"
  accent-solid-dark: "oklch(0.76 0.15 250)"
  on-accent-light: "#ffffff"
  on-accent-dark: "#171717"
  surface-light: "oklch(1 0 0)"
  canvas-light: "oklch(0.975 0 0)"
  ink-light: "oklch(0.17 0.005 286)"
  surface-dark: "oklch(0.205 0.004 286)"
  canvas-dark: "oklch(0.18 0.004 286)"
  ink-dark: "oklch(0.92 0.004 286)"
  info-light: "oklch(0.68 0.13 240)"
  info-dark: "oklch(0.74 0.13 240)"
  success-light: "oklch(0.55 0.17 145)"
  success-dark: "oklch(0.60 0.17 145)"
  warning: "oklch(0.66 0.18 55)"
  destructive-light: "oklch(0.58 0.24 28)"
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
rounded:
  control: "6px"
  surface: "8px"
  modal: "12px"
  pill: "999px"
  plate: "27%"
  astryx-element: "0.625rem"
  astryx-container: "0.75rem"
  astryx-page: "1.75rem"
  astryx-full: "9999px"
spacing: { base: "4px", xs: "2px", sm: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "32px", "3xl": "48px", "4xl": "64px" }
components:
  button-default: { typography: "{typography.label}", rounded: "{rounded.astryx-element}", padding: "8px 12px", height: "32px" }
  button-primary-light: { backgroundColor: "{colors.accent-solid-light}", textColor: "{colors.on-accent-light}", typography: "{typography.label}", rounded: "{rounded.astryx-element}", height: "32px" }
  button-primary-dark: { backgroundColor: "{colors.accent-solid-dark}", textColor: "{colors.on-accent-dark}", typography: "{typography.label}", rounded: "{rounded.astryx-element}", height: "32px" }
  input-default: { typography: "{typography.body}", rounded: "{rounded.astryx-element}", height: "32px" }
  badge: { typography: "{typography.supporting}", rounded: "{rounded.astryx-full}", padding: "0 8px", height: "20px" }
  card-default: { rounded: "{rounded.astryx-container}", padding: "16px" }
---

# Design System: Maka

## 1. Overview

**Creative North Star: "The Companion Command Center"**

Maka is a desktop workspace for directing, supervising, and completing real work with agents. The task stays central; activity, permissions, failures, recovery, and generated work remain inspectable without turning the window into a monitoring dashboard.

The system is calm, native, and compact: spacious around reading and decisions, dense where comparison matters. Humanity comes from useful language and continuity, not simulated personality.

This document governs the default light and dark themes. Optional palettes may change canvas, ink, accent, and semantic colors, but must preserve their roles, contrast, and hierarchy.

**Authority:** `astryx-theme/makaTheme.ts` owns type, neutral remaps, and theme-level component overrides; `maka-tokens.css` owns product palettes, spacing, radii, motion, and the Astryx bridge; Astryx owns primitive geometry and states; product source owns Maka-specific compositions. Generated `maka.css` is not an editing authority.

## 2. Colors

The palette is cool-neutral and quiet. Light mode places white work surfaces on a near-white canvas; dark mode uses close zinc tones separated by hairlines.

- **Brand mark** is fixed `#71a8fd`; it identifies Maka and is never the general CTA color.
- **Interaction accent** follows the active palette for focus, links, selection, and live state.
- **Solid accent** is the contrast-safe variant for filled controls and accent-colored text or icons.
- **Surface, canvas, and ink** create hierarchy through tone; derive secondary text, borders, and washes from ink.
- **Info, success, warning, and destructive** are meanings, not decoration. Enabled is not automatically success.

**The Signal, Not Texture Rule.** Accent communicates action or state. Never use it as a background flood, gradient, glow, or substitute for hierarchy.

**The Three-Tier Reading Rule.** Prose uses primary, secondary, or muted foreground. Neutral washes are surfaces, not extra text tiers.

## 3. Typography

Use the system UI stack with explicit platform CJK fallbacks; Geist Variable is a late fallback. Code uses Geist Mono Variable, JetBrains Mono, then platform monospace. Chinese and Latin must read as one interface.

- **Display 1–3:** rare large statements and empty-state anchors.
- **Heading 1–5:** page, panel, section, and compact-title hierarchy.
- **Body:** conversation and normal reading.
- **Label:** controls and interactive labels.
- **Supporting:** metadata and compact secondary copy.
- **Code:** code, paths, commands, identifiers, and machine evidence.

**The Role, Not Axes Rule.** Choose an Astryx text role or a Maka role composed from it. Never assemble literal family, size, weight, or line height at a product call site.

**The Four-Pixel Line Rule.** Text line boxes land on the 4px grid. Mono is technical, never decorative.

## 4. Elevation

Default surfaces are flat. Depth comes first from canvas-to-surface tone, then a hairline, then shadow only when an element genuinely floats.

- Use `--shadow-minimal-flat` for compact previews and menus that need an edge without visible lift.
- Use Astryx low, medium, or high elevation through component APIs for floating controls, popovers, dialogs, and overlays.
- Dark mode relies on tone and rings before shadow. Neon edges and lifted-everything styling are forbidden.
- Native shell vibrancy is allowed only in designated material; generic glassmorphism is not.

**The One Working Plane Rule.** Dividers separate responsibilities; cards and shadows do not fragment the workspace into a dashboard grid.

## 5. Components

Use Astryx primitives as the default seam. Maka CSS composes product meaning around them and does not restyle their internals.

- **Controls:** default height is 32px, with 28px and 36px variants. Hover is restrained; press may use `scale(0.98)`; keyboard focus is always visible.
- **Fields:** labels, descriptions, validation, disabled reason, and focus belong to the field primitive. Do not rebuild field chrome around a bare input.
- **Badges and status:** Badge is 20px high and pill-shaped. Choose semantic variants by meaning, not hue; use status dots for success, active, attention, error, or neutral.
- **Cards:** Astryx Card uses 12px radius, 16px default padding, and no resting elevation. A container earns chrome only from a real ownership boundary.
- **Workspace:** conversation, tool activity, artifacts, browser state, and generated files stay connected to the task that produced them. Assistant messages remain quiet and avatar-free.
- **Custom companion:** a desktop pet is the sole mascot exception: user-supplied, disabled by default, decorative, pointer-transparent, hidden from assistive technology, and reduced-motion aware. It never conveys required status or speaks for the agent.

## 6. Do's and Don'ts

### Do:

- **Do** keep task, agent state, permissions, failures, recovery, and produced work obvious.
- **Do** preserve generous reading space with compact controls and comparison-friendly density.
- **Do** extend Astryx primitives and established Maka composition slots.
- **Do** preserve keyboard focus, disabled reasons, loading and error states, and reduced-motion behavior.
- **Do** keep optional palette inventories in source while preserving documented roles and contrast.

### Don't:

- **Don't** use generic AI gradients, glowing borders, sparkle, decorative “thinking,” or default glassmorphism.
- **Don't** personify the agent through mascots, fake emotion, excessive avatars, or chat ornament; the optional user-supplied pet is the only exception.
- **Don't** turn every region into a card or every status into a colored pill.
- **Don't** introduce another accent, spacing ruler, radius tier, icon system, text axis, or parallel component path.
- **Don't** copy primitive internals, progress, versions, palette inventories, or surface inventories into this document.
