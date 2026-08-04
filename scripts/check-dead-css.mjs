#!/usr/bin/env node
/**
 * check-dead-css — detect CSS classes and design tokens with zero consumers.
 *
 * Classes: parses all .css files under apps/desktop/src/renderer/styles/
 * (including the settings/ sub-directory) plus maka-tokens.css and
 * packages/ui/src/styles.css (the component-library sheet imported into the
 * product CSS) for class selectors, then searches the renderer and
 * packages/ui/src source for consumers. A consumer is an exact class-name match: `maka-shell` in source
 * does not keep `.maka-shell-rail` alive, and `maka-shell-rail` does not keep
 * `.maka-shell` alive (#1980).
 *
 * Tokens: parses the custom properties declared in maka-tokens.css and sweeps
 * every renderer stylesheet plus the source tree for var() reads. Reads
 * inside the token sheet itself only count when they can fire: a read in a
 * class rule counts when that rule's classes have consumers, and a read in
 * another token's value counts when that token is itself live (#1980).
 *
 * Known limitations:
 *   - Dynamic class names (template-string concatenation) cause false
 *     negatives (reported as dead when actually used). The script outputs
 *     a DYNAMIC_STYLE_HOOKS allowlist for known runtime-generated classes.
 *   - A token that is one rung of an ordered scale can legitimately outlive
 *     its last consumer; RESERVED_SCALE_TOKENS carries those.
 *   - This is a baseline tool: it establishes a snapshot. CI should enforce
 *     that the dead counts never INCREASE, not that they reach zero.
 *
 * Usage:
 *   node scripts/check-dead-css.mjs            # report dead classes + tokens
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
/**
 * The Astryx accent bridge in maka-tokens.css re-declares Astryx theme tokens
 * (--color-accent and friends) whose var() reads live in the library's own
 * stylesheet under node_modules, not in this repo. That stylesheet is a real
 * consumer of the token sheet, so it joins the token sweep — and only the
 * token sweep: it owns no product classes.
 */
const EXTRA_TOKEN_CONSUMER_FILES = [
  resolve(REPO_ROOT, 'node_modules', '@astryxdesign', 'core', 'dist', 'astryx.css'),
  // Astryx components read theme tokens through StyleX, so some var() reads
  // (e.g. --color-icon-accent) only exist in the compiled token map, not in
  // astryx.css.
  resolve(REPO_ROOT, 'node_modules', '@astryxdesign', 'core', 'dist', 'theme', 'tokens.stylex.js'),
];
const TOKEN_FILE = resolve(RENDERER_ROOT, 'maka-tokens.css');
/** The component-library sheet — imported into the product CSS, so its
 * classes are product classes and join the dead-class scan. Deliberately not
 * the whole of packages/ui/src: the only other stylesheets there would be
 * generated ones, which own no hand-written product classes. */
const UI_STYLE_FILE = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'styles.css');
const SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer'),
  resolve(REPO_ROOT, 'packages', 'ui', 'src'),
];
/** Stylesheets that read tokens without owning product classes. */
const TOKEN_CONSUMER_ROOTS = [RENDERER_ROOT, resolve(REPO_ROOT, 'packages', 'ui', 'src')];
/**
 * Storybook is the repo's visual loop, so a story reading a token is a real
 * consumer — stories legitimately compose their own surfaces out of the design
 * vocabulary. Deliberately not a consumer for classes: a product class that
 * only a story references is still dead product CSS.
 */
const STORY_ROOTS = [
  resolve(REPO_ROOT, 'apps', 'desktop', 'stories'),
  resolve(REPO_ROOT, 'packages', 'ui', 'stories'),
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
  // The column resize handle's hit area (Resizable/ResizeHandle themeProps).
  // shell-layout.css starts it below the chrome strip so its top 36px is not
  // swallowed by the window drag rect.
  'astryx-resize-handle',
  // AppShell's sidenav slot (AppShell.tsx themeProps); shell-layout.css clears
  // its top so the column runs under the transparent titlebar.
  'astryx-app-shell-sidenav',
  // AppShell's content column (Layout themeProps); shell-layout.css paints the
  // canvas behind the floating content plate on it.
  'astryx-layout-content',
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
  // Astryx's Item (themeProps class on every settings row). rows.css squares
  // its corners inside an open row group: Item ships a 10px radius for its
  // standalone chip use, and our hairline is a border on the Item itself, so
  // the radius bent the divider at both ends.
  'astryx-item',
  // Rendered by `useTriggerMenu` for the composer's `@` / `/` menus.
  // composer-mention.css caps its width: upstream sets a 180px floor and no
  // ceiling, and our rows carry a non-wrapping second line.
  'astryx-trigger-menu',
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
  // Markdown code-block density variants — composed at runtime via
  // `maka-markdown-code-${props.density}` in markdown-body.tsx and
  // mermaid-diagram.tsx, so the per-density names never appear as string
  // literals. Keep in sync with the density prop's values.
  'maka-markdown-code-default',
  'maka-markdown-code-compact',
]);

