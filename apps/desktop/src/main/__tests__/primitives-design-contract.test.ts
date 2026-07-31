/**
 * Lock the design-system escape hatches in tabs.tsx.
 *
 * Same approach as the ui.tsx contract: pin the EXACT escape-hatch
 * count, fail when new ones creep in OR when stale allowlist entries
 * point at content that no longer exists.
 *
 * tabs.tsx has 2 `transition-[<list>]` patterns. The indicator duration and
 * easing both use the renderer's canonical motion tokens.
 * The counts here are derived from `grep -o ... | wc -l`.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const TABS_FILE = resolve(REPO_ROOT, 'packages/ui/src/primitives/tabs.tsx');

const TABS_ALLOWED: ReadonlyArray<{ pattern: string; count: number; reason: string }> = [
  {
    pattern: 'transition-[width,translate]',
    count: 1,
    reason:
      "tabs active-indicator animates width because tabs have variable label widths. Cleaner refactor is `translate + scaleX` with a measured base width, but that needs measurement infrastructure that isn't in place. Layout-property transition is acknowledged.",
  },
  {
    pattern: 'transition-[color,background-color,box-shadow]',
    count: 1,
    reason:
      'tabs trigger paint transition. No layout properties. Safe; allowlisted for completeness.',
  },
];

function countOccurrences(src: string, pattern: string): number {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(escaped, 'g');
  return (src.match(regex) ?? []).length;
}

describe('PR-FE-BUG-HUNT-13 tabs.tsx design contract', () => {
  it('tabs.tsx escape hatches match the allowlist exactly', async () => {
    const src = await readFile(TABS_FILE, 'utf8');
    for (const entry of TABS_ALLOWED) {
      assert.equal(
        countOccurrences(src, entry.pattern),
        entry.count,
        `Expected ${entry.count} occurrences of \`${entry.pattern}\` in tabs.tsx, got a different count. Either tokenize the new site or bump the count in TABS_ALLOWED with a justification.`,
      );
    }
  });

  it('no unexpected `transition-[<bracketed-list>]` patterns crept into tabs.tsx', async () => {
    const src = await readFile(TABS_FILE, 'utf8');
    const found = new Set(src.match(/transition-\[[^\]]+\]/g) ?? []);
    const allowed = new Set(
      TABS_ALLOWED.filter((e) => e.pattern.startsWith('transition-[')).map((e) => e.pattern),
    );
    const unexpected = [...found].filter((m) => !allowed.has(m));
    assert.deepEqual(
      unexpected,
      [],
      `Found unexpected transition-[<bracketed>] patterns in tabs.tsx: ${JSON.stringify(unexpected)}. Add to TABS_ALLOWED with a justification, or refactor.`,
    );
  });

  it('uses canonical motion tokens for the indicator transition', async () => {
    const src = await readFile(TABS_FILE, 'utf8');
    const indicator = src.match(/<TabsPrimitive\.Indicator[\s\S]*?data-slot="tab-indicator"[\s\S]*?\/>/)?.[0] ?? '';
    assert.ok(indicator, 'TabsPrimitive.Indicator block must remain discoverable');
    assert.match(indicator, /transition-\[width,translate\]/);
    assert.match(indicator, /duration-\[var\(--duration-base\)\]/);
    assert.match(indicator, /ease-\[var\(--ease-in-out-strong\)\]/);
    assert.doesNotMatch(indicator, /\bduration-200\b/);
  });
});
