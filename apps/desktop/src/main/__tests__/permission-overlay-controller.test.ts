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
  DOCK_LOST_TICKS,
  GIVE_UP_MS,
  GRANT_CLOSE_DELAY_MS,
  GRANT_POLL_MS,
  createPermissionOverlayController,
  isDragGrantPermission,
  type PermissionOverlayDeps,
  type PermissionOverlayWindowLike,
} from '../permission-overlay/permission-overlay-controller.js';
import { resolveAppBundle } from '../permission-overlay/app-bundle.js';

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
    bounds: Array<{ x: number; y: number; width: number; height: number }>;
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
        bounds: [] as Array<{ x: number; y: number; width: number; height: number }>,
        sent: [] as Array<{ channel: string; payload: unknown }>,
        destroyed: false,
        shown: false,
        ready: () => {},
        gone: () => {},
      } as unknown as FakeWindow;
      entry.win = {
        setBounds: (next) => { entry.bounds.push(next); },
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
  it('only recognises the two drag-to-grant permissions', () => {
    assert.equal(isDragGrantPermission('accessibility'), true);
    assert.equal(isDragGrantPermission('screen_recording'), true);
    // Microphone and notifications have real programmatic consent dialogs;
    // routing them through a drag card would be theatre.
    assert.equal(isDragGrantPermission('microphone'), false);
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
    assert.deepEqual(await mac.controller.start('microphone'), { ok: false, reason: 'invalid_id' });
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

  it('resolves Electron.app in dev, which is the correct TCC identity there', () => {
    assert.deepEqual(
      resolveAppBundle({
        executablePath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
        platform: 'darwin',
        exists: () => true,
      }),
      { ok: true, bundlePath: '/repo/node_modules/electron/dist/Electron.app' },
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

describe('docking to the System Settings window', () => {
  /** Drive the async docking tick to completion. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  function dockHarness(frames: Array<{ x: number; y: number; width: number; height: number } | null>) {
    let call = 0;
    const h = createHarness({
      // 1440x900 work area, card 360x96 (see createHarness).
      locateSettingsWindow: async () => {
        const f = frames[Math.min(call++, frames.length - 1)];
        return f ? { ok: true, frame: f } : { ok: false, reason: 'not_running' };
      },
    });
    return h;
  }

  it('docks BELOW the Settings window so the card never covers the drop target', async () => {
    const h = dockHarness([{ x: 400, y: 100, width: 720, height: 600 }]);
    await h.controller.start('accessibility');
    h.windows[0].ready();

    h.clock.tickIntervals();
    await settle();

    const bounds = h.windows[0].bounds.at(-1);
    assert.ok(bounds, 'the card should have been repositioned');
    // Window spans y 100..700; the card must start below it, not over it.
    assert.ok(
      bounds.y >= 700,
      `card must sit below the window's bottom edge (700), got ${bounds.y}`,
    );
    // Centred on the window: 400 + (720-360)/2 = 580.
    assert.equal(bounds.x, 580);
  });

  it('tucks the card inside the lower edge when there is no room below', async () => {
    // Window runs to y=880 on a 900-tall work area; 96px of card will not fit.
    const h = dockHarness([{ x: 400, y: 280, width: 720, height: 600 }]);
    await h.controller.start('accessibility');
    h.windows[0].ready();
    h.clock.tickIntervals();
    await settle();

    const bounds = h.windows[0].bounds.at(-1);
    assert.ok(bounds, 'the card should have been repositioned');
    assert.ok(bounds.y + 96 <= 900, `card ran off the bottom: ${JSON.stringify(bounds)}`);
    assert.ok(bounds.y > 280, 'card should still be near the window, not flung to the top');
  });

  it('only moves the window when the target actually moved', async () => {
    const frame = { x: 400, y: 100, width: 720, height: 600 };
    const h = dockHarness([frame, frame, frame]);
    await h.controller.start('accessibility');
    h.windows[0].ready();

    for (let i = 0; i < 3; i++) { h.clock.tickIntervals(); await settle(); }

    // One placement at start(), and nothing after: repeated identical
    // frames must not re-set bounds and fight a user who is dragging the
    // Settings window.
    assert.equal(h.windows[0].bounds.length, 1, 'repeated identical frames must not re-set bounds');
  });

  it('closes the card once Settings has been gone for several ticks', async () => {
    // start() consumes the first frame for the initial placement, so every
    // tick after this sees `null` — i.e. Settings disappeared after we had
    // definitely seen it.
    const h = dockHarness([{ x: 400, y: 100, width: 720, height: 600 }, null]);
    await h.controller.start('accessibility');
    h.windows[0].ready();

    h.clock.tickIntervals();
    await settle();
    assert.equal(h.windows[0].destroyed, false);

    // A single miss is not enough — Settings may just be busy.
    h.clock.tickIntervals();
    await settle();
    assert.equal(h.windows[0].destroyed, false, 'one miss must not close the card');

    for (let i = 0; i < DOCK_LOST_TICKS; i++) { h.clock.tickIntervals(); await settle(); }
    assert.equal(h.windows[0].destroyed, true, 'a sustained absence means the user closed Settings');
    assert.equal(h.clock.pending(), 0, 'and every timer goes with it');
  });

  it('keeps the cursor anchor when no locator is available', async () => {
    const h = createHarness(); // no locateSettingsWindow
    await h.controller.start('accessibility');
    h.windows[0].ready();
    h.clock.tickIntervals();
    await settle();

    // One placement at the cursor anchor, and no docking tracker at all.
    assert.equal(h.windows[0].bounds.length, 1, 'placed once, at the cursor anchor');
    assert.equal(h.clock.intervals.size, 1, 'only the grant poll — no docking tracker without a locator');
    assert.equal(h.windows[0].destroyed, false, 'and it must not be treated as "Settings gone"');
  });
});

describe('docking across multiple displays', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /**
   * Real geometry from a three-display Mac: the built-in panel is the
   * primary at (0,0), and two externals sit ABOVE it at negative y, one
   * of them at negative x. Negative origins are normal, not exotic.
   */
  const PRIMARY = { x: 0, y: 33, width: 1512, height: 949 };
  const LEFT_ABOVE = { x: -1072, y: -1050, width: 1920, height: 1050 };

  it('clamps to the display holding System Settings, not the one holding the cursor', async () => {
    const bounds: Array<{ x: number; y: number; width: number; height: number }> = [];
    // Settings is on the top-left external; the cursor is on the primary.
    const settings = { x: -800, y: -900, width: 723, height: 837 };

    const h = createHarness({
      cardSize: { width: 530, height: 109 },
      getAnchor: () => ({ x: 700, y: 500, workArea: PRIMARY }),
      workAreaForPoint: (x: number, y: number) =>
        (x < 0 || y < 0 ? LEFT_ABOVE : PRIMARY),
      locateSettingsWindow: async () => ({ ok: true, frame: settings }),
      createWindow: (b) => {
        bounds.push(b);
        return {
          setBounds: (next) => bounds.push(next),
          showInactive: () => {}, isDestroyed: () => false, destroy: () => {},
          send: () => {}, onReady: () => {}, onGone: () => {},
        };
      },
    });

    await h.controller.start('accessibility');
    h.clock.tickIntervals();
    await settle();

    const docked = bounds.at(-1);
    assert.ok(docked, 'the card should have been docked');
    // Centred under Settings: -800 + (723-530)/2 = -703.5 -> -704/-703.
    assert.ok(
      docked.x < 0,
      `card must stay on the display holding Settings (expected ~-703, got x=${docked.x}). `
      + 'Clamping to the cursor display drags it onto another monitor.',
    );
    assert.ok(
      docked.y < 0,
      `card must sit below Settings on that display (expected ~-55, got y=${docked.y})`,
    );
  });
});

describe('docking failures must not kill the card', () => {
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('survives a locator that can never work (missing binary)', async () => {
    // What production actually produces in a packaged build: the dep IS
    // supplied, and it fails every time. The card must stay on its cursor
    // anchor, not conclude the user closed System Settings.
    const h = createHarness({
      locateSettingsWindow: async () => ({ ok: false, reason: 'binary_missing' }),
    });
    await h.controller.start('accessibility');
    h.windows[0].ready();

    for (let i = 0; i < DOCK_LOST_TICKS + 3; i++) { h.clock.tickIntervals(); await settle(); }

    assert.equal(
      h.windows[0].destroyed, false,
      'a locator that cannot run means "cannot dock", not "Settings went away"',
    );
    assert.equal(h.controller.isOpen(), true);
  });

  it('gives System Settings time to appear before counting it missing', async () => {
    // `openSystemSettings` resolves when the deep link is handed off, not
    // when the window exists. A cold launch easily exceeds 5 ticks (1s).
    let calls = 0;
    const h = createHarness({
      locateSettingsWindow: async () => {
        calls += 1;
        return calls > 8
          ? { ok: true, frame: { x: 400, y: 100, width: 720, height: 600 } }
          : { ok: false, reason: 'not_running' };
      },
    });
    await h.controller.start('accessibility');
    h.windows[0].ready();

    for (let i = 0; i < 8; i++) { h.clock.tickIntervals(); await settle(); }
    assert.equal(
      h.windows[0].destroyed, false,
      'the card must not give up before Settings has ever appeared',
    );

    h.clock.tickIntervals(); await settle();
    assert.ok(h.windows[0].bounds.length > 0, 'and it should dock once Settings shows up');
  });
});
