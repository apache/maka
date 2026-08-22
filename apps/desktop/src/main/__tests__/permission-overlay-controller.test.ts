/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Drag-to-grant overlay lifecycle contract.
 *
 * The failure modes this pins are the ones the reference implementations
 * actually shipped: a card that outlives the flow because nothing stops
 * the tracker, and stacked timers when two entry points open the same
 * window. Both are invisible in a happy-path demo and obvious to a user
 * who ends up with an immortal always-on-top card.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  GIVE_UP_MS,
  GRANT_CLOSE_DELAY_MS,
  GRANT_POLL_MS,
  createPermissionOverlayController,
  isDragGrantPermission,
  startScreenRecordingOnboarding,
  type PermissionOverlayDeps,
  type PermissionOverlayWindowLike,
} from '../permission-overlay/permission-overlay-controller.js';
import {
  BUNDLE_ICON_OPTIONS,
  loadNativeBundleIcon,
  resolveAppBundle,
} from '../permission-overlay/app-bundle.js';

/** Deterministic timer wheel — no real time passes in these tests. */
function createClock() {
  let seq = 0;
  const intervals = new Map<number, { fn: () => void; ms: number }>();
  const timeouts = new Map<number, { fn: () => void; ms: number }>();
  return {
    intervals,
    timeouts,
    setInterval(fn: () => void, ms: number) {
      const id = ++seq;
      intervals.set(id, { fn, ms });
      return id as unknown as NodeJS.Timeout;
    },
    clearInterval(handle: NodeJS.Timeout) {
      intervals.delete(handle as unknown as number);
    },
    setTimeout(fn: () => void, ms: number) {
      const id = ++seq;
      timeouts.set(id, { fn, ms });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimeout(handle: NodeJS.Timeout) {
      timeouts.delete(handle as unknown as number);
    },
    /** Fire every registered interval once. */
    tickIntervals() {
      for (const entry of [...intervals.values()]) entry.fn();
    },
    fireTimeoutWithDelay(ms: number) {
      for (const [id, entry] of [...timeouts.entries()]) {
        if (entry.ms !== ms) continue;
        timeouts.delete(id);
        entry.fn();
      }
    },
    pending() {
      return intervals.size + timeouts.size;
    },
  };
}

function createHarness(overrides: Partial<PermissionOverlayDeps> = {}) {
  const clock = createClock();
  interface FakeWindow {
    win: PermissionOverlayWindowLike;
    sent: Array<{ channel: string; payload: unknown }>;
    destroyed: boolean;
    shown: boolean;
    ready(): void;
    gone(): void;
  }
  const windows: FakeWindow[] = [];
  let granted = false;
  const openCalls: string[] = [];
  let openOk = true;

  const deps: PermissionOverlayDeps = {
    platform: 'darwin',
    cardSize: { width: 360, height: 96 },
    getAnchor: () => ({ x: 500, y: 400, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    createWindow: () => {
      // One object throughout: the window methods mutate the same record
      // the test asserts against, so there is no copy to fall out of sync.
      const entry = {
        sent: [] as Array<{ channel: string; payload: unknown }>,
        destroyed: false,
        shown: false,
        ready: () => {},
        gone: () => {},
      } as unknown as FakeWindow;
      entry.win = {
        setBounds: () => {},
        showInactive: () => { entry.shown = true; },
        isDestroyed: () => entry.destroyed,
        destroy: () => { entry.destroyed = true; },
        send: (channel, payload) => entry.sent.push({ channel, payload }),
        onReady: (cb) => { entry.ready = cb; },
        onGone: (cb) => { entry.gone = cb; },
      };
      windows.push(entry);
      return entry.win;
    },
    openSystemSettings: async (id) => {
      openCalls.push(id);
      return openOk ? { ok: true } : { ok: false, message: 'boom' };
    },
    isGranted: () => granted,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    buildCardPayload: (id) => ({ permission: id }),
    ...overrides,
  };

  const controller = createPermissionOverlayController(deps);
  return {
    controller,
    clock,
    windows,
    openCalls,
    grant() { granted = true; },
    failOpen() { openOk = false; },
    isGranted: () => granted,
  };
}

describe('drag-to-grant permission overlay', () => {
  it('requests screen capture before continuing into the drag card', async () => {
    const calls: string[] = [];
    const result = await startScreenRecordingOnboarding({
      requestAccess: async () => { calls.push('request'); return { ok: true }; },
      isGranted: () => false,
      startDrag: async () => { calls.push('drag'); return { ok: true }; },
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, ['request', 'drag']);
  });

  it('only recognises the two drag-to-grant permissions', () => {
    assert.equal(isDragGrantPermission('accessibility'), true);
    assert.equal(isDragGrantPermission('screen_recording'), true);
    // Notifications and Automation have ordinary System Settings rows.
    // None belongs in a drag card.
    assert.equal(isDragGrantPermission('notifications'), false);
    assert.equal(isDragGrantPermission('automation'), false);
    assert.equal(isDragGrantPermission(undefined), false);
  });

  it('opens the settings pane, shows the card inactive, and starts watching', async () => {
    const h = createHarness();
    const result = await h.controller.start('accessibility');

    assert.deepEqual(result, { ok: true });
    assert.deepEqual(h.openCalls, ['accessibility']);
    assert.equal(h.windows.length, 1);

    // Nothing is shown until the page is ready — showing an empty
    // transparent panel first reads as a flash of nothing.
    assert.equal(h.windows[0].shown, false);
    h.windows[0].ready();
    assert.equal(h.windows[0].shown, true);
    assert.deepEqual(h.windows[0].sent[0], {
      channel: 'permission-overlay:show',
      payload: { permission: 'accessibility' },
    });

    assert.equal(h.clock.intervals.size, 1, 'one grant poll');
    assert.equal([...h.clock.intervals.values()][0].ms, GRANT_POLL_MS);
    assert.equal(h.clock.timeouts.size, 1, 'one give-up timer');
    assert.equal([...h.clock.timeouts.values()][0].ms, GIVE_UP_MS);
  });

  it('refuses to stack a second window or a second set of timers', async () => {
    const h = createHarness();
    await h.controller.start('accessibility');
    const afterFirst = h.clock.pending();

    assert.deepEqual(await h.controller.start('accessibility'), { ok: true });
    assert.equal(h.windows.length, 1, 'same permission must reuse the open card');
    assert.equal(h.clock.pending(), afterFirst, 'timers must not stack');

    const other = await h.controller.start('screen_recording');
    assert.deepEqual(other, { ok: false, reason: 'already_open' });
    assert.equal(h.windows.length, 1);
    assert.equal(h.clock.pending(), afterFirst);
  });

  it('closes itself once the permission is granted', async () => {
    const h = createHarness();
    await h.controller.start('accessibility');
    h.windows[0].ready();

    h.clock.tickIntervals();
    assert.equal(h.windows[0].destroyed, false, 'not granted yet — card stays');

    h.grant();
    h.clock.tickIntervals();

    assert.ok(
      h.windows[0].sent.some((m) => m.channel === 'permission-overlay:granted'),
      'the card is told so it can confirm before vanishing',
    );
    assert.equal(h.clock.intervals.size, 0, 'polling stops on grant');
    assert.equal(h.windows[0].destroyed, false, 'close is deferred so the user sees it');

    h.clock.fireTimeoutWithDelay(GRANT_CLOSE_DELAY_MS);
    assert.equal(h.windows[0].destroyed, true);
    assert.equal(h.clock.pending(), 0, 'no timer outlives the card');
    assert.equal(h.controller.isOpen(), false);
  });

  it('gives up rather than leaving an immortal always-on-top card', async () => {
    const h = createHarness();
    await h.controller.start('accessibility');
    h.windows[0].ready();

    h.clock.fireTimeoutWithDelay(GIVE_UP_MS);

    assert.equal(h.windows[0].destroyed, true);
    assert.equal(h.clock.pending(), 0, 'give-up must also stop the poll');
    assert.equal(h.controller.activePermission(), null);
  });

  it('stops every timer when the window disappears on its own', async () => {
    const h = createHarness();
    await h.controller.start('accessibility');
    h.windows[0].ready();

    // Render process gone / user closed it.
    h.windows[0].gone();

    assert.equal(h.clock.pending(), 0, 'a poll tick must not outlive the window');
    assert.equal(h.controller.isOpen(), false);
  });

  it('dismiss() tears everything down and can be called twice', async () => {
    const h = createHarness();
    await h.controller.start('accessibility');
    h.controller.dismiss();
    assert.equal(h.windows[0].destroyed, true);
    assert.equal(h.clock.pending(), 0);
    h.controller.dismiss();
    assert.equal(h.controller.isOpen(), false);
  });

  it('does not open a card for a permission that is already granted', async () => {
    const h = createHarness();
    h.grant();
    const result = await h.controller.start('accessibility');
    assert.deepEqual(result, { ok: true });
    assert.equal(h.windows.length, 0, 'no card');
    assert.deepEqual(h.openCalls, [], 'and no pointless trip to System Settings');
  });

  it('reports a failed settings deep-link instead of floating a useless card', async () => {
    const h = createHarness();
    h.failOpen();
    const result = await h.controller.start('accessibility');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'open_settings_failed');
    assert.equal(h.windows.length, 0);
    assert.equal(h.clock.pending(), 0);
  });

  it('rejects non-macOS and unknown ids before touching the window', async () => {
    const linux = createHarness({ platform: 'linux' });
    assert.deepEqual(await linux.controller.start('accessibility'), {
      ok: false,
      reason: 'unsupported_platform',
    });
    assert.equal(linux.windows.length, 0);

    const mac = createHarness();
    assert.deepEqual(await mac.controller.start('not-a-permission'), { ok: false, reason: 'invalid_id' });
    assert.equal(mac.windows.length, 0);
  });

  it('anchors the card on the cursor, clamped inside the work area', async () => {
    const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
    const h = createHarness({
      // Cursor in the bottom-right corner: the card must not hang off-screen.
      getAnchor: () => ({ x: 1439, y: 899, workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      createWindow: (b) => {
        bounds.push(b);
        return {
          setBounds: () => {}, showInactive: () => {}, isDestroyed: () => false,
          destroy: () => {}, send: () => {}, onReady: () => {}, onGone: () => {},
        };
      },
    });
    await h.controller.start('accessibility');

    const [b] = bounds;
    assert.ok(b.x + b.width <= 1440, `card ran off the right edge: ${JSON.stringify(b)}`);
    assert.ok(b.y + b.height <= 900, `card ran off the bottom edge: ${JSON.stringify(b)}`);
    assert.ok(b.x >= 0 && b.y >= 0);
  });
});

describe('app bundle resolution for the drag', () => {
  it('never calls the native icon loader for an unpackaged app', async () => {
    let calls = 0;
    const icon = await loadNativeBundleIcon(false, async () => {
      calls += 1;
      return 'icon';
    });
    assert.equal(icon, null);
    assert.equal(calls, 0, 'unpackaged development must not call app.getFileIcon()');
    assert.equal(await loadNativeBundleIcon(true, async () => 'icon'), 'icon');
  });

  it('never requests the large icon size that kills packaged macOS builds', () => {
    // 'large' hits a fatal NOTREACHED inside Chromium's IconLoader on
    // macOS (SIGTRAP, not a catchable error) — see issue #3352.
    assert.notEqual(BUNDLE_ICON_OPTIONS.size as string, 'large');
  });

  it('walks three levels up from the executable to the .app', () => {
    assert.deepEqual(
      resolveAppBundle({
        executablePath: '/Applications/Maka.app/Contents/MacOS/Maka',
        platform: 'darwin',
        exists: () => true,
      }),
      { ok: true, bundlePath: '/Applications/Maka.app' },
    );
  });

  it('resolves the containing app bundle independent of its development name', () => {
    assert.deepEqual(
      resolveAppBundle({
        executablePath: '/repo/apps/desktop/.maka-dev/Maka Dev.app/Contents/MacOS/Electron',
        platform: 'darwin',
        exists: () => true,
      }),
      { ok: true, bundlePath: '/repo/apps/desktop/.maka-dev/Maka Dev.app' },
    );
  });

  it('fails explicitly when the walk does not land on a bundle', () => {
    const result = resolveAppBundle({
      executablePath: '/usr/local/bin/maka',
      platform: 'darwin',
      exists: () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'not_a_bundle');
  });

  it('fails when the bundle path does not exist on disk', () => {
    const result = resolveAppBundle({
      executablePath: '/Applications/Maka.app/Contents/MacOS/Maka',
      platform: 'darwin',
      exists: () => false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'not_a_bundle');
  });

  it('fails on non-darwin', () => {
    const result = resolveAppBundle({
      executablePath: 'C:/Program Files/Maka/Maka.exe',
      platform: 'win32',
      exists: () => true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'not_darwin');
  });
});
