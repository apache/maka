/**
 * PR-FE-BUG-HUNT-12 (kenji aesthetic-audit reminder 4-6, finding #1):
 * `packages/ui/src/ui.tsx` is a motion / design contract blind spot.
 *
 * The PR-MOTION-TOKEN-CONVERGE-0 contract scans
 * `packages/ui/src/primitives/` and `apps/desktop/src/renderer/`, but
 * NOT the aggregate UI re-export layer at `packages/ui/src/ui.tsx`.
 * That file historically inlined Tailwind design escape hatches which would
 * otherwise be caught by the existing motion / z-index converge contracts.
 *
 * This test pins the EXACT set of design-system escape hatches that
 * currently exist in ui.tsx. Adding a new escape-hatch class without
 * updating the allowlist will fail this test. Removing an entry that
 * no longer exists also fails — preventing stale allowlist drift.
 *
 * The intent is NOT to remove these in this PR (that would touch Base
 * UI primitive wrappers and risk visual breakage). The intent is to
 * lock the perimeter so kenji / WAWQAQ can decide one at a time which
 * to tokenize, and so no NEW primitive PR can introduce a sixth or
 * seventh escape hatch without explicit acknowledgment.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const UI_FILE = resolve(REPO_ROOT, 'packages/ui/src/ui.tsx');

/** Each entry is one allowed bare design-system escape hatch.
 *  `pattern` is the literal substring expected in ui.tsx; `count` is
 *  the number of distinct occurrences. Bump the count when adding a
 *  new acknowledged site; remove the entry when the last site is
 *  tokenized away. */
const ALLOWED_BARE: ReadonlyArray<{ pattern: string; count: number; reason: string }> = [
  // Astryx owns every floating-layer visual; no local escape hatch remains.
];

describe('PR-FE-BUG-HUNT-12 ui.tsx design contract', () => {
  it('every allowed bare class appears in ui.tsx exactly the expected number of times', async () => {
    const src = await readFile(UI_FILE, 'utf8');
    for (const entry of ALLOWED_BARE) {
      // Use a regex to count occurrences. Escape brackets etc.
      const escaped = entry.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'g');
      const matches = src.match(regex) ?? [];
      assert.equal(
        matches.length,
        entry.count,
        `Expected ${entry.count} occurrences of \`${entry.pattern}\` in packages/ui/src/ui.tsx, found ${matches.length}. Either tokenize the new site or bump the count in ALLOWED_BARE with a justification.`,
      );
    }
  });

  it('no UNEXPECTED bare z-index classes have crept in (z-0 through z-50)', async () => {
    const src = await readFile(UI_FILE, 'utf8');
    // Tailwind default z-index utilities are z-0, z-10, z-20, z-30,
    // z-40, z-50. Only z-40 and z-50 are allowlisted above; any z-0
    // / z-10 / z-20 / z-30 would be a new escape hatch.
    const UNEXPECTED = ['z-0', 'z-10', 'z-20', 'z-30'];
    for (const pat of UNEXPECTED) {
      const regex = new RegExp(`\\b${pat}\\b`, 'g');
      const matches = src.match(regex) ?? [];
      assert.equal(
        matches.length,
        0,
        `Found ${matches.length} bare \`${pat}\` in ui.tsx. Tokenize via --z-* or, if intentional, add to ALLOWED_BARE with a justification.`,
      );
    }
  });

  it('no new bare backdrop-blur intensity variants have crept in beyond `sm`', async () => {
    const src = await readFile(UI_FILE, 'utf8');
    // We allow backdrop-blur-sm (allowlisted above). Any other intensity
    // (md / lg / xl / 2xl / 3xl / none / [arbitrary]) is a new escape hatch.
    const UNEXPECTED_BLURS = [
      'backdrop-blur-md',
      'backdrop-blur-lg',
      'backdrop-blur-xl',
      'backdrop-blur-2xl',
      'backdrop-blur-3xl',
      'backdrop-blur-none',
    ];
    for (const pat of UNEXPECTED_BLURS) {
      const regex = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      const matches = src.match(regex) ?? [];
      assert.equal(
        matches.length,
        0,
        `Found ${matches.length} occurrences of \`${pat}\` in ui.tsx. Tokenize via --blur-* or, if intentional, add to ALLOWED_BARE with a justification.`,
      );
    }
  });
});
