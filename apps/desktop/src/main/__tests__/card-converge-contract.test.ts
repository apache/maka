/**
 * CARD-CONVERGE-0 (issue #520 PR9): the hand-written settings card surfaces
 * migrate onto a shared Card primitive so the container is the primitive,
 * not a bare `<div>` carrying a hand-rolled class.
 *
 * - settingsRows (row-list container) + settingsMetricCard (metric tile) +
 *   maka-error-card (crash surface) → Card
 *
 * #1565 PR 3: Card is the Astryx primitive re-exported from the barrel (the
 * thin `data-slot="card"` recipe is retired). Astryx Card owns the card face
 * (background, border, radius, elevation); each site's class keeps only its
 * layout geometry. maka-error-card stays on Card (not Alert/Banner) because
 * it is a large crash surface with stack <pre>, not a small inline callout —
 * its destructive face is Card's own vocabulary (variant="red",
 * elevation="high").
 *
 * The usage stats table is NOT on a public Table primitive: with only one HTML
 * <table> consumer it was premature abstraction (PR9 review P3), so
 * UsageStatsTable keeps its styles inline in usage-settings-page (shared across
 * all five usage tabs). The table a11y semantics (aria-label + scope) and
 * per-column alignment are locked in settings-usage-contract.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

/** Sites whose top-level container becomes <Card>. */
const CARD_SITES = [
  'apps/desktop/src/renderer/settings/settings-rows.tsx',
  // settings-metric-card retired its Card wrapper in convergence R4 — it is
  // a thin alias over the shared StatTile primitive now.
  'apps/desktop/src/renderer/error-boundary.tsx',
];

/** Pages that used <div className="settingsRows"> directly — must route through SettingsRows (Card-backed) now. */
const SETTINGS_ROWS_CONSUMERS = [
  'apps/desktop/src/renderer/settings/daily-review-settings-page.tsx',
  'apps/desktop/src/renderer/settings/web-search-settings-page.tsx',
  'apps/desktop/src/renderer/settings/memory-settings-page.tsx',
];

const UI_BARREL = 'packages/ui/src/index.ts';

const CARD_IMPORT_RE =
  /import\s+\{[^}]*\bCard\b[^}]*\}\s+from\s+['"][^'"]*@maka\/ui['"]/;

describe('card converge (#520 PR9)', () => {
  it('re-exports the Astryx Card from the barrel', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, UI_BARREL), 'utf8');
    assert.match(
      barrel,
      /export\s+\{[^}]*\bCard\b[^}]*\}\s+from\s+['"]@astryxdesign\/core['"]/,
      'the @maka/ui Card must be the Astryx primitive, not a local recipe',
    );
  });

  it('card sites import Card', async () => {
    for (const rel of CARD_SITES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(CARD_IMPORT_RE.test(src), `${rel} must import Card from @maka/ui`);
    }
  });

  it('settingsRows consumer pages no longer use a bare <div className="settingsRows">', async () => {
    for (const rel of SETTINGS_ROWS_CONSUMERS) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(
        !/<div\s+className=["'][^"']*\bsettingsRows\b/.test(src),
        `${rel} must route through SettingsRows/Card, not a bare div.settingsRows`,
      );
    }
  });
});