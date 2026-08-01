/**
 * The dock rule decides whether a launched Maka can steal the developer's
 * focus. It used to live as an inline branch inside `app.whenReady()`, keyed
 * off a re-derivation of the start-hidden condition (`MAKA_E2E_FIXTURE ||
 * isIsolatedE2e`) that had already drifted from the real one — it missed the
 * `MAKA_E2E_SHOW_WINDOW` escape hatch, so a window a developer explicitly
 * asked to see still launched as an accessory app with no dock tile and no
 * Cmd+Tab entry.
 *
 * The resolver stays a small pure platform rule; integration wiring is covered
 * by the desktop lifecycle rather than source-text assertions.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { resolveDockPresentation } from '../dock-presentation.js';

describe('dock presentation', () => {
  it('maps only macOS window visibility to dock presentation', () => {
    assert.equal(resolveDockPresentation('darwin', true), 'hide');
    assert.equal(resolveDockPresentation('darwin', false), 'icon');
    assert.equal(resolveDockPresentation('win32', true), 'none');
    assert.equal(resolveDockPresentation('linux', false), 'none');
  });
});
