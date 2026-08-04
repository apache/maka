---
name: Maka
description: A companion command center for completing real work with agents.
sourceOfTruth: apps/desktop/src/renderer/astryx-theme/makaTheme.ts
colors:
  maka-blue: "oklch(0.70 0.135 250)"
  surface-light: "oklch(1.000 0 0)"
  ink-light: "oklch(0.17 0.005 286)"
  surface-dark: "oklch(0.205 0.004 286)"
  ink-dark: "oklch(0.92 0.004 286)"
  info: "oklch(0.75 0.16 70)"
  success: "oklch(0.55 0.17 145)"
  warning: "oklch(0.66 0.18 55)"
  destructive: "oklch(0.58 0.24 28)"
typography:
  scale: { base: 14, ratio: 1.125 }
  stat: { fontSize: "20px", fontWeight: 600, lineHeight: 1.25 }
  heading: { fontSize: "16px", fontWeight: 600, lineHeight: 1.25 }
  body: { fontSize: "14px", fontWeight: 400, lineHeight: 1.5 }
  caption: { fontSize: "12px", fontWeight: 400, lineHeight: 1.375 }
rounded: { control: "6px", surface: "8px", modal: "12px", pill: "999px" }
spacing: { base: "4px", sm: "8px", md: "12px", lg: "16px", xl: "24px", "2xl": "32px" }
---

# Design System: Maka

This is a small snapshot of the default theme. Type is owned by `astryx-theme/makaTheme.ts`, whose `typography.scale` generates the whole size ladder; `maka-tokens.css` owns the remaining runtime tokens and aliases the ladder for product use. Component source owns exact component values. Refresh this file from source when they diverge. The renderer and `@maka/ui` stylesheets compose those tokens into product-owned semantic classes; they are not a second token authority.

## 1. Overview

**Creative North Star: "The Companion Command Center"**

Maka is a focused desktop workspace for directing, supervising, and completing real work with agents. The task stays central, agent activity remains inspectable, and generated work appears beside the conversation when it needs review.

Maka adds humanity to the clarity of a command center through Chinese-first copy, timely feedback, visible continuity, and calm collaboration—not mascots, fake emotion, or decorative chat chrome. It is spacious without becoming sparse and dense where work requires comparison.

## 2. Colors

The palette is cool-neutral and quiet. Maka blue is the single product accent; provider logos retain their colors and semantic colors retain their meanings.

### Primary

- **Maka Blue:** action, focus, selection, live state, links, and small branded moments.

### Neutral

- **Clear Surface / Night Surface:** the primary working plane in light and dark.
- **Cool Glass Canvas:** shell separation through tonal lightness, not decorative transparency.
- **Zinc Ink:** text and the source for neutral borders, washes, and hierarchy.

### Named Rules

**The Signal, Not Texture Rule.** Blue communicates action or state. It never becomes a background flood, decorative gradient, or ambient glow.

**The Honest Glass Rule.** Use tonal layering and subtle rings. Blur and transparency never substitute for hierarchy.

## 3. Typography

**Display/Body Font:** system-first sans with platform-native CJK fallbacks

**Label/Mono Font:** Geist Mono Variable with platform monospace fallbacks

The type system is native, compact, and legible. Chinese and Latin content read as one interface. Hierarchy comes from the four frontmatter tiers, weight, spacing, and color—not expressive font mixing.

### Named Rules

**The Native Voice Rule.** Mono is reserved for code, paths, commands, identifiers, and numeric evidence.

**The Three-Tier Reading Rule.** Text uses primary, secondary, or muted foreground. Neutral wash values are surfaces, not prose colors.

## 4. Elevation

Maka uses structural layering: light mode combines near-white tonal steps, hairline rings, and very soft shadows; dark mode relies primarily on tonal separation and rings.

### Named Rules

**The One Working Plane Rule.** Conversation and adjacent work context form one workspace. Dividers separate responsibilities; card shadows do not fragment the window into a dashboard grid.

**The Dark Restraint Rule.** Dark mode uses tonal surfaces and rings before shadow. Neon edges and lifted-everything styling are forbidden.

## 5. Components

Components are compact, predictable, and quietly tactile. Exact geometry and behavior belong to component source.

### Controls

Buttons, fields, chips, and navigation share one interaction language: clear focus, neutral structural states, restrained Maka-blue emphasis, and tokenized press or hover feedback without bounce, overshoot, or decorative choreography.

### Containers

A container earns its border, fill, or shadow from a real ownership boundary. Prefer rows and separators over cards inside cards.

### Conversation and Agent Activity

Conversation is primary, but Maka is not merely a chat app. Tool activity, permissions, artifacts, browser state, and generated files remain inspectable and connected to the turn that produced them. The agent feels present through progress, explanation, and continuity—not an avatar performing emotion.

## 6. Do's and Don'ts

### Do:

- **Do** keep the current task, agent state, permissions, failures, and recovery obvious.
- **Do** preserve generous working space with compact controls and readable density.
- **Do** extend existing primitives and stable slots before adding recipes.

### Don't:

- **Don't** imitate generic AI products with purple-blue gradients, glowing borders, glassmorphism, sparkle, or decorative “thinking.”
- **Don't** make Maka human through mascots, fake emotion, excessive avatars, or chat-bubble ornament.
- **Don't** turn every region into a card or every status into a colored pill.
- **Don't** introduce another accent, spacing ruler, radius tier, icon system, or parallel component path.
- **Don't** copy progress, PR numbers, line numbers, versions, or surface inventories here.
