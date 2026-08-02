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
  // product stacks here makes --font-family-body/heading/code identical to
  // what the product already uses; maka-tokens.css now aliases --font-sans /
  // --font-mono to these instead of holding a second copy.
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
});
