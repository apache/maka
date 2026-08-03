// Behavior contract for the Computer Use picture-in-picture mirror. Driven
// against a fake window (no Electron), asserting the properties that make it
// the answer to occlusion rather than another thing competing for the screen:
//  - it mirrors frames the action already produced, never captures its own
//  - it never takes focus, and never accepts a click
//  - the cursor is placed in capture pixels, scaled through the window
//  - it belongs to one session and dies with it
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createComputerUsePipController,
  pipBoundsForAnchor,
  pipDisplaySize,
  pipWindowOptions,
  withComputerUsePip,
} from '../computer-use/pip-window.js';

class FakeWindow {
  sent: Array<{ channel: string; payload: any }> = [];
  bounds: any = { x: 0, y: 0, width: 200, height: 125 };
  shown = false;
  destroyed = false;
  ignoringMouse = true;
  private readyCb: (() => void) | null = null;
  private goneCb: (() => void) | null = null;
  private loadFailureCb: ((reason: string) => void) | null = null;
  private messageCb: ((channel: string, payload: unknown) => void) | null = null;
  /** Every setBounds, so a test can tell "did not move" from "moved back". */
  moves: any[] = [];
  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }
  onReady(cb: () => void): void {
    this.readyCb = cb;
  }
  onGone(cb: () => void): void {
    this.goneCb = cb;
  }
  onLoadFailure(cb: (reason: string) => void): void {
    this.loadFailureCb = cb;
  }
  onMessage(cb: (channel: string, payload: unknown) => void): void {
    this.messageCb = cb;
  }
  setBounds(bounds: any): void {
    this.bounds = bounds;
    this.moves.push(bounds);
  }
  getBounds(): any {
    return this.bounds;
  }
  showInactive(): void {
    this.shown = true;
  }
  setIgnoreMouseEvents(ignore: boolean): void {
    this.ignoringMouse = ignore;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  destroy(): void {
    this.destroyed = true;
  }
  fireReady(): void {
    this.readyCb?.();
  }
  fireGone(): void {
    this.goneCb?.();
  }
  fireLoadFailure(reason = 'ERR_FILE_NOT_FOUND (-6)'): void {
    this.loadFailureCb?.(reason);
  }
  fireMessage(channel: string, payload?: unknown): void {
    this.messageCb?.(channel, payload);
  }
}

/**
 * A display for the controller to position against. The mirror now owns where
 * it sits — it re-seats itself on a reshape and settles onto a corner after a
 * throw — so a test that gives it no display is asking it to work blind.
 */
const WORK_AREA = { x: 0, y: 0, width: 1600, height: 1000 };

function makePip(extra: Record<string, unknown> = {}) {
  const windows: FakeWindow[] = [];
  const pip = createComputerUsePipController({
    createWindow: () => {
      const w = new FakeWindow();
      windows.push(w);
      return w as never;
    },
    resolveBounds: (aspect) => ({ x: 0, y: 0, width: Math.round(400 * aspect), height: 400 }),
    workAreaFor: () => WORK_AREA,
    preloadPath: '/fake/pip-preload.cjs',
    htmlPath: '/fake/pip.html',
    ...extra,
  });
  return { pip, windows };
}

const FRAME = {
  base64: 'AAAA',
  mimeType: 'image/png' as const,
  widthPx: 1000,
  heightPx: 800,
};

function framesOf(w: FakeWindow | undefined) {
  return (w?.sent ?? []).filter((m) => m.channel === 'pip:frame');
}
function cursorsOf(w: FakeWindow | undefined) {
  return (w?.sent ?? []).filter((m) => m.channel === 'pip:cursor');
}

