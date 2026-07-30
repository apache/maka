import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { readAllRendererCss, readCssTree, RENDERER_STYLES_DIR, stripCssComments, STYLES_FILE } from './css-test-helpers.js';

/**
 * Returns the number of `@layer` blocks enclosing the first occurrence of
 * `selectorLine` in `styles`. 0 means the rule carries no file-local layer
 * nesting — its effective layer is whatever the import site assigns
 * (`layer(maka.legacy)` / `layer(components)` in styles.css).
 *
 * Author rules placed inside a file-local `@layer base`/`@layer components`
 * block sit BELOW Tailwind v4's `utilities` layer in the cascade, so they
 * lose to any utility class on the same element regardless of specificity.
 */
function enclosingLayerCount(styles: string, selectorLine: string): number {
  const lines = styles.split('\n');
  let depth = 0;
  const layerOpenDepths: number[] = [];
  for (const line of lines) {
    if (line.trim() === selectorLine) return layerOpenDepths.length;
    if (/^\s*@layer\s+[\w, ]+\{/.test(line)) {
      layerOpenDepths.push(depth);
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      continue;
    }
    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (layerOpenDepths.length > 0 && depth === layerOpenDepths[layerOpenDepths.length - 1]) {
          layerOpenDepths.pop();
        }
      }
    }
  }
  return -1; // selector not found
}

/**
 * Asserts that styles.css imports `specifier` with layer(maka.legacy).
 * `layer(components)` sits below utilities, so demoting a file that must
 * outrank utilities silently reintroduces the #257 class of collapse.
 */
async function assertImportedIntoMakaLegacy(specifier: string): Promise<void> {
  const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
  const importLine = styles.split('\n').find((line) => line.includes(`"${specifier}"`));
  assert.ok(importLine, `styles.css must import ${specifier}`);
  assert.match(
    importLine,
    /layer\(maka\.legacy\)/,
    `${specifier} must be imported with layer(maka.legacy): its rules must outrank Tailwind utilities, ` +
      'and any other assignment (unlayered or layer(components)) changes their standing.',
  );
}