/**
 * Tokens kept with no current consumer because they are one rung of an ordered
 * scale. Deleting a middle rung is what invites the next bare number — the
 * point of the scale is that the gaps are named. A token that is merely
 * unused, with no series around it, does not belong here; delete it instead.
 */
const RESERVED_SCALE_TOKENS = new Set([
  // z-index scale — --z-titlebar (40) and --z-overlay (300) are live; the
  // layering only reads as a scale with the rungs between them present.
  '--z-base',
  '--z-sticky',
  '--z-panel',
  '--z-dropdown',
  '--z-tooltip',
  '--z-modal',
  // Control-height scale, 20/24/28/32/36/40 on the 4px ruler.
  '--h-control-xl',
  '--h-control-2xl',
  // Border widths 1/2/3px.
  '--border-width-accent',
  // Zero rung of the spacing ruler.
  '--space-0',
  // Easing vocabulary (see the motion governance comment in maka-tokens.css):
  // --ease-out-strong for feedback/state changes, --ease-in-out-strong for
  // on-screen movement. The movement curve lost its last consumer with the
  // dead shell recipes (#1980), but deleting the named curve is what invites
  // the next bare cubic-bezier.
  '--ease-in-out-strong',
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

export function collectClassSelectors(css) {
  const selectors = new Set();
  for (const match of stripCssComments(css).matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) {
    const cls = match[1];
    if (!cls.startsWith('-')) selectors.add(cls);
  }
  return selectors;
}

/**
 * Custom properties declared in the product token sheet. A declaration opens a
 * block or follows another one, so anchor on `{` / `;` / line start rather than
 * indentation — several tokens share a line in the compact blocks. `--x` inside
 * `var(--x)` is preceded by `(` and never matches.
 */
export function collectTokenDefinitions(css) {
  const tokens = new Set();
  for (const match of stripCssComments(css).matchAll(/(?:^|[{;])\s*(--[a-z0-9-]+)\s*:/gm)) {
    tokens.add(match[1]);
  }
  return tokens;
}

/** Custom properties read through var(). */
export function collectTokenReferences(text) {
  const refs = new Set();
  for (const match of text.matchAll(/var\(\s*(--[a-z0-9-]+)/g)) {
    refs.add(match[1]);
  }
  return refs;
}

/**
 * Whether `cls` appears in `blob` as a whole class name. `\b` alone treats a
 * hyphen as a boundary, so it would let `maka-shell-rail` keep `.maka-shell`
 * alive; class names extend across hyphens, so both ends must be checked
 * against the class-name alphabet.
 */
export function hasExactConsumer(blob, cls) {
  return new RegExp(`(?<![\\w-])${cls.replaceAll('-', '\\-')}(?![\\w-])`).test(blob);
}

/**
 * Leaf rules (`selector { declarations }`) of a stylesheet, with at-rule
 * wrappers (@media, @supports, …) flattened away. Good enough for the token
 * sheet's shapes; not a general CSS parser.
 */
export function parseLeafRules(css) {
  const rules = [];
  const walk = (text) => {
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf('{', cursor);
      if (open === -1) return;
      const selector = text.slice(cursor, open).trim();
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === '{') depth += 1;
        else if (text[close] === '}') depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);
      if (body.includes('{')) walk(body);
      else rules.push({ selector, body });
      cursor = close;
    }
  };
  walk(stripCssComments(css));
  return rules;
}

/**
 * var() reads inside the token sheet, attributed to the context that can make
 * them fire. A read in a class rule's declaration only counts when every
 * class in the rule's selector has a consumer — a rule whose classes are dead
 * never applies, so it must not keep its tokens alive. A read inside another
 * token's value is a derivation edge: it counts only once the deriving token
 * is live (resolved by `resolveLiveTokens`).
 */
export function analyzeTokenSheet(css, isClassLive) {
  const derivations = new Map();
  const liveReads = new Set();
  for (const rule of parseLeafRules(css)) {
    // A comma group applies when ANY branch matches, and a branch matches
    // only when ALL of its classes exist somewhere.
    const ruleLive = rule.selector
      .split(',')
      .some((branch) => [...collectClassSelectors(branch)].every(isClassLive));
    if (!ruleLive) continue;
    for (const declaration of rule.body.split(';')) {
      const definition = declaration.match(/^\s*(--[a-z0-9-]+)\s*:/);
      const reads = collectTokenReferences(declaration);
      if (definition) {
        const existing = derivations.get(definition[1]) ?? new Set();
        for (const read of reads) existing.add(read);
        derivations.set(definition[1], existing);
      } else {
        for (const read of reads) liveReads.add(read);
      }
    }
  }
  return { derivations, liveReads };
}

/** Close the externally-seeded live set over the sheet's derivation edges. */
export function resolveLiveTokens(externalReads, { derivations, liveReads }) {
  const live = new Set([...externalReads, ...liveReads]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [from, reads] of derivations) {
      if (!live.has(from)) continue;
      for (const read of reads) {
        if (!live.has(read)) {
          live.add(read);
          changed = true;
        }
      }
    }
  }
  return live;
}

