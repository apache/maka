// Maka's Astryx theme (#1565 PR 3). A pure `extends` of the neutral default
// theme — issue #1565 fixes the target theme as "Astryx's default theme,
// light and dark", with no token extraction from design files. The only
// reason this file exists (rather than importing theme-neutral/built
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
});