describe('renderer style layer cascade contract', () => {
  /**
   * Regression guard for #1565 PR 1 (cascade normalization).
   *
   * cascade-layers.css is the single owner of the renderer layer order, and
   * the whole rewrite is order-equivalent only while `maka.legacy` stays
   * declared after Tailwind's `utilities`: every product rule that used to
   * win by being unlayered now wins by living in a later-declared layer.
   * Migration PRs may append layers to the declaration; they must never
   * reorder these five.
   */
  it('declares maka.legacy after the Tailwind layers and establishes the order before any CSS loads', async () => {
    const layersFile = stripCssComments(await readFile('src/renderer/cascade-layers.css', 'utf8'));
    const declarations = [...layersFile.matchAll(/@layer\s+([^;{]+);/g)];
    assert.equal(declarations.length, 1, 'cascade-layers.css must contain exactly one @layer order declaration');
    const order = declarations[0][1].split(',').map((name) => name.trim());
    // The astryx layers must be TOP-LEVEL names. A sub-layer sits at its
    // parent's position, and a parent is ordered by its FIRST occurrence —
    // `astryx.reset, …, base, astryx.components` would collapse every
    // astryx.* layer to the astryx.reset slot below `base`, and Tailwind
    // preflight would beat every Astryx component rule (#1565 PR 2 review).
    // maka.legacy is exempt: it is the sole maka.* layer, so it has no
    // sibling sub-layer to mis-order against.
    const nested = order.filter((name) => name.includes('.') && name !== 'maka.legacy');
    assert.deepEqual(
      nested,
      [],
      'cascade-layers.css must not use dotted sub-layers: a sub-layer collapses to its parent layer’s ' +
        'first-occurrence position, which silently breaks the intended interleaving',
    );
    for (const [earlier, later] of [
      ['astryx-reset', 'astryx-tokens'],
      ['astryx-tokens', 'theme'],
      ['theme', 'base'],
      // Astryx component rules must beat Tailwind preflight's element resets,
      // and product CSS must keep beating Astryx until a slice removes it.
      ['base', 'astryx-components'],
      ['astryx-components', 'components'],
      ['components', 'utilities'],
      ['utilities', 'maka.legacy'],
    ]) {
      assert.ok(
        order.includes(earlier) && order.indexOf(earlier) < order.indexOf(later),
        `cascade-layers.css must declare ${earlier} before ${later}; got: ${order.join(', ')}. ` +
          'Reordering breaks the order-equivalence of the #1565 cascade normalization.',
      );
    }

    const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
    const firstImport = styles
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('@import'));
    assert.equal(
      firstImport,
      '@import "./cascade-layers.css";',
      'cascade-layers.css must be the first styles.css import so the layer order is established before any CSS loads',
    );
  });

  /**
   * Companion guard: the layer order above only carries the cascade while
   * every import lands in its contracted layer. An unlayered product import
   * would silently outrank every layer again (the pre-#1565 model).
   */
  it('keeps every styles.css import in its contracted cascade layer', async () => {
    const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
    const imports = [...styles.matchAll(/^@import\s+"([^"]+)"(?:\s+layer\(([^)]+)\))?\s*;/gm)].map(
      ([, specifier, layer]) => ({ specifier, layer: layer ?? null }),
    );
    assert.ok(imports.length > 30, `expected the full styles.css import list, found ${imports.length}`);

    // Deliberately unlayered: the order declaration itself, Tailwind (declares
    // its own top-level layers), fonts (@font-face only), and maka-tokens.css
    // (declares its own top-level @layer base/utilities/components blocks that
    // must keep merging into the Tailwind layers).
    const contractedUnlayered = new Set([
      './cascade-layers.css',
      'tailwindcss',
      '@fontsource-variable/geist',
      '@fontsource-variable/geist-mono',
      './maka-tokens.css',
    ]);
    // Astryx ships its sheets unlayered; each import must be pinned into its
    // astryx-* layer or it outranks maka.legacy and repaints the app (#1565
    // PR 2). Exact layer per file, not "any astryx-*": reset above components
    // would flip Astryx's own internal cascade. reset.css (PR 12, with the
    // Tailwind-preflight retirement) and theme.css (PR 3, with the first
    // component consumer) are not imported yet; their entries pin the layer
    // each must land in when it arrives.
    const contractedAstryx = new Map([
      ['@astryxdesign/core/reset.css', 'astryx-reset'],
      ['@astryxdesign/core/astryx.css', 'astryx-components'],
      ['@astryxdesign/theme-neutral/theme.css', 'astryx-tokens'],
    ]);
    const misplaced = imports.filter(({ specifier, layer }) => {
      if (contractedUnlayered.has(specifier)) return layer !== null;
      if (contractedAstryx.has(specifier)) return layer !== contractedAstryx.get(specifier);
      return layer !== 'maka.legacy' && layer !== 'components';
    });
    assert.deepEqual(
      misplaced.map(({ specifier, layer }) => `${specifier} -> ${layer ?? 'unlayered'}`),
      [],
      'Every styles.css import must be layer(maka.legacy)/layer(components) or on the contracted ' +
        'unlayered list. An unlayered product import outranks every layer and reverts to the pre-#1565 cascade.',
    );

    // overlayscrollbars trades specificity wins with the product CSS in both
    // directions, so it must share maka.legacy — either splitting it out to
    // unlayered or demoting it to components flips real outcomes (#1565 PR 1).
    const overlayScrollbars = imports.find(({ specifier }) => specifier === 'overlayscrollbars/overlayscrollbars.css');
    assert.equal(overlayScrollbars?.layer, 'maka.legacy', 'overlayscrollbars must share layer(maka.legacy) with the product CSS');
  });

  it('keeps feature stylesheets free of local @layer blocks so layering happens at the import site', async () => {
    const layeredFiles: string[] = [];
    for (const file of await readCssTree(RENDERER_STYLES_DIR)) {
      const source = stripCssComments(await readFile(file, 'utf8'));
      if (/@layer\b/.test(source)) {
        layeredFiles.push(file);
      }
    }

    assert.deepEqual(
      layeredFiles,
      [],
      'Feature stylesheets under apps/desktop/src/renderer/styles must not declare local @layer blocks; ' +
        'they are layered at their styles.css import site. Keep Tailwind layer integration in maka-tokens.css.',
    );
  });

  /**
   * Regression guard for #257 / #253 Round A.
   *
   * Sidebar rows are semantic Base UI navigation controls whose grid layout
   * lives in `.maka-nav-row`.
   *
   * That only holds while `.maka-nav-row` outranks the utilities. #257 wrapped
   * styles.css into `@layer base`/`@layer components`; because Tailwind v4
   * orders `base, components, utilities`, the layered `.maka-nav-row` lost to
   * `inline-flex justify-center`, collapsing every sidebar button (nav rows,
   * session rows, settings) to flex-centered content. Since #1565 PR 1 these
   * override rules win by living in `maka.legacy` (declared AFTER utilities);
   * a file-local layer block would demote them below utilities again.
  */
  it('keeps .maka-nav-row directly in maka.legacy so it beats Tailwind button utilities', async () => {
    const styles = await readAllRendererCss();
    const layers = enclosingLayerCount(styles, '.maka-nav-row {');
    assert.notEqual(layers, -1, '.maka-nav-row { rule not found in styles.css');
    assert.equal(
      layers,
      0,
      `.maka-nav-row is nested in ${layers} file-local @layer block(s); it must sit directly in its ` +
        'import-site maka.legacy layer (declared after utilities) to remain the authoritative ' +
        'semantic navigation-row layout. See #257 regression.',
    );
    await assertImportedIntoMakaLegacy('./styles/sidebar.css');
  });

  it('keeps the composite session target on the same control radius as its row action', async () => {
    const styles = await readAllRendererCss();
    assert.match(
      styles,
      /\.maka-list-row-main\s*\{[^}]*border-radius:\s*var\(--radius-control\);[^}]*\}/,
      'the semantic session target must own the same governed radius as .maka-list-row-menu-trigger',
    );
  });

  it('keeps composite session-list controls on one complete interaction contract', async () => {
    const styles = await readAllRendererCss();
    const controls = ':is\\(\\.maka-list-project-heading, \\.maka-list-project-more\\)';

    assert.match(styles, new RegExp(`${controls}:hover\\s*\\{[^}]*background:\\s*var\\(--state-hover-bg\\);`));
    assert.match(styles, new RegExp(`${controls}:active\\s*\\{[^}]*background:\\s*var\\(--state-selected-bg\\);`));
    assert.match(styles, new RegExp(`${controls}:focus-visible\\s*\\{[^}]*outline:\\s*var\\(--focus-ring-width\\) solid var\\(--focus-ring\\);`));
    assert.match(styles, new RegExp(`${controls}:disabled\\s*\\{[^}]*opacity:\\s*var\\(--opacity-disabled\\);`));
  });

  it('keeps settings utility actions on governed Button variants instead of unlayered reskins', async () => {
    const [styles, permission, health, password] = await Promise.all([
      readAllRendererCss(),
      readFile('src/renderer/settings/permission-center-page.tsx', 'utf8'),
      readFile('src/renderer/settings/health-center-page.tsx', 'utf8'),
      readFile('src/renderer/settings/password-input.tsx', 'utf8'),
    ]);

    assert.match(permission, /<Button\s+type="button"\s+variant="secondary"\s+size="sm"[\s\S]*?>\s*\{copy\.detectAgain\}/);
    assert.match(health, /<Button\s+type="button"\s+variant="secondary"\s+size="sm"[\s\S]*?>\s*\{copy\.refresh\}/);
    assert.equal(password.match(/variant="quiet"\s+size="icon-sm"/g)?.length, 2);

    for (const legacyClass of ['settingsPermissionRefresh', 'settingsHealthRefresh', 'settingsPasswordToggle']) {
      assert.doesNotMatch(`${permission}\n${health}\n${password}`, new RegExp(`className="${legacyClass}"`));
      assert.doesNotMatch(styles, new RegExp(`\\.${legacyClass}(?:\\s|:|\\{|\\[)`));
    }
  });

  it('does not retain a second prose or Markdown-link styling authority beside Astryx', async () => {
    const styles = stripCssComments(await readFile(STYLES_FILE, 'utf8'));
    assert.doesNotMatch(styles, /styles\/(?:prose|markdown-link)\.css/);
  });

  it('keeps the darwin glass .maka-nav-row color override directly in maka.legacy so it beats quiet Button text utilities', async () => {
    const styles = await readAllRendererCss();
    const layers = enclosingLayerCount(styles, 'html[data-os="darwin"] .maka-nav-row {');
    assert.notEqual(layers, -1, 'darwin .maka-nav-row glass rule not found in renderer CSS');
    assert.equal(
      layers,
      0,
      'html[data-os="darwin"] .maka-nav-row must sit directly in its import-site maka.legacy layer ' +
        '(declared after utilities) because the glass theme needs to override shared quiet Button text utilities on the same element.',
    );
    await assertImportedIntoMakaLegacy('./styles/theme-glass.css');
  });
});
