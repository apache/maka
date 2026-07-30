/**
 * PR-ANTI-LAYOUT-SHIFT-TABULAR-NUMS-0 (issue #520 PR3):
 * lock `tabular-nums` on every known numeric surface so digit columns
 * stay aligned and numbers don't jitter layout as they change
 * (token counts, timestamps, usage stats, progress, file sizes, costs).
 *
 * Two invariants:
 *
 * 1. Each whitelisted selector must appear in a renderer CSS rule that
 *    *declares* `font-variant-numeric: tabular-nums` (directly, not only
 *    via inheritance — inheritance is fine visually but can't be enforced
 *    here, so the rule that owns the number surface carries the declaration).
 *
 * 2. The `RelativeTime` component renders `tabular-nums` on its `<small>`,
 *    because it backs every self-refreshing timestamp across the app and
 *    a single source beats chasing each call site's CSS.
 *
 * Adding a new numeric surface: give it `tabular-nums` AND add its
 * selector here, so it can't silently regress.
 */
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import postcss from 'postcss';
import { REPO_ROOT, readCssTree, stripCssComments } from './css-test-helpers.js';

const RENDERER_ROOT = resolve(REPO_ROOT, 'apps/desktop/src/renderer');
const RELATIVE_TIME_SRC = resolve(REPO_ROOT, 'packages/ui/src/relative-time.tsx');

// Selectors that own a "number that changes" surface and must declare
// tabular-nums themselves. Kept as a flat list so a regression on any one
// fails the test with a precise diff.
const TABULAR_NUMS_SELECTORS = [
  // timestamps / durations
  '.maka-message-time-inline',
  '.maka-plan-run-row time',
  '.maka-daily-review-session-time',
  '.maka-list-row-meta',
  '.maka-daily-review-day',
  // counts / totals badges
  '.maka-session-workbar-count',
  '.maka-artifact-row-meta',
  '.settingsRow > span',
  '.maka-daily-review-archive-count',
  '.maka-daily-review-archive-row-meta',
  '.maka-daily-review-top-meta',
  '.maka-nav-count',
  '.settingsQuotaRow',
  // settings numeric surfaces
  '.settingsUsageRecordCount',
  '.settingsMemoryEntryGroupHeader',
  // skill counts
  '.maka-skill-tab span',
  '.maka-skill-section-row small',
  // search result counts
  '.maka-search-modal-result-summary',
  // provider counts (the connected-section count converged onto SectionHeader,
  // whose count slot bakes tabular-nums — pinned against the primitive below)
  '.providerEnabledModelsHeader strong',
  // plan search count
  '.maka-plan-search-summary',
];

async function readTabularNumsCoveredSelectors(): Promise<Set<string>> {
  const files = await readCssTree(RENDERER_ROOT);
  const covered = new Set<string>();
  for (const file of files) {
    const source = stripCssComments(await readFile(file, 'utf8'));
    const root = postcss.parse(source, { from: file });
    root.walkRules((rule) => {
      const hasTabular = rule.nodes.some(
        (n) => n.type === 'decl' && n.prop === 'font-variant-numeric' && /tabular-nums/.test(n.value),
      );
      if (hasTabular) {
        for (const sel of rule.selectors) covered.add(sel);
      }
    });
  }
  return covered;
}

// Convergence R4: the four stat-tile surfaces (permission/health summaries,
// MetricCard, daily-review totals) render through the StatTile primitive,
// whose value slot BAKES tabular-nums as a Tailwind utility — pinned below
// against the primitive source instead of renderer CSS selectors.
describe('PR-ANTI-LAYOUT-SHIFT-TABULAR-NUMS-0 contract', () => {
  it('StatTile bakes tabular-nums into its value slot (stat-tile surfaces converged in R4)', async () => {
    const statTile = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/stat-tile.tsx'), 'utf8');
    assert.match(statTile, /\[font-variant-numeric:tabular-nums\]/, 'StatTile value must keep tabular-nums baked in');
  });

  it('SectionHeader bakes tabular-nums into its count slot (provider count converged here)', async () => {
    const sectionHeader = await readFile(resolve(REPO_ROOT, 'packages/ui/src/primitives/section-header.tsx'), 'utf8');
    assert.match(sectionHeader, /\[font-variant-numeric:tabular-nums\]/, 'SectionHeader count must keep tabular-nums baked in');
  });

  it('every whitelisted numeric surface declares tabular-nums in renderer CSS', async () => {
    const covered = await readTabularNumsCoveredSelectors();
    const missing = TABULAR_NUMS_SELECTORS.filter((s) => !covered.has(s));
    assert.deepEqual(missing, [], `Selectors missing a tabular-nums declaration:\n  ${missing.join('\n  ')}`);
  });

  it('RelativeTime renders tabular-nums (covers all self-refreshing timestamps)', async () => {
    const src = await readFile(RELATIVE_TIME_SRC, 'utf8');
    assert.match(
      src,
      /tabular-nums/,
      'RelativeTime must add tabular-nums to its <small> so self-refreshing timestamps stay aligned as they tick',
    );
  });
});