async function main() {
  const checkMode = process.argv.includes('--check');

  // Collect all CSS class selectors. The token sheet owns product classes
  // too (shell recipes historically hid there — #1980), so it joins the scan.
  const cssFiles = await readCssFiles(STYLES_DIR);
  for (const file of [...EXTRA_STYLE_FILES, TOKEN_FILE, UI_STYLE_FILE]) {
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

  const stories = [];
  for (const root of STORY_ROOTS) {
    stories.push(...(await readSourceFiles(root)));
  }
  const storyBlob = stories.join('\n');

  // Find dead classes (zero consumers, exact class-name match)
  const isClassLive = (cls) => DYNAMIC_STYLE_HOOKS.has(cls) || hasExactConsumer(sourceBlob, cls);
  const dead = [];
  for (const cls of [...allClasses].sort()) {
    if (!isClassLive(cls)) {
      dead.push(cls);
    }
  }

  // Find dead tokens (declared in the product sheet, read by nobody).
  // A token's consumers are spread across every stylesheet, not just the ones
  // that own classes. Reads inside the token sheet itself only count when
  // they can fire (live class rule, or derivation from a live token) — a
  // token read exclusively by dead rules is dead with them (#1980).
  const tokenCss = await readFile(TOKEN_FILE, 'utf8');
  const definedTokens = collectTokenDefinitions(tokenCss);
  const referenced = new Set();
  const tokenCssFiles = [...EXTRA_STYLE_FILES, ...EXTRA_TOKEN_CONSUMER_FILES];
  for (const root of TOKEN_CONSUMER_ROOTS) {
    tokenCssFiles.push(...(await readCssFiles(root)));
  }
  for (const file of tokenCssFiles) {
    if (file === TOKEN_FILE) continue;
    for (const ref of collectTokenReferences(await readFile(file, 'utf8'))) {
      referenced.add(ref);
    }
  }
  for (const ref of collectTokenReferences(sourceBlob)) {
    referenced.add(ref);
  }
  for (const ref of collectTokenReferences(storyBlob)) {
    referenced.add(ref);
  }
  const liveTokens = resolveLiveTokens(referenced, analyzeTokenSheet(tokenCss, isClassLive));

  const deadTokens = [];
  for (const token of [...definedTokens].sort()) {
    if (RESERVED_SCALE_TOKENS.has(token)) continue;
    if (!liveTokens.has(token)) deadTokens.push(token);
  }

  if (dead.length === 0 && deadTokens.length === 0) {
    console.log('check-dead-css: no dead classes or tokens found ✓');
    process.exit(0);
  }

  if (dead.length > 0) {
    console.error(`check-dead-css: ${dead.length} potential dead class(es):`);
    for (const cls of dead) {
      console.error(`  .${cls}`);
    }
    console.error('');
    console.error('NOTE: dynamic class names (template strings) may cause false');
    console.error('positives. Review each before removing. See DYNAMIC_STYLE_HOOKS');
    console.error('in the script for known runtime-generated classes.');
  }

  if (deadTokens.length > 0) {
    console.error(`check-dead-css: ${deadTokens.length} dead token(s) in maka-tokens.css:`);
    for (const token of deadTokens) {
      console.error(`  ${token}`);
    }
    console.error('');
    console.error('NOTE: a rung of an ordered scale can outlive its last consumer —');
    console.error('add it to RESERVED_SCALE_TOKENS with the series it belongs to.');
    console.error('An unused token with no series around it should be deleted.');
  }

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

    const maxDeadTokenCount = Number(baseline?.maxDeadTokenCount ?? 0);
    if (!Number.isFinite(maxDeadTokenCount) || maxDeadTokenCount < 0) {
      console.error(
        `check-dead-css: baseline ${BASELINE_PATH} must define a non-negative numeric maxDeadTokenCount.`,
      );
      process.exit(1);
    }

    if (dead.length > maxDeadClassCount) {
      console.error(
        `check-dead-css: dead class count ${dead.length} exceeds baseline ${maxDeadClassCount}.`,
      );
      process.exit(1);
    }

    if (deadTokens.length > maxDeadTokenCount) {
      console.error(
        `check-dead-css: dead token count ${deadTokens.length} exceeds baseline ${maxDeadTokenCount}.`,
      );
      process.exit(1);
    }

    console.log(
      `check-dead-css: within baseline (classes ${dead.length}/${maxDeadClassCount}, tokens ${deadTokens.length}/${maxDeadTokenCount}) ✓`,
    );
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error('check-dead-css: ERROR', err.message);
    process.exit(1);
  });
}
