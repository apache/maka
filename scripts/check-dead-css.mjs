#!/usr/bin/env node
/**
 * check-dead-css — detect CSS classes with zero JSX consumers.
 *
 * Parses all .css files under apps/desktop/src/renderer/styles/ (including
 * the settings/ sub-directory) for class selectors, then greps the renderer
 * and packages/ui/src source for consumers. Classes with zero consumers are
 * reported as potential dead CSS.
 *
 * Known limitations:
 *   - Dynamic class names (template-string concatenation) cause false
 *     negatives (reported as dead when actually used). The script outputs
 *     a DYNAMIC_STYLE_HOOKS allowlist for known runtime-generated classes.
 *   - This is a baseline tool: it establishes a snapshot. CI should enforce
 *     that the dead-class count never INCREASES, not that it reaches zero.
 *
 * Usage:
 *   node scripts/check-dead-css.mjs            # report dead classes
 *   node scripts/check-dead-css.mjs --check    # exit 1 if count > baseline
 *
 * Part of issue #253 Round G.
 */
import { readdir, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const BASELINE_PATH = resolve(REPO_ROOT, 'scripts', 'check-dead-css-baseline.json');

const RENDERER_ROOT = resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer');
const STYLES_DIR = resolve(RENDERER_ROOT, 'styles');
const EXTRA_STYLE_FILES = [resolve(RENDERER_ROOT, 'reference-shell.css')];
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer'),
  resolve(REPO_ROOT, 'packages', 'ui', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.html', '.js', '.jsx', '.ts', '.tsx']);

// Classes generated at runtime that won't appear in source grep.
const DYNAMIC_STYLE_HOOKS = new Set([
  'os-scrollbar-horizontal',
  'os-scrollbar-vertical',
  'is-err',
  'is-error',
  'is-idle',
  'is-needs_reauth',
  'is-ok',
  'is-untested',
  'is-verified',
  'is-warn',
  // Astryx renders these stable component classes through themeProps at
  // runtime. Responsive page CSS targets them for layout overrides, but they
  // do not appear as className literals in Maka source.
  'astryx-button',
  'astryx-badge',
  'astryx-resize-handle-pill',
  // SideNav shell + items + section titles (sidebar.css product overrides).
  'astryx-side-nav',
  'astryx-side-nav-item',
  'astryx-side-nav-section',
  // Selector / MultiSelector trigger shell (themeProps class on the outer
  // field). native-cursor.css and model-switcher.css target these so the
  // multi-node hit target (label button + sibling chevron) stays one cursor.
  'astryx-selector',
  'astryx-multi-selector',
  // Rendered by Astryx's own Collapsible; chat-message.css targets it to give
  // reasoning/tool disclosures one trigger dialect inside the turn body (#1768).
  'astryx-collapsible-trigger',
  // Appearance palette swatches — composed at runtime via
  // `settingsPaletteSwatch-${palette}` in settings/appearance-settings-page.tsx
  // (#308), so the per-palette variants never appear as string literals in
  // source. Keep in sync with PALETTE_GROUPS in that file.
  'settingsPaletteSwatch-default',
  'settingsPaletteSwatch-onedark',
  'settingsPaletteSwatch-catppuccin-mocha',
  'settingsPaletteSwatch-tokyo-night',
  'settingsPaletteSwatch-nord',
  'settingsPaletteSwatch-coral',
  'settingsPaletteSwatch-azure',
  'settingsPaletteSwatch-forest',
  'settingsPaletteSwatch-dusk',
  'settingsPaletteSwatch-sand',
  'settingsPaletteSwatch-mono',
]);

async function readCssFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return readCssFiles(path);
      if (!entry.name.endsWith('.css')) return [];
      return [path];
    }),
  );
  return files.flat();
}

async function readSourceFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return readSourceFiles(path);
      if (!SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) return [];
      return [await readFile(path, 'utf8')];
    }),
  );
  return files.flat();
}

function stripCssComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectClassSelectors(css) {
  const selectors = new Set();
  for (const match of stripCssComments(css).matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) {
    const cls = match[1];
    if (!cls.startsWith('-')) selectors.add(cls);
  }
  return selectors;
}

async function main() {
  const checkMode = process.argv.includes('--check');

  // Collect all CSS class selectors
  const cssFiles = await readCssFiles(STYLES_DIR);
  for (const file of EXTRA_STYLE_FILES) {
    cssFiles.push(file);
  }
  const allClasses = new Set();
  for (const file of cssFiles) {
    const css = await readFile(file, 'utf8');
    for (const cls of collectClassSelectors(css)) {
      allClasses.add(cls);
    }
  }

  // Collect all source text
  const sources = [];
  for (const root of SOURCE_ROOTS) {
    sources.push(...(await readSourceFiles(root)));
  }
  const sourceBlob = sources.join('\n');

  // Find dead classes (zero consumers)
  const dead = [];
  for (const cls of [...allClasses].sort()) {
    if (DYNAMIC_STYLE_HOOKS.has(cls)) continue;
    // Search for the class name as a string literal in source
    if (!sourceBlob.includes(cls)) {
      dead.push(cls);
    }
  }

  if (dead.length === 0) {
    console.log('check-dead-css: no dead classes found ✓');
    process.exit(0);
  }

  console.error(`check-dead-css: ${dead.length} potential dead class(es):`);
  for (const cls of dead) {
    console.error(`  .${cls}`);
  }
  console.error('');
  console.error('NOTE: dynamic class names (template strings) may cause false');
  console.error('positives. Review each before removing. See DYNAMIC_STYLE_HOOKS');
  console.error('in the script for known runtime-generated classes.');

  if (checkMode) {
    let baseline;
    try {
      baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
    } catch (err) {
      console.error(`check-dead-css: failed to read baseline at ${BASELINE_PATH}: ${err.message}`);
      process.exit(1);
    }

    const maxDeadClassCount = Number(baseline?.maxDeadClassCount);
    if (!Number.isFinite(maxDeadClassCount) || maxDeadClassCount < 0) {
      console.error(
        `check-dead-css: baseline ${BASELINE_PATH} must define a non-negative numeric maxDeadClassCount.`,
      );
      process.exit(1);
    }

    if (dead.length > maxDeadClassCount) {
      console.error(
        `check-dead-css: dead class count ${dead.length} exceeds baseline ${maxDeadClassCount}.`,
      );
      process.exit(1);
    }

    console.log(`check-dead-css: within baseline (${dead.length}/${maxDeadClassCount}) ✓`);
  }
}

main().catch((err) => {
  console.error('check-dead-css: ERROR', err.message);
  process.exit(1);
});
