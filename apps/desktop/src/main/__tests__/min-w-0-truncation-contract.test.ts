/**
 * PR-ANTI-LAYOUT-SHIFT-MIN-W-0-0 (issue #520 PR3):
 * flex/grid children that truncate text need `min-width: 0` to release the
 * default `min-width: auto` (which equals min-content and stops ellipsis
 * from triggering). Missing min-width:0 is a historic truncation-bug source.
 *
 * Invariant: every CSS rule that declares `text-overflow: ellipsis` +
 * `white-space: nowrap` (the truncation intent) must, *for that selector*,
 * also have `min-width: 0` somewhere — UNLESS the selector is on the
 * truncation exception list:
 *   - parent grid uses a `minmax(0, …)` track (column can shrink to 0
 *     without the child needing min-width:0), or
 *   - the ellipsis is dead code (e.g. `flex-shrink: 0` means the item never
 *     shrinks so ellipsis can't fire — a separate dead-code cleanup, not a
 *     min-w-0 gap).
 *
 * Adding a new truncation surface: give it min-width:0. If it sits in a
 * grid with a minmax(0,…) track, or its ellipsis is dead for another
 * reason, add it to TRUNCATION_EXCEPTIONS with a comment explaining why.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { REPO_ROOT, readCssTree, stripCssComments } from './css-test-helpers.js';

const RENDERER_ROOT = resolve(REPO_ROOT, 'apps/desktop/src/renderer');

// Selectors exempt from the min-width:0 requirement. Keep this short and
// comment each entry with the reason it doesn't need min-width:0.
const TRUNCATION_EXCEPTIONS = new Set<string>([
  // parent .maka-artifact-row: grid-template-columns: 16px minmax(0,1fr) auto
  '.maka-artifact-row-name',
  // flex-shrink:0 makes this meta non-shrinkable, so ellipsis never fires
  // (dead code, not a min-w-0 gap). Tracked separately for dead-ellipsis cleanup.
  '.maka-list-row-meta',
]);

type TruncationSite = { file: string; selector: string };

async function scanTruncationSites(): Promise<{
  minWidthSelectors: Set<string>;
  truncation: TruncationSite[];
}> {
  const files = await readCssTree(RENDERER_ROOT);
  const minWidthSelectors = new Set<string>();
  const truncation: TruncationSite[] = [];
  for (const file of files) {
    const source = stripCssComments(await readFile(file, 'utf8'));
    const root = postcss.parse(source, { from: file });
    root.walkRules((rule) => {
      const decls = rule.nodes.filter((n): n is postcss.Declaration => n.type === 'decl');
      const hasMinWidth0 = decls.some(
        (d) => d.prop === 'min-width' && /^0\b/.test(d.value.trim()),
      );
      const hasEllipsis = decls.some((d) => d.prop === 'text-overflow' && /ellipsis/.test(d.value));
      const hasNowrap = decls.some((d) => d.prop === 'white-space' && /nowrap/.test(d.value));
      for (const sel of rule.selectors) {
        if (hasMinWidth0) minWidthSelectors.add(sel);
        if (hasEllipsis && hasNowrap) truncation.push({ file, selector: sel });
      }
    });
  }
  return { minWidthSelectors, truncation };
}

describe('PR-ANTI-LAYOUT-SHIFT-MIN-W-0-0 contract', () => {
  it('every ellipsis+nowrap truncation rule has min-width:0 (or is a listed exception)', async () => {
    const { minWidthSelectors, truncation } = await scanTruncationSites();
    const offenders = truncation
      .filter((t) => !minWidthSelectors.has(t.selector) && !TRUNCATION_EXCEPTIONS.has(t.selector))
      .map((t) => `${t.file.replace(RENDERER_ROOT + '/', '')}: ${t.selector}`);
    assert.deepEqual(
      offenders,
      [],
      `Truncation rules with ellipsis+nowrap but no min-width:0 (add min-width:0, or add to TRUNCATION_EXCEPTIONS with a reason):\n  ${offenders.join('\n  ')}`,
    );
  });

  it('exception list only contains selectors that are actually truncation sites', async () => {
    const { truncation } = await scanTruncationSites();
    const truncationSelectors = new Set(truncation.map((t) => t.selector));
    const stale = [...TRUNCATION_EXCEPTIONS].filter((s) => !truncationSelectors.has(s));
    assert.deepEqual(
      stale,
      [],
      `TRUNCATION_EXCEPTIONS has entries that are no longer ellipsis+nowrap truncation sites (remove them): ${stale.join(', ')}`,
    );
  });
});
