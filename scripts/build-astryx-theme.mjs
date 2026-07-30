// Build the Maka Astryx theme and strip its element-typography block (#1565 PR 3).
//
// `astryx theme build` compiles apps/desktop/src/renderer/astryx-theme/makaTheme.ts
// to maka.css + maka.js. The CSS always leads with an `@layer reset` block of
// @scope'd bare-element typography (:where(h1..h6, p, small, code, hr)) — the CLI
// deliberately removed its `--no-prose` flag to keep build output identical to the
// <Theme> runtime injector. styles.css explains why that block must not ship in
// Maka: bare-element rules win wherever no product rule competes, and no layer
// order can bury them.
//
// Stripping it here is NOT a build⇄runtime divergence for us: built themes
// (`__built: true`) skip runtime injection entirely (see @astryxdesign/core
// dist/theme/Theme.js useThemeStyleInjection), so the imported file is the only
// CSS source and what we strip stays stripped.
//
// Usage: npm run astryx:theme
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(repoRoot, 'apps', 'desktop');
const themeSource = path.join('src', 'renderer', 'astryx-theme', 'makaTheme.ts');
const cssOut = path.join('src', 'renderer', 'astryx-theme', 'maka.css');
const cssOutAbs = path.join(desktopDir, cssOut);

execFileSync('npx', ['astryx', 'theme', 'build', themeSource, '-o', cssOut], {
  cwd: desktopDir,
  stdio: 'inherit',
});

const css = readFileSync(cssOutAbs, 'utf8');

const marker = '@layer reset {';
const start = css.indexOf(marker);
if (start === -1) {
  throw new Error(
    `${cssOut}: expected a leading "@layer reset {" prose block; ` +
      'the astryx CLI output shape changed — re-verify the strip logic.',
  );
}
// Walk braces from the block opener to its matching close.
let depth = 0;
let end = -1;
for (let i = css.indexOf('{', start); i < css.length; i += 1) {
  const ch = css[i];
  if (ch === '{') depth += 1;
  else if (ch === '}') {
    depth -= 1;
    if (depth === 0) {
      end = i + 1;
      break;
    }
  }
}
if (end === -1) throw new Error(`${cssOut}: unbalanced braces in the @layer reset block.`);
if (css.indexOf(marker, end) !== -1) {
  throw new Error(`${cssOut}: multiple @layer reset blocks; expected exactly one.`);
}

const stripped = css.slice(0, start).replace(/\s+$/, '\n\n') + css.slice(end).replace(/^\s+/, '');
const note =
  '/* Post-processed by scripts/build-astryx-theme.mjs: the @layer reset\n' +
  ' * element-typography block is stripped — see that script for why. */\n\n';
writeFileSync(cssOutAbs, stripped.replace('*/\n', '*/\n\n' + note));
console.log(`Stripped the @layer reset prose block from ${cssOut}.`);