test('Computer Use picture-in-picture mirror', async (t) => {
  await t.test('never takes focus and never accepts a click', () => {
    // It reports on work happening elsewhere. Taking focus would interrupt the
    // very thing it exists to describe.
    const options = pipWindowOptions({ x: 0, y: 0, width: 400, height: 300 }, '/p.cjs');
    assert.equal(options.focusable, false);
    assert.equal(options.acceptFirstMouse, false);
    assert.equal(options.show, false, 'shown only via showInactive once loaded');
    assert.equal(options.skipTaskbar, true);
    assert.equal(options.webPreferences?.contextIsolation, true);
    assert.equal(options.webPreferences?.nodeIntegration, false);
    assert.equal(options.webPreferences?.sandbox, true);
  });

  await t.test('attaches to the app window rather than floating above every app', () => {
    // Codex's `RemoteHostedPIPContentCreateStackPanel` sets `setLevel: 0` —
    // plain NSNormalWindowLevel — and attaches the panel to its owner with
    // `addChildWindow:ordered:`. A child window is ordered against its parent,
    // so it sits above the app it belongs to and below everything else. The
    // mirror used to pass `alwaysOnTop` with no level, which defaults to
    // `floating` and put it above unrelated apps.
    const parent = { isDestroyed: () => false };
    const attached = pipWindowOptions({ x: 0, y: 0, width: 200, height: 125 }, '/p.cjs', parent);
    assert.equal(attached.parent, parent as never, 'parented to the app window');
    assert.equal(attached.alwaysOnTop, undefined, 'and therefore claims no level of its own');

    // With no app window there is nothing to sit above, so the mirror has to
    // claim a level or be buried. Codex's own fallbackAnchor path.
    const detached = pipWindowOptions({ x: 0, y: 0, width: 200, height: 125 }, '/p.cjs');
    assert.equal(detached.parent, undefined);
    assert.equal(detached.alwaysOnTop, true);

    // Codex's `setHasShadow: NO`. pip.html draws its own; the native one would
    // be a second shadow, recomputed from the content's alpha on every frame.
    assert.equal(attached.hasShadow, false);
  });

  await t.test('sizes the mirror the way Codex does', () => {
    // Recovered from Codex: default longest edge 200pt, clamped to [100, 400],
    // shorter edge scaled to preserve aspect, non-finite falling back to the
    // default. This was 420 on a guess — above Codex's hard ceiling, and about
    // 4.4x the area of its default.
    assert.deepEqual(pipDisplaySize(16 / 10), { width: 200, height: 125 });
    assert.deepEqual(pipDisplaySize(1), { width: 200, height: 200 });
    assert.deepEqual(pipDisplaySize(0.5), { width: 100, height: 200 }, 'tall windows too');

    // The longest edge lands exactly on the requested edge, both orientations.
    assert.equal(pipDisplaySize(2, 300).width, 300);
    assert.equal(pipDisplaySize(0.5, 300).height, 300);

    // Clamped at both ends, and never NaN.
    assert.equal(pipDisplaySize(1, 5).width, 100, 'floor');
    assert.equal(pipDisplaySize(1, 9999).width, 400, 'ceiling');
    assert.deepEqual(pipDisplaySize(Number.NaN), { width: 200, height: 200 });
    assert.deepEqual(pipDisplaySize(1, Number.POSITIVE_INFINITY), { width: 200, height: 200 });

    // No zero-height mirror for an absurd aspect.
    assert.ok(pipDisplaySize(500).height >= 1);
  });

  await t.test('anchors to the app window, not to a screen corner', () => {
    // Codex anchors its tiles 24pt inside its own window's rect and moves them
    // with it. Pinning to a display corner leaves the mirror behind the moment
    // the user drags the app to another screen — which is exactly how an
    // unexplained window ends up on someone's second monitor.
    const work = { x: 0, y: 0, width: 1920, height: 1080 };
    const app = { x: 400, y: 200, width: 900, height: 600 };
    const bounds = pipBoundsForAnchor(16 / 10, app, work);
    assert.equal(bounds.width, 200);
    assert.equal(bounds.height, 125);
    // Bottom-right of the app window, inset by Codex's 24pt.
    assert.equal(bounds.x, 400 + 900 - 200 - 24);
    assert.equal(bounds.y, 200 + 600 - 125 - 24);
  });

  await t.test('falls back to the work area when there is no app window', () => {
    const work = { x: 0, y: 0, width: 1440, height: 900 };
    const bounds = pipBoundsForAnchor(1, undefined, work);
    assert.equal(bounds.x, 1440 - 200 - 24);
    assert.equal(bounds.y, 900 - 200 - 24);
  });

  await t.test('never places the mirror outside the display it belongs to', () => {
    // An app window flush against a screen edge would otherwise push the
    // mirror off that screen, or onto the neighbouring one.
    const work = { x: 0, y: 0, width: 1440, height: 900 };
    const flushRight = { x: 1200, y: 700, width: 400, height: 300 };
    const bounds = pipBoundsForAnchor(1, flushRight, work);
    assert.ok(bounds.x + bounds.width <= work.x + work.width, 'inside on the right');
    assert.ok(bounds.y + bounds.height <= work.y + work.height, 'inside at the bottom');

    const offLeft = { x: -600, y: -400, width: 500, height: 300 };
    const clamped = pipBoundsForAnchor(1, offLeft, work);
    assert.ok(clamped.x >= work.x, 'inside on the left');
    assert.ok(clamped.y >= work.y, 'inside at the top');
  });

  await t.test('lets the window server carry the mirror, and only reacts to resizes', () => {
    // Measured on Electron 43: a child window follows its parent's *move*
    // inside the same window-server transaction, and does not move when the
    // parent *resizes*. So repositioning on a move is redundant and a frame
    // late — that lateness is the trailing the mirror showed during a drag —
    // while a resize genuinely moves the corner out from under it.
    const changes: Array<() => void> = [];
    const windows: FakeWindow[] = [];
    let appRect = { x: 0, y: 0, width: 800, height: 600 };
    const pip = createComputerUsePipController({
      createWindow: () => {
        const w = new FakeWindow();
        windows.push(w);
        return w as never;
      },
      resolveAnchorRect: () => appRect,
      resolveParentWindow: () => ({ isDestroyed: () => false }),
      subscribeAnchorChanges: (cb) => {
        changes.push(cb);
        return () => {};
      },
      resolveBounds: (aspect) =>
        pipBoundsForAnchor(aspect, appRect, { x: 0, y: 0, width: 3000, height: 2000 }),
      workAreaFor: () => ({ x: 0, y: 0, width: 3000, height: 2000 }),
      preloadPath: '/p.cjs',
      htmlPath: '/p.html',
    });
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    windows[0]!.moves.length = 0;

    // A drag: the origin moves, the size does not.
    appRect = { x: 1000, y: 500, width: 800, height: 600 };
    for (const cb of changes) cb();
    assert.deepEqual(windows[0]!.moves, [], 'a move is left to the window server');

    // A resize: the corner the mirror hangs off has moved relative to it.
    appRect = { x: 1000, y: 500, width: 1200, height: 900 };
    for (const cb of changes) cb();
    assert.equal(windows[0]!.moves.length, 1, 'a resize is recomputed');
    assert.deepEqual(
      windows[0]!.moves[0],
      pipBoundsForAnchor(FRAME.widthPx / FRAME.heightPx, appRect, {
        x: 0,
        y: 0,
        width: 3000,
        height: 2000,
      }),
      'and it lands back on the corner it was resting on',
    );
  });

  await t.test('with no app window to attach to, the mirror moves itself', () => {
    // Nothing is carrying it, so every geometry change has to be acted on.
    const changes: Array<() => void> = [];
    const windows: FakeWindow[] = [];
    let appRect = { x: 0, y: 0, width: 800, height: 600 };
    const pip = createComputerUsePipController({
      createWindow: () => {
        const w = new FakeWindow();
        windows.push(w);
        return w as never;
      },
      resolveAnchorRect: () => appRect,
      subscribeAnchorChanges: (cb) => {
        changes.push(cb);
        return () => {};
      },
      resolveBounds: (aspect) =>
        pipBoundsForAnchor(aspect, appRect, { x: 0, y: 0, width: 3000, height: 2000 }),
      workAreaFor: () => ({ x: 0, y: 0, width: 3000, height: 2000 }),
      preloadPath: '/p.cjs',
      htmlPath: '/p.html',
    });
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    windows[0]!.moves.length = 0;

    appRect = { x: 1000, y: 500, width: 800, height: 600 };
    for (const cb of changes) cb();
    assert.equal(windows[0]!.moves.length, 1, 'the mirror moved with the app');
  });

  await t.test('a destroyed app window is not used as a parent', () => {
    // The window can go while a session is still running. Passing a dead
    // BrowserWindow to `parent` throws inside Electron, and the mirror must
    // fail to the level it would have used had there never been a window.
    const seen: Array<{ parent?: unknown; alwaysOnTop?: boolean }> = [];
    const windows: FakeWindow[] = [];
    const pip = createComputerUsePipController({
      createWindow: (options) => {
        seen.push(options);
        const w = new FakeWindow();
        windows.push(w);
        return w as never;
      },
      resolveParentWindow: () => ({ isDestroyed: () => true }),
      resolveBounds: () => ({ x: 0, y: 0, width: 200, height: 125 }),
      workAreaFor: () => WORK_AREA,
      preloadPath: '/p.cjs',
      htmlPath: '/p.html',
    });
    pip.present({ sessionId: 's1', ...FRAME });
    assert.equal(seen[0]?.parent, undefined);
    assert.equal(seen[0]?.alwaysOnTop, true);
  });

  await t.test('the mirror is click-through until the pointer is on it', () => {
    // Hover is decided here, from the pointer, the way Codex decides it with a
    // global NSEvent monitor rather than by asking its window. The first
    // version let the page decide from forwarded mouse moves, and those drop —
    // five injected moves arrived as two on a real machine.
    let cursor = { x: 0, y: 0 };
    const ticks: Array<() => void> = [];
    const { pip, windows } = makePip({
      cursorPoint: () => cursor,
      scheduleHoverCheck: (cb: () => void) => {
        ticks.push(cb);
        return () => {};
      },
      resolveBounds: () => ({ x: 100, y: 100, width: 200, height: 125 }),
    });
    pip.present({ sessionId: 's1', ...FRAME });
    const w = windows[0]!;
    w.setBounds({ x: 100, y: 100, width: 200, height: 125 });
    w.fireReady();
    const poll = () => {
      const next = ticks.shift();
      if (next) next();
    };

    assert.equal(w.ignoringMouse, true, 'transparent to clicks at rest');
    poll();
    assert.equal(w.ignoringMouse, true, 'and while the pointer is elsewhere');

    cursor = { x: 150, y: 150 };
    poll();
    assert.equal(w.ignoringMouse, false, 'takes the pointer while it is on the mirror');
    assert.deepEqual(
      w.sent.filter((m) => m.channel === 'pip:controls').at(-1)?.payload,
      { visible: true },
      'and the controls appear with it',
    );

    cursor = { x: 900, y: 900 };
    poll();
    assert.equal(w.ignoringMouse, true, 'and gives it straight back');
    assert.deepEqual(
      w.sent.filter((m) => m.channel === 'pip:controls').at(-1)?.payload,
      { visible: false },
    );
  });

  await t.test('a drag keeps the pointer, wherever the spring has got to', () => {
    // The mirror trails the cursor by design, so mid-drag the pointer is often
    // outside its bounds. Reading that as "the user left" would hand the clicks
    // back in the middle of the gesture that needs them.
    let cursor = { x: 150, y: 150 };
    const ticks: Array<() => void> = [];
    const { pip, windows } = makePip({
      cursorPoint: () => cursor,
      scheduleHoverCheck: (cb: () => void) => {
        ticks.push(cb);
        return () => {};
      },
      scheduleFrame: () => () => {},
      resolveBounds: () => ({ x: 100, y: 100, width: 200, height: 125 }),
    });
    pip.present({ sessionId: 's1', ...FRAME });
    const w = windows[0]!;
    w.setBounds({ x: 100, y: 100, width: 200, height: 125 });
    w.fireReady();
    const poll = () => {
      const next = ticks.shift();
      if (next) next();
    };
    poll();
    assert.equal(w.ignoringMouse, false, 'hovered before the press');

    w.fireMessage('pip:pointer-down');
    cursor = { x: 900, y: 900 };
    poll();
    assert.equal(w.ignoringMouse, false, 'still holding it mid-drag');

    w.fireMessage('pip:pointer-up');
    poll();
    assert.equal(w.ignoringMouse, true, 'and released once the drag ends');
  });

  await t.test('a drag moves the mirror, and a release settles it on a corner', () => {
    // The whole interaction, end to end: press, drag across the window, throw
    // it right, and watch the settling spring carry it to the corner the throw
    // was aimed at.
    let cursor = { x: 500, y: 500 };
    let clock = 0;
    const frames: Array<() => void> = [];
    const { pip, windows } = makePip({
      resolveAnchorRect: () => ({ x: 0, y: 0, width: 1600, height: 1000 }),
      resolveParentWindow: () => ({ isDestroyed: () => false }),
      resolveBounds: () => ({ x: 400, y: 800, width: 200, height: 125 }),
      cursorPoint: () => cursor,
      now: () => clock,
      scheduleFrame: (cb: () => void) => {
        frames.push(cb);
        return () => {};
      },
    });
    pip.present({ sessionId: 's1', ...FRAME });
    const w = windows[0]!;
    w.fireReady();
    const runFrames = (count: number) => {
      for (let i = 0; i < count; i++) {
        const next = frames.shift();
        if (!next) return;
        clock += 16;
        next();
      }
    };

    assert.equal(pip.currentAlignment(), 'bottom-right', 'starts where it was placed');

    // Press on the mirror's own top-left corner, wherever the controller has
    // actually seated it, so the grab offset is zero and the drag is readable.
    const seated = w.getBounds();
    cursor = { x: seated.x, y: seated.y };
    w.fireMessage('pip:pointer-down');
    w.moves.length = 0;

    // Drag it up and to the left, fast enough that the release is a throw.
    cursor = { x: 200, y: 200 };
    clock += 16;
    w.fireMessage('pip:pointer-move');
    runFrames(30);
    assert.ok(w.moves.length > 0, 'the mirror follows the pointer');
    assert.ok(w.moves.at(-1)!.x < seated.x, 'leftward');
    assert.ok(w.moves.at(-1)!.y < seated.y, 'and upward');

    clock += 16;
    w.fireMessage('pip:pointer-up');
    runFrames(400);
    assert.equal(pip.currentAlignment(), 'top-left', 'thrown up and left, it lands there');
    assert.deepEqual(
      { x: w.moves.at(-1)!.x, y: w.moves.at(-1)!.y },
      { x: 24, y: 24 },
      'and comes to rest exactly on the anchor',
    );
  });

  await t.test('a resize brings the mirror back to the corner the user chose', () => {
    // Not to the default corner. Someone put it in the top-left on purpose,
    // and resizing the app window is not them changing their mind.
    let cursor = { x: 0, y: 0 };
    let clock = 0;
    const frames: Array<() => void> = [];
    const changes: Array<() => void> = [];
    let appRect = { x: 0, y: 0, width: 1600, height: 1000 };
    const { pip, windows } = makePip({
      resolveAnchorRect: () => appRect,
      resolveParentWindow: () => ({ isDestroyed: () => false }),
      subscribeAnchorChanges: (cb: () => void) => {
        changes.push(cb);
        return () => {};
      },
      resolveBounds: () => ({ x: 1376, y: 851, width: 200, height: 125 }),
      cursorPoint: () => cursor,
      now: () => clock,
      scheduleFrame: (cb: () => void) => {
        frames.push(cb);
        return () => {};
      },
    });
    pip.present({ sessionId: 's1', ...FRAME });
    const w = windows[0]!;
    w.fireReady();

    cursor = { x: w.getBounds().x, y: w.getBounds().y };
    w.fireMessage('pip:pointer-down');
    cursor = { x: 100, y: 100 };
    clock += 16;
    w.fireMessage('pip:pointer-move');
    clock += 16;
    w.fireMessage('pip:pointer-up');
    for (let i = 0; i < 400; i++) {
      const next = frames.shift();
      if (!next) break;
      clock += 16;
      next();
    }
    assert.equal(pip.currentAlignment(), 'top-left');

    w.moves.length = 0;
    appRect = { x: 0, y: 0, width: 1200, height: 800 };
    for (const cb of changes) cb();
    assert.deepEqual(
      { x: w.moves.at(-1)!.x, y: w.moves.at(-1)!.y },
      { x: 24, y: 24 },
      'still the top-left, against the new rect',
    );
  });

  await t.test('the stop control runs the same stop the menu bar does', () => {
    const stopped: string[] = [];
    const { pip, windows } = makePip();
    pip.setStopHandler((id) => stopped.push(id));
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();

    windows[0]!.fireMessage('pip:control', { id: 'stop' });
    assert.deepEqual(stopped, ['s1']);
    assert.equal(pip.isVisible(), true, 'stopping the run does not close the mirror');
  });

  await t.test('hide dismisses the mirror for this run, and only this run', () => {
    // Codex has `hide` and `close`; with one tile they are the same gesture.
    // Dismissing is a statement about this run — the next one gets a mirror.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();

    windows[0]!.fireMessage('pip:control', { id: 'hide' });
    assert.equal(pip.isVisible(), false);

    pip.present({ sessionId: 's1', ...FRAME });
    assert.equal(pip.isVisible(), false, 'and stays dismissed for the rest of the run');

    pip.present({ sessionId: 's2', ...FRAME });
    assert.equal(pip.isVisible(), true, 'a different session is a fresh decision');
  });

  await t.test('a follow-up turn in the same session gets its mirror back', () => {
    // A run is a turn. `session-stream` calls `complete` at every turn end,
    // next to the overlay and tool-session clears, and a dismissal expires with
    // them.
    //
    // Scoped to the session instead, this is the shape of it: the user hides
    // the mirror during turn one, asks a follow-up, and turn two drives another
    // app for minutes with nothing on screen and no control to bring it back —
    // stop, archive and delete are the only things that clear the flag, and all
    // three end the thing they wanted to keep watching. Re-hiding costs one
    // click; not being able to un-hide costs the whole point of the mirror.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();

    windows[0]!.fireMessage('pip:control', { id: 'hide' });
    assert.equal(pip.isVisible(), false);
    assert.equal(windows.length, 1);

    // The turn ends while the mirror is dismissed, so there is no window for
    // `complete` to mark — the dismissal still has to expire.
    pip.complete('s1');

    pip.present({ sessionId: 's1', ...FRAME });
    assert.equal(pip.isVisible(), true, 'the next turn is a fresh decision');
    assert.equal(windows.length, 2, 'and it is a real window, not a stale handle');
  });

  await t.test('a dismissal does not survive into a mirror it was not aimed at', () => {
    // `complete` for some other session must leave this run dismissed;
    // otherwise a second session finishing un-hides the one the user is
    // watching.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    windows[0]!.fireMessage('pip:control', { id: 'hide' });

    pip.complete('other-session');
    pip.present({ sessionId: 's1', ...FRAME });
    assert.equal(pip.isVisible(), false, 'someone else finishing is not this run ending');
  });

  await t.test('a finished run is retired once the linger elapses', (t) => {
    // The linger only ever got asserted as "not destroyed synchronously",
    // which is also true of a timer that never fires, of a body that does
    // nothing, and of a zero-length linger. The first two leave the mirror on
    // screen forever and the third takes it away at the moment a person looks
    // over, which is the whole reason the linger exists. Run the clock, and
    // pin both sides of it.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();

    pip.complete('s1');
    assert.equal(pip.isVisible(), true, 'not taken away at the moment the answer lands');

    t.mock.timers.tick(29_999);
    assert.equal(pip.isVisible(), true, 'still there a moment before the linger is up');

    t.mock.timers.tick(1);
    assert.equal(pip.isVisible(), false, 'and gone once it is');
    assert.equal(windows[0]!.isDestroyed(), true);
  });

  await t.test('a run that resumes keeps the mirror the linger was going to take', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();

    pip.complete('s1');
    t.mock.timers.tick(20_000);
    pip.present({ sessionId: 's1', ...FRAME });
    t.mock.timers.tick(30_000);

    assert.equal(pip.isVisible(), true, 'a frame cancels the retirement, it does not delay it');
    assert.equal(windows.length, 1, 'and does so without rebuilding the window');
  });

  await t.test('an unknown control identifier does nothing', () => {
    const stopped: string[] = [];
    const { pip, windows } = makePip();
    pip.setStopHandler((id) => stopped.push(id));
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    windows[0]!.fireMessage('pip:control', { id: 'launch-the-missiles' });
    windows[0]!.fireMessage('pip:control', {});
    assert.deepEqual(stopped, []);
    assert.equal(pip.isVisible(), true);
  });

  await t.test('a stale window cannot drive the live one', () => {
    // The mirror is rebuilt per session. A message arriving late from the
    // window that just went away must not move the one that replaced it.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.present({ sessionId: 's2', ...FRAME });
    windows[1]!.fireReady();
    windows[1]!.moves.length = 0;

    windows[0]!.fireMessage('pip:hover', { inside: true });
    windows[0]!.fireMessage('pip:control', { id: 'hide' });
    assert.equal(pip.isVisible(), true, 'the live mirror is untouched');
    assert.equal(windows[1]!.ignoringMouse, true);
  });

  await t.test('stays absent until a frame arrives', () => {
    const { pip, windows } = makePip();
    assert.equal(pip.isVisible(), false);
    assert.equal(windows.length, 0);
  });

  await t.test('a frameless result opens nothing', () => {
    // Not every action returns a screenshot. An empty mirror is worse than none.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', base64: '', mimeType: 'image/png', widthPx: 0, heightPx: 0 });
    assert.equal(windows.length, 0);
  });

  await t.test('opens on the first frame and shows it only once loaded', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME, title: 'Codex CUA Lab' });
    const w = windows[0]!;
    assert.equal(pip.isVisible(), true);
    assert.equal(w.shown, false, 'nothing is shown before the page loads');
    assert.equal(framesOf(w).length, 0, 'queued, not sent');
    w.fireReady();
    assert.equal(w.shown, true);
    assert.equal(framesOf(w).length, 1);
    assert.match(framesOf(w)[0]!.payload.src, /^data:image\/png;base64,/);
    // The title rides along for future use but is not rendered: Codex's tiles
    // have no chrome at any size.
    assert.equal(framesOf(w)[0]!.payload.title, 'Codex CUA Lab');
  });

  await t.test('queues only the newest frame while loading', () => {
    // Actions can outrun a loading page. Holding every base64 frame that
    // arrives in the meantime is a real memory cost for no benefit — the
    // mirror only ever displays the latest.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    pip.present({ sessionId: 's1', ...FRAME, base64: 'BBBB' });
    pip.present({ sessionId: 's1', ...FRAME, base64: 'CCCC' });
    const w = windows[0]!;
    w.fireReady();
    const frames = framesOf(w);
    assert.equal(frames.length, 1);
    assert.match(frames[0]!.payload.src, /CCCC$/);
  });

  await t.test('reuses one window across a session', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.present({ sessionId: 's1', ...FRAME, base64: 'BBBB' });
    assert.equal(windows.length, 1);
    assert.equal(framesOf(windows[0]).length, 2);
  });

  await t.test('a finished run keeps its mirror instead of taking it away', () => {
    // Destroying it the instant the turn ends removes the final state at the
    // moment a person looks over — they were watching background work because
    // they could not see the window, and the answer arriving is when they look.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.complete('s1');
    assert.equal(windows[0]!.destroyed, false, 'the mirror is still there to look at');
    assert.ok(
      windows[0]!.sent.some((message) => message.channel === 'pip:completed'),
      'and it says the picture has stopped changing',
    );
  });

  await t.test('a new frame cancels a pending retirement', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.complete('s1');
    pip.present({ sessionId: 's1', ...FRAME });
    assert.equal(windows.length, 1, 'the same mirror, not a replacement');
    assert.equal(windows[0]!.destroyed, false);
  });

  await t.test('stopping still takes the mirror away at once', () => {
    // Lingering is for a run that ended on its own. A user who stopped it has
    // said they are done.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.clearForSession('s1');
    assert.equal(windows[0]!.destroyed, true);
  });

  await t.test('a different session supersedes the mirror', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.present({ sessionId: 's2', ...FRAME });
    assert.equal(windows.length, 2);
    assert.equal(windows[0]!.destroyed, true, 'no orphan mirror survives');
    assert.equal(pip.currentSessionId(), 's2');
  });

  await t.test('places the cursor in capture pixels', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.setCursor({ sessionId: 's1', x: 250, y: 400 });
    const last = cursorsOf(windows[0]).at(-1)!;
    assert.deepEqual(last.payload, { x: 250, y: 400 });
  });

  await t.test('hides the cursor when there is no point to show', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.setCursor({ sessionId: 's1' });
    assert.deepEqual(cursorsOf(windows[0]).at(-1)!.payload, { hidden: true });
  });

  await t.test('ignores a cursor update for another session', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.setCursor({ sessionId: 'other', x: 1, y: 1 });
    assert.equal(cursorsOf(windows[0]).length, 0);
  });

  await t.test('closes with its own session and ignores others', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    pip.clearForSession('s2');
    assert.equal(pip.isVisible(), true);
    pip.clearForSession('s1');
    assert.equal(pip.isVisible(), false);
    assert.equal(windows[0]!.destroyed, true);
  });

  await t.test('a window closed from outside is not resurrected', () => {
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    windows[0]!.fireReady();
    windows[0]!.fireGone();
    assert.equal(pip.isVisible(), false);
    assert.equal(pip.currentSessionId(), null);
  });

  await t.test('a page that fails to load is destroyed, not left invisible', () => {
    // `showInactive` and the hover watch both live behind `onReady`, which a
    // failed load never fires. Left alone, the window is invisible, has no
    // controls, is never torn down, and quietly accumulates queued frames --
    // one per session, indistinguishable from a mirror that is working. A
    // missing dist/overlay/pip.html is enough to produce it.
    const { pip, windows } = makePip();
    pip.present({ sessionId: 's1', ...FRAME });
    const failed = windows[0]!;
    assert.equal(failed.shown, false, 'nothing is shown before the page loads');

    failed.fireLoadFailure();

    assert.equal(failed.destroyed, true, 'the window must not leak');
    assert.equal(pip.isVisible(), false);
    assert.equal(pip.currentSessionId(), null);

    // And the next frame gets a fresh window rather than feeding the dead one.
    pip.present({ sessionId: 's1', ...FRAME });
    assert.equal(windows.length, 2);
    assert.equal(windows[1]!.destroyed, false);
  });

  await t.test('rests against the app window\'s display, not the mirror\'s', () => {
    // The anchors are corners of the app window, so they are expressed in that
    // window's display's coordinates. Clamping them into the work area of
    // whichever display the mirror currently sits on mixes two coordinate
    // spaces: with the app on an external display and the mirror still on the
    // built-in one, the corner computed on the external screen was clamped to
    // the built-in screen's right edge and the mirror parked there.
    const BUILT_IN = { x: 0, y: 0, width: 1600, height: 1000 };
    const EXTERNAL = { x: 1600, y: 0, width: 1920, height: 1080 };
    const appWindow = { x: 1700, y: 100, width: 1000, height: 700 };
    const { pip, windows } = makePip({
      resolveAnchorRect: () => appWindow,
      // The mirror's own bounds start on the built-in display; the app is on
      // the external one.
      workAreaFor: (rect: { x: number }) => (rect.x >= EXTERNAL.x ? EXTERNAL : BUILT_IN),
    });

    // A frame whose aspect differs from the default re-seats the mirror, which
    // is the path that asks for a rest position.
    pip.present({ sessionId: 's1', ...FRAME, widthPx: 1000, heightPx: 800 });
    const w = windows[0]!;
    const landed = w.moves[w.moves.length - 1]!;
    assert.equal(
      landed.x,
      appWindow.x + appWindow.width - landed.width - 24,
      'inset 24pt from the app window, in the app window\'s own space',
    );
    assert.ok(
      landed.x >= EXTERNAL.x && landed.x + landed.width <= EXTERNAL.x + EXTERNAL.width,
      'and therefore on the display the app is on',
    );
  });
});

