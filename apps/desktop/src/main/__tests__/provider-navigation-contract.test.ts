import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';

const PANEL = resolve(import.meta.dirname, '../../../src/renderer/settings/ProvidersPanel.tsx');
const SETTINGS_SURFACE = resolve(import.meta.dirname, '../../../src/renderer/settings/settings-surface.tsx');
const PROVIDER_CSS = resolve(import.meta.dirname, '../../../src/renderer/styles/settings/provider-editor.css');

describe('Settings model provider page hierarchy', () => {
  test('keeps connected models and the add catalog on one root page, with dialogs for create and manage', async () => {
    const source = await readFile(PANEL, 'utf8');

    assert.match(source, /type ProviderDialogState\s*=/, 'ProvidersPanel must own one dialog selection state');
    assert.match(source, /kind:\s*'create'/, 'the dialog state must represent a provider being created');
    assert.match(source, /kind:\s*'manage'/, 'the dialog state must represent an existing connection being managed');
    assert.doesNotMatch(source, /type ProviderPage\s*=/, 'catalog/add/detail child-page routing must be removed');
    const connected = source.indexOf('className="enabledStrip"');
    const catalog = source.indexOf('className="providerCatalogSection"');
    assert.ok(connected >= 0 && catalog > connected, 'the add catalog must render below connected models on the same page');
    assert.doesNotMatch(source, /<ProviderPageHeader/, 'the root page must not navigate through provider child pages');
  });

  test('catalog supports search and the five user-intent categories', async () => {
    const source = await readFile(PANEL, 'utf8');

    assert.match(source, /placeholder=\{copy\.searchPlaceholder\}/);
    for (const category of ['recommended', 'plans', 'api', 'aggregators', 'local']) {
      assert.match(source, new RegExp(`['"]${category}['"]`), `missing catalog category ${category}`);
    }
  });

  test('recommended catalog mixes runnable account connections and hides unavailable providers', async () => {
    const source = await readFile(PANEL, 'utf8');

    assert.match(source, /catalogCategory === 'recommended'[\s\S]*<ModelOAuthSection/);
    assert.match(source, /PROVIDER_DEFAULTS\[type\]\.status !== 'ready'/);
    assert.match(source, /['"]accounts['"]/, 'runnable account connections remain directly browseable');
  });

  test('inline catalog keeps standard search chrome below its category tabs', async () => {
    const [source, css] = await Promise.all([
      readFile(PANEL, 'utf8'),
      readFile(PROVIDER_CSS, 'utf8'),
    ]);

    // The catalog title converged onto SectionHeader; it still carries the id
    // the section's aria-labelledby points at (via the primitive's titleId).
    assert.match(source, /className="providerCatalogSection" aria-labelledby="provider-catalog-title"/);
    assert.match(source, /<SectionHeader[\s\S]*titleId="provider-catalog-title"[\s\S]*title=\{copy\.add\}/);
    assert.match(
      source,
      /<PrimitiveTabsList[\s\S]*<TextInput[\s\S]*className="providerCatalogSearch"[\s\S]*startIcon=\{<Search/,
      'category scope must precede the canonical Astryx search field',
    );
    assert.match(
      css,
      /\.providerCatalogSearch\s*\{[^}]*width:\s*min\(100%, 360px\);[^}]*min-height:\s*var\(--h-control-lg\);/,
      'catalog search must stay compact without collapsing below the standard control height',
    );
  });

  test('consumes an external catalog request after its first loaded model-page mount', async () => {
    const source = await readFile(SETTINGS_SURFACE, 'utf8');

    assert.match(source, /useState\(props\.openProviderCatalog === true\)/);
    assert.match(
      source,
      /if \(!loading && section === 'models' && providerCatalogRequested\) \{\s*setProviderCatalogRequested\(false\);\s*\}/,
      'the first loaded model page must consume the one-shot catalog intent',
    );
    assert.match(source, /openProviderCatalog=\{providerCatalogRequested\}/);
    assert.doesNotMatch(
      source,
      /openProviderCatalog=\{props\.openProviderCatalog\}/,
      'the shell request must not be replayed every time the model page remounts',
    );
  });
});
