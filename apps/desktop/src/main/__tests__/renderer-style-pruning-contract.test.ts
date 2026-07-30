import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT, readAllRendererCss } from './css-test-helpers.js';

const SOURCE_ROOTS = [
  resolve(REPO_ROOT, 'apps', 'desktop', 'src', 'renderer'),
  resolve(REPO_ROOT, 'packages', 'ui', 'src'),
];
const SOURCE_EXTENSIONS = new Set(['.html', '.js', '.jsx', '.ts', '.tsx']);
const DYNAMIC_STYLE_HOOKS = new Set([
  // OverlayScrollbars appends these classes under the configured
  // `os-theme-maka` theme at runtime.
  'os-scrollbar-horizontal',
  'os-scrollbar-vertical',
  // Token/runtime utility hooks defined in maka-tokens.css. These are
  // intentionally available to markdown renderers, prose plugins, and
  // shell surfaces without requiring a literal JSX className consumer.
  'class_',
  'contains-task-list',
  'function_',
  'hljs-addition',
  'hljs-attr',
  'hljs-attribute',
  'hljs-built_in',
  'hljs-bullet',
  'hljs-class',
  'hljs-comment',
  'hljs-deletion',
  'hljs-doctag',
  'hljs-emphasis',
  'hljs-keyword',
  'hljs-literal',
  'hljs-meta',
  'hljs-name',
  'hljs-number',
  'hljs-quote',
  'hljs-regexp',
  'hljs-selector-tag',
  'hljs-string',
  'hljs-strong',
  'hljs-symbol',
  'hljs-tag',
  'hljs-title',
  'hljs-type',
  'hljs-variable',
  'maka-shell-rail-right',
  'maka-shimmer',
  'maka-sidebar-button',
  'maka-sidebar-header',
  'maka-sidebar-row',
  'maka-sidebar-section',
  'maka-titlebar',
  'scrollbar-hide',
  'scrollbar-hover',
  'shadow-medium',
  'shadow-minimal',
  'shadow-minimal-flat',
  'shadow-modal',
  'smooth-corners',
  'task-list-item',
  // PR-PALETTE-SWATCH-VISIBLE-0 (WAWQAQ msg `d3ea9a33` 2026-06-26):
  // ThemeSettingsPage composes the palette swatch class with a template
  // string — `settingsPaletteSwatch settingsPaletteSwatch-${palette}` —
  // so the literal `.settingsPaletteSwatch-{name}` selector for each
  // palette never appears verbatim in the renderer source. The CSS
  // rules in `styles/settings/theme-preview.css` are real and consumed
  // at runtime; allowlist them so the orphan-selector guard doesn't
  // delete the colored backgrounds again.
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

async function readSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return readSourceFiles(entryPath);
    if (!SOURCE_EXTENSIONS.has(entryPath.slice(entryPath.lastIndexOf('.')))) return [];
    return [await readFile(entryPath, 'utf8')];
  }));
  return files.flat();
}

function stripCssComments(styles: string): string {
  return styles.replace(/\/\*[\s\S]*?\*\//g, '');
}

function collectClassSelectors(styles: string): string[] {
  const selectors = new Set<string>();
  for (const match of stripCssComments(styles).matchAll(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g)) {
    const selector = match[1];
    if (!selector.startsWith('-')) selectors.add(selector);
  }
  return [...selectors].sort();
}

describe('renderer style pruning contract', () => {
  it('does not keep CSS for retired renderer hooks', async () => {
    const styles = await readAllRendererCss();
    const retiredHooks = [
      'connectionStatus',
      'maka-indeterminate-bar',
      'maka-nav-disclosure',
      'maka-nav-primary',
      'maka-nav-tree',
      'maka-session-archive-link',
      'maka-session-filter',
      'maka-session-panel-help-chip',
      'maka-session-search-clear',
      'maka-sidebar-brand',
      'maka-skill-workbench-rail',
      'maka-streaming-token-fade-in',
      'modePill',
      'providerCatalog',
      'settingsCardProviders',
      'settingsFeatureStatusHeroActions',
      'settingsHeader',
    ];

    for (const hook of retiredHooks) {
      assert.doesNotMatch(styles, new RegExp(`\\.${hook}\\b`), `${hook} is retired and must not remain in styles.css`);
    }
  });

  it('does not add unaccounted orphan class selectors to styles.css', async () => {
    const [styles, sourceFiles] = await Promise.all([
      readAllRendererCss(),
      Promise.all(SOURCE_ROOTS.map((root) => readSourceFiles(root))).then((groups) => groups.flat()),
    ]);
    const source = sourceFiles.join('\n');
    const orphanSelectors = collectClassSelectors(styles).filter((selector) => {
      if (DYNAMIC_STYLE_HOOKS.has(selector)) return false;
      return !source.includes(selector);
    });

    assert.deepEqual(
      orphanSelectors,
      [],
      `renderer styles contain class selectors with no renderer/@maka/ui source consumer. ` +
        `Delete the style, move it next to the consuming primitive, or add a documented runtime hook allowlist entry: ${orphanSelectors.join(', ')}`,
    );
  });
});