test('picture-in-picture wiring into the overlay hook', async (t) => {
  function sink() {
    const calls: Array<{ m: string; a: any }> = [];
    return {
      calls,
      pip: {
        present: (i: unknown) => calls.push({ m: 'present', a: i }),
        setCursor: (i: unknown) => calls.push({ m: 'setCursor', a: i }),
        clearForSession: () => {},
        destroyAll: () => {},
        isVisible: () => false,
        currentSessionId: () => null,
      },
    };
  }

  await t.test('mirrors the frame the action already produced', () => {
    // Load-bearing: no second capture. The screenshot a mutating action returns
    // was taken after the settle wait, so it already shows the settled result.
    const { calls, pip } = sink();
    let inner = 0;
    const hook = { onActionBegin: () => undefined, onActionEnd: () => void (inner += 1) };
    const wrapped = withComputerUsePip(hook as never, pip as never) as any;
    wrapped.onActionEnd({ type: 'left_click' }, {
      screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 1000, heightPx: 800 },
      resolvedScreenPoint: { x: 700, y: 300 },
      observation: { windowTitle: 'Lab', windowBounds: { x: 500, y: 100, width: 500, height: 400 } },
    }, { sessionId: 's1', toolCallId: 't1' });

    assert.equal(inner, 1, 'the underlying cursor hook still runs');
    const present = calls.find((c) => c.m === 'present')!;
    assert.equal(present.a.base64, 'AAAA');
    assert.equal(present.a.title, 'Lab');
  });

  await t.test('scales the cursor through the window, not by offset alone', () => {
    // A Retina capture is wider in pixels than its window is in points.
    // Subtracting the origin without scaling lands the dot a fraction of the
    // way into the element instead of on it.
    const { calls, pip } = sink();
    const hook = { onActionBegin: () => undefined, onActionEnd: () => undefined };
    const wrapped = withComputerUsePip(hook as never, pip as never) as any;
    wrapped.onActionEnd({ type: 'left_click' }, {
      screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 1000, heightPx: 800 },
      resolvedScreenPoint: { x: 750, y: 300 },
      observation: { windowBounds: { x: 500, y: 100, width: 500, height: 400 } },
    }, { sessionId: 's1', toolCallId: 't1' });

    // (750-500)/500 * 1000 = 500 ; (300-100)/400 * 800 = 400
    assert.deepEqual(calls.find((c) => c.m === 'setCursor')!.a, { sessionId: 's1', x: 500, y: 400 });
  });

  await t.test('falls back to the point the action was addressed to', () => {
    // The executor reports `resolvedScreenPoint` only for the coordinate
    // paths. An element action resolves to an element, so it carries none —
    // and accessibility is how Maka dispatches by default, which made this the
    // ordinary case rather than the exceptional one. The context still knows
    // where the action was aimed (`presentationScreenPoint`, the element's own
    // centre, already computed to fly the cursor there), and without that
    // fallback the mirror cleared its cursor at the end of every accessibility
    // action: the one window the user could watch showed the app being driven
    // by nothing at all.
    const { calls, pip } = sink();
    const hook = { onActionBegin: () => undefined, onActionEnd: () => undefined };
    const wrapped = withComputerUsePip(hook as never, pip as never) as any;
    wrapped.onActionEnd({ type: 'click_element' }, {
      screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 1000, heightPx: 800 },
      // No resolvedScreenPoint: this is a semantic action.
      observation: { windowBounds: { x: 500, y: 100, width: 500, height: 400 } },
    }, {
      sessionId: 's1',
      toolCallId: 't1',
      presentationScreenPoint: { x: 750, y: 300 },
    });

    assert.deepEqual(
      calls.find((c) => c.m === 'setCursor')!.a,
      { sessionId: 's1', x: 500, y: 400 },
      'the element centre is mapped into capture pixels the same way a ' +
        'coordinate landing is',
    );
  });

  await t.test('prefers where the action landed over where it was aimed', () => {
    // The fallback is a fallback. When the executor reports a real landing
    // point, that is the truth about where the pointer went; the aim point is
    // only what was asked for.
    const { calls, pip } = sink();
    const hook = { onActionBegin: () => undefined, onActionEnd: () => undefined };
    const wrapped = withComputerUsePip(hook as never, pip as never) as any;
    wrapped.onActionEnd({ type: 'left_click' }, {
      screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 1000, heightPx: 800 },
      resolvedScreenPoint: { x: 750, y: 300 },
      observation: { windowBounds: { x: 500, y: 100, width: 500, height: 400 } },
    }, {
      sessionId: 's1',
      toolCallId: 't1',
      presentationScreenPoint: { x: 500, y: 100 },
    });

    assert.deepEqual(calls.find((c) => c.m === 'setCursor')!.a, { sessionId: 's1', x: 500, y: 400 });
  });

  await t.test('hides the cursor when the action resolved no point', () => {
    // Semantic actions address an element; some report no screen point at all.
    // Leaving a stale dot on screen would assert something untrue.
    const { calls, pip } = sink();
    const hook = { onActionBegin: () => undefined, onActionEnd: () => undefined };
    const wrapped = withComputerUsePip(hook as never, pip as never) as any;
    wrapped.onActionEnd({ type: 'click_element' }, {
      screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 1000, heightPx: 800 },
      observation: { windowBounds: { x: 0, y: 0, width: 500, height: 400 } },
    }, { sessionId: 's1', toolCallId: 't1' });
    assert.deepEqual(calls.find((c) => c.m === 'setCursor')!.a, { sessionId: 's1' });
  });

  await t.test('a mirror failure never takes the action down with it', () => {
    const throwing = {
      present: () => {
        throw new Error('renderer died');
      },
      setCursor: () => {},
      clearForSession: () => {},
      destroyAll: () => {},
      isVisible: () => false,
      currentSessionId: () => null,
    };
    let inner = 0;
    const hook = { onActionBegin: () => undefined, onActionEnd: () => void (inner += 1) };
    const wrapped = withComputerUsePip(hook as never, throwing as never) as any;
    assert.doesNotThrow(() =>
      wrapped.onActionEnd({ type: 'left_click' }, {
        screenshot: { base64: 'AAAA', mimeType: 'image/png', widthPx: 10, heightPx: 10 },
      }, { sessionId: 's1', toolCallId: 't1' }),
    );
    assert.equal(inner, 1);
  });
});
