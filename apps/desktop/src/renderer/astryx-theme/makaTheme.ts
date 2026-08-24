/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Maka's Astryx theme (#1565 PR 3). An `extends` of the neutral default theme
// — issue #1565 fixes the target theme as "Astryx's default theme, light and
// dark", with no token extraction from design files — plus the one deviation
// Maka's product density genuinely requires: the type scale (see below). The
// other reason this file exists (rather than importing theme-neutral/built
// directly) is the build step: `astryx theme build` emits the theme CSS as a
// file we own, so scripts/build-astryx-theme.mjs can drop the @layer reset
// element-typography block at generation time — see styles.css for why that
// block must not ship, and that script's header for why the CLI cannot omit
// it at the source.
//
// Regenerate the maka.css / maka.js artifacts with:
//   npm run astryx:theme
import { defineTheme } from '@astryxdesign/core/theme';
import { neutralTheme, neutralIconRegistry } from '@astryxdesign/theme-neutral';

export const makaTheme = defineTheme({
  name: 'maka',
  extends: neutralTheme,
  // `extends` carries the icon registry at runtime, but the build CLI only
  // re-exports icons it can see verbatim in this file (extractIconInfo does a
  // text match on `icons: <var>` + its import) — without this line the built
  // maka.js ships no icons and every semantic icon in Astryx components
  // silently falls back.
  icons: neutralIconRegistry,
  // THE type-scale authority for the whole renderer.
  //
  // Maka is denser than Astryx's neutral default (`{base: 14, ratio: 1.2}`).
  // That density used to be expressed as `html { font-size: 13px }` in
  // maka-tokens.css, which is not a type scale at all but an implicit ×0.8125
  // multiplier on every rem in the document. Astryx's spacing and radius
  // tokens are px literals and were never affected, but its Icon size atoms
  // are rem and are documented as "the px-equivalents at a 16px root"
  // (Icon.tsx): the pin was quietly rendering the whole icon set at
  // 9.75/13/16.25/19.5 instead of 12/16/20/24. Measured in the live app, both
  // before and after. The product then had to
  // pin --font-size-base back on the Theme wrapper to undo the multiplier for
  // body copy alone, leaving every other tier shrunk. One intent, two
  // contradicting expressions, and a compensating patch between them.
  //
  // `scale` is where Astryx expects that intent (expandTypeScale rounds
  // base × ratio^n), and the four product tiers in maka-tokens.css alias its
  // output rather than holding independent values, so the ladder — and the
  // 4px-grid line heights generated alongside it — has exactly one source:
  //   step -2  --font-size-xs    11px
  //   step -1  --font-size-sm    12px  (--font-size-caption)
  //   step  0  --font-size-base  14px  (--font-size-base / --font-size-ui)
  //   step +1  --font-size-lg    16px  (--font-size-heading)
  //   step +3  --font-size-2xl   20px  (--font-size-stat)
  //
  // Why 14/1.125 rather than the 13/1.15 this file first shipped: benchmarking
  // the transcript in 2026-08 against Cursor 3.14.7, Claude Code's desktop
  // surface (the Epitaxy layer inside Claude.app) and Codex desktop
  // (openai-codex-electron), all three read from their shipped bundles rather
  // than from documentation. Treat the numbers as of that date — they put
  // every one of the three at 14px body, and their secondary text at 12–14px,
  // never as low as the 9.75px Maka had. 1.125 keeps 11 and 20 on the ladder
  // while moving
  // base to 14, and it is the ratio in Astryx's own "Dense/functional" preset
  // (`{base: 12, ratio: 1.125}`, expandTypeScale.ts). Body leading lands on
  // 20px (1.42857) — the same value Claude Code uses, and 1px TIGHTER than
  // the transcript's previous 21px, so the text gets bigger while the
  // paragraph gets marginally denser rather than looser.
  //
  // The font stacks move here for the same reason. Astryx's neutral default
  // leads with Figtree, which Maka does not bundle, so every Astryx surface
  // (Markdown prose included) declared a family that silently fell back —
  // and its stack carries no CJK face, while Maka is CJK-first. Declaring the
  // product stacks here makes --font-family-body/heading/code the only font
  // stacks in the renderer; the product's own --font-sans / --font-mono names
  // are gone, and maka-tokens.css reads these directly (#1875).
  typography: {
    scale: { base: 14, ratio: 1.125 },
    // PR-UI-ALIGN-0's "clean native" feel comes from the SYSTEM font (SF Pro
    // on macOS), not a bundled geometric face; Geist stays a late fallback.
    body: {
      family: '-apple-system',
      fallbacks:
        'BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, ' +
        '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Microsoft YaHei UI", ' +
        '"Noto Sans CJK SC", "Noto Sans SC", "WenQuanYi Micro Hei", "Source Han Sans SC", ' +
        '"Geist Variable", sans-serif',
    },
    // heading intentionally omitted — it inherits body's family/fallbacks.
    code: {
      family: 'Geist Mono Variable',
      fallbacks:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, ' +
        '"Liberation Mono", monospace',
    },
  },
  // The neutral background stack and the hairline, pointed back at the product
  // palette.
  //
  // Astryx ships these as static light-dark() pairs, which cannot follow Maka's
  // eleven switchable palettes — every one of them overrides --background and
  // none can reach an Astryx token. Left stock, Astryx surfaces would hold one
  // hardcoded neutral ramp while the product around them moved, and in dark mode
  // the two disagree outright: Astryx's surface is #262626 against the product's
  // #171719, so the nav column rendered LIGHTER than the content it navigates.
  //
  // Direction of authority is the opposite of the type scale above, and for the
  // opposite reason: Astryx's scale covers everything Maka needs from type,
  // while its neutrals are a fraction of a palette that also carries status,
  // chat, and per-theme colors. So type flows Astryx → product, neutrals flow
  // product → Astryx.
  //
  // The whole ramp moves or none of it does. Remapping only the two the shell
  // reads (surface/body) leaves card, popover, muted and the hairline on the
  // static pair, and a ramp with one half palette-driven and the other half
  // frozen does not just drift — it INVERTS: stock muted is #1b1b1b (L 0.222),
  // and once surface follows --background (L 0.18–0.24 across the dark
  // palettes) the recessive fill sits at or above the surface it is recessed
  // into. Card, Code, ChatToolCalls, Slider and TableRow are the transcript, not
  // chrome, so that inversion is visible in the main reading surface.
  //
  // The product tokens these land on are the product's own stated hierarchy:
  // --surface-canvas is the plate behind everything, --background is what cards
  // paint, --background-elevated is aliased to it on purpose (lift comes from
  // the plate and the hairline, not a darker shade). --muted is the one
  // structural upgrade over what Astryx ships: it is foreground at 5% rather
  // than an opaque literal, so it is defined RELATIVE to whatever it sits on and
  // cannot invert in any palette or mode — the failure above is unrepresentable
  // rather than merely fixed.
  tokens: {
    '--color-background-body': 'var(--surface-canvas)',
    '--color-background-surface': 'var(--background)',
    '--color-background-card': 'var(--background-elevated)',
    '--color-background-popover': 'var(--background-elevated)',
    '--color-background-muted': 'var(--muted)',
    '--color-border': 'var(--border)',
  },
  // The column edge itself. Astryx draws a divider only on
  // `AppShell variant="section"`, which is a hardcoded `variant === 'section'`
  // in AppShell.tsx and pairs the line with no wash at all. Cursor and Codex
  // both do the opposite of one-or-the-other: a 1px rule AND a wash, with the
  // wash pulled far back (measured off their windows, sidebar→content ΔL 0.025
  // and ~0.010 against Maka's 0.045). The line states the boundary; the wash
  // only says the two columns are different material. Authored here rather than
  // as a product override so the shell keeps one paint authority — this emits
  // `.astryx-app-shell-sidenav { border-inline-end }` inside the theme's own
  // @scope. It draws with --color-border, the same token Divider, Card and the
  // generated `hr` rule use, so the column edge cannot drift away from every
  // other hairline in the app; that token is remapped to the product's --border
  // just above. Keyed on the variant, not `base`: the edge belongs to the
  // elevated treatment, so a future variant change re-decides it instead of
  // inheriting a line that no longer matches the columns.
  components: {
    'app-shell-sidenav': {
      // No color ease on the column: neither half of the edge changes across the
      // collapse any more. The wash is one material in both states (the rail
      // wears --color-background-body throughout, see shell-layout.css) and the
      // hairline is transparent in both, so a background-color/border-color
      // transition here had nothing left to interpolate.
      'variant:elevated': {
        borderInlineEndWidth: '1px',
        borderInlineEndStyle: 'solid',
        borderInlineEndColor: 'var(--color-border)',
      },
    },
  },
});
