/**
 * Contract between the real-window smoke diagnostic (main.ts, injected into
 * the renderer) and the live modal DOM.
 *
 * The diagnostic detects the open search dialog and focus state by
 * querying the renderer. Those selectors silently drifted once the modal
 * migrated across dialog and form-control implementations: the old backdrop
 * hook disappeared and the focused input's implementation class changed, so
 * the `programmatic-search-modal-open` and `programmatic-focus-target` smoke
 * checks failed on a clean tree (reproduced identically on `main`).
 *
 * Astryx uses native `<dialog>` and a `::backdrop`, so there is no backdrop
 * element to select. This gate binds the diagnostic to the product dialog:
 *   - the diagnostic queries `dialog.maka-search-modal[open]`,
 *   - focus-trap is detected structurally via closest('.maka-search-modal'),
 *     not via a brittle class on the focused element.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readMainProcessCombinedSource } from './main-process-contract-source-helpers.js';

describe('real-window smoke diagnostic ↔ modal DOM contract', () => {
  it('the diagnostic queries the open native search dialog', async () => {
    const main = await readMainProcessCombinedSource();
    assert.match(
      main,
      /querySelector\('dialog\.maka-search-modal\[open\]'\)/,
      'the smoke diagnostic must detect the modal through Astryx native dialog state',
    );
    assert.doesNotMatch(
      main,
      /maka-(?:search-modal-)?backdrop/,
      'native ::backdrop has no selectable DOM element, so dead backdrop hooks must stay gone',
    );
  });

  it('the diagnostic reports whether focus is trapped inside the search modal', async () => {
    const main = await readMainProcessCombinedSource();
    assert.match(
      main,
      /activeElementInSearchModal/,
      'the diagnostic must expose `activeElementInSearchModal` so focus-target is checked structurally',
    );
    assert.match(
      main,
      /closest\('\.maka-search-modal'\)/,
      'focus-trap detection must use closest(.maka-search-modal), not a class on the focused element',
    );
  });
});
