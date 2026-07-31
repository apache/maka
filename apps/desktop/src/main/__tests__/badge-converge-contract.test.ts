/**
 * BADGE-CONVERGE-0 (issue #520 PR9): collapse the coexisting badge surfaces
 * onto two canonical primitives, split by UI role:
 *   - pill `Badge` (packages/ui/src/primitives/badge.tsx) — emphasis markers
 *   - squared `Chip` (packages/ui/src/primitives/chip.tsx) — dense status rows
 *
 * Before: four tracks —
 *   1. `PrimitiveBadge` (the Base UI primitive, aliased to avoid colliding
 *      with the legacy)
 *   2. legacy `Badge` in `ui.tsx` (hand-written, raw emerald/amber colors)
 *   3. `.settingsBadge` span (neutral label chip, CSS class)
 *   4. `.settingsConnectionBadge` span (data-tone status chip, CSS class)
 *
 * After: `PrimitiveBadge` alias and the legacy `ui.tsx` Badge are gone; pill
 * badge sites route through `<Badge>`. The two settings CSS chips (3, 4) route
 * through the squared `<Chip>` primitive instead — see chip-converge-contract.
 * Badge and Chip stay separate because settings rows need compact squared
 * chips (radius-control), not pill emphasis markers.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { REPO_ROOT } from './css-test-helpers.js';

/** Sites that now route through the pill Badge primitive (was PrimitiveBadge or legacy ui.tsx Badge). */
const MIGRATED_FILES = [
  'apps/desktop/src/renderer/settings/health-center-page.tsx',
  'apps/desktop/src/renderer/settings/permission-center-page.tsx',
  'apps/desktop/src/renderer/artifact-pane.tsx',
  'packages/ui/src/plan-reminder-panel.tsx',
];

const PACKAGE_BARREL = 'packages/ui/src/index.ts';
const UI_BARREL = 'packages/ui/src/ui.tsx';

// Desktop files import Badge from @maka/ui; files inside packages/ui import
// @astryxdesign/core directly (the same primitive the barrel re-exports —
// a package cannot import its own barrel).
const BADGE_IMPORT_RE =
  /import\s+\{[^}]*\bBadge\b[^}]*\}\s+from\s+['"][^'"]*?(?:@maka\/ui|@astryxdesign\/core)['"]/;

describe('badge converge (#520 PR9)', () => {
  it('re-exports the Astryx Badge from the barrel (#1565 PR 3)', async () => {
    const barrel = await readFile(resolve(REPO_ROOT, PACKAGE_BARREL), 'utf8');
    assert.match(
      barrel,
      /export\s+\{[^}]*\bBadge\b[^}]*\}\s+from\s+['"]@astryxdesign\/core['"]/,
      'the @maka/ui Badge must be the Astryx primitive, not a local recipe',
    );
  });

  it('legacy Badge + badgeVariants are gone from ui.tsx', async () => {
    const src = await readFile(resolve(REPO_ROOT, UI_BARREL), 'utf8');
    assert.ok(
      !/export function Badge\b/.test(src),
      'ui.tsx must not export the legacy hand-written Badge',
    );
    // the legacy badgeVariants (raw emerald/amber cva) must be gone too
    assert.ok(
      !/emerald-500|amber-500/.test(src),
      'ui.tsx must not carry the legacy raw-color badgeVariants',
    );
  });

  it('migrated sites import Badge from @maka/ui', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(BADGE_IMPORT_RE.test(src), `${rel} must import Badge from @maka/ui`);
    }
  });

  it('no <PrimitiveBadge> remains (aliased name retired)', async () => {
    for (const rel of MIGRATED_FILES) {
      const src = await readFile(resolve(REPO_ROOT, rel), 'utf8');
      assert.ok(!/<PrimitiveBadge\b/.test(src), `${rel} must use <Badge>, not <PrimitiveBadge>`);
    }
  });

});
