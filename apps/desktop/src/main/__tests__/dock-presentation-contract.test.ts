/**
 * The dock rule decides whether a launched Maka can steal the developer's
 * focus. It used to live as an inline branch inside `app.whenReady()`, keyed
 * off a re-derivation of the start-hidden condition (`MAKA_E2E_FIXTURE ||
 * isIsolatedE2e`) that had already drifted from the real one — it missed the
 * `MAKA_E2E_SHOW_WINDOW` escape hatch, so a window a developer explicitly
 * asked to see still launched as an accessory app with no dock tile and no
 * Cmd+Tab entry.
 *
 * Nothing in CI covered it: the only assertion lived in the human-in-the-loop
 * real-window smoke gate, which runs on macOS by hand. These tests exist so
 * the rule cannot regress silently again.
 */

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { resolveDockPresentation } from '../dock-presentation.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

describe('dock presentation', () => {
  it('hides the dock icon whenever the window starts hidden', () => {
    assert.equal(
      resolveDockPresentation('darwin', true),
      'hide',
      'a run that keeps its window hidden must also run as an accessory app; a dock tile that bounces and takes focus defeats the point of hiding the window',
    );
  });

  it('shows the brand mark when the window is visible', () => {
    assert.equal(
      resolveDockPresentation('darwin', false),
      'icon',
      'a visible window needs a dock tile to be reachable via Cmd+Tab, and the dev `npm start` path needs the brand mark rather than the generic Electron icon',
    );
  });

  it('leaves the dock alone off macOS', () => {
    for (const platform of ['win32', 'linux'] as const) {
      assert.equal(
        resolveDockPresentation(platform, true),
        'none',
        `${platform} has no app.dock; the caller must not reach for it`,
      );
      assert.equal(resolveDockPresentation(platform, false), 'none');
    }
  });

  it('is wired to the authoritative startHidden, not a re-derivation', () => {
    // The mapping above is three lines; the regression that motivated this
    // module was in the WIRING — the old inline branch re-derived the
    // start-hidden condition from the environment and drifted from the real
    // one. A pure-function test cannot observe the call site, so the call
    // site is pinned as source shape, the same way the window-reveal
    // contract pins its timer wiring.
    return readFile(
      resolve(REPO_ROOT, 'apps/desktop/src/main/app-lifecycle.ts'),
      'utf8',
    ).then((source) => {
      assert.ok(
        source.includes('resolveDockPresentation(process.platform, startHidden)'),
        'app-lifecycle must feed the resolver the same startHidden that decides window visibility',
      );
    });
  });
});
