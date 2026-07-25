/**
 * Source-grounded contract for PR-COMPOSER-ESC-DRAG-CLEAR-0
 * (resume of WAWQAQ goal 751c4f47).
 *
 * The Composer renders a drag-active highlight
 * (`data-drag-active="true"`). A useEffect listens for window
 * `blur` / `dragend` / `drop` to clear that state, but not for
 * `keydown`. A user who hits Esc to cancel a stuck drag gesture
 * would otherwise see the highlight linger until they blurred the
 * window or completed a real drop somewhere.
 *
 * The fix wires Esc → `setDragActive(false)`. This contract pins that
 * handler so a future refactor doesn't silently regress it. The
 * onboarding hero used to carry a second copy of this surface; #1433
 * removed it, so the Composer is the only place it can regress.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(process.cwd(), '..', '..');
const COMPOSER_SOURCE = resolve(REPO_ROOT, 'packages', 'ui', 'src', 'composer.tsx');

describe('Esc clears stuck drag-active highlight (PR-COMPOSER-ESC-DRAG-CLEAR-0)', () => {
  it('Composer onTextareaKeyDown handles Esc + dragActive before the streaming branch', async () => {
    const src = await readFile(COMPOSER_SOURCE, 'utf8');
    // Find the keydown handler body.
    const keydown = src.match(/function onTextareaKeyDown\([\s\S]*?\n  \}/);
    assert.ok(keydown, 'onTextareaKeyDown must exist on Composer');
    // Must include an Esc + dragActive → setDragActive(false) branch.
    assert.match(
      keydown[0],
      /event\.key === 'Escape' && dragActive\)[\s\S]*?setDragActive\(false\)/,
      'Composer Esc handler must clear dragActive when the highlight is showing',
    );
  });
});
