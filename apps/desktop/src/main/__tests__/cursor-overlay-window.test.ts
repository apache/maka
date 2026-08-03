// Behavior contract for the cursor overlay window controller. Drives it against a
// FakeCursorOverlayWindow (no Electron) and asserts the Path 18 invariants:
//  - S14: focusable:false + setIgnoreMouseEvents(true,{forward:true}) armed BEFORE
//    showInactive; never a .focus(); receive-only preload wired.
//  - persistence: move() does NOT recreate the window (no teardown-per-move).
//  - S15: coords are MAIN-computed window-local (screen − bounds.origin).
//  - S13/S18: teardown is synchronous destroy() on clear/abort/destroyAll/supersede.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCursorOverlayController, cursorOverlayWindowOptions } from '../computer-use/cursor-overlay-window.js';
import { cursorPresentationReadyDeadlineMs } from '../../renderer/computer-use-overlay/engine/cursor-engine.js';

type Call = { m: string; args: unknown[] };

class FakeCursorOverlayWindow {
  calls: Call[] = [];
  sent: Array<{ channel: string; payload: unknown }> = [];
  private readyCb: (() => void) | null = null;
  private goneCb: (() => void) | null = null;
  private presentationCb:
    | ((payload: {
        sessionId: string;
        generation: number;
        actionId: string;
        phase: 'readyForInteraction' | 'finished';
      }) => void)
    | null = null;
  destroyed = false;
  constructor(public options: Record<string, unknown>) {}
  private rec(m: string, ...args: unknown[]): void { this.calls.push({ m, args }); }
  setIgnoreMouseEvents(ignore: boolean, opts?: unknown): void { this.rec('setIgnoreMouseEvents', ignore, opts); }
  setAlwaysOnTop(flag: boolean, level?: unknown, relativeLevel?: unknown): void {
    this.rec('setAlwaysOnTop', flag, level, relativeLevel);
  }
  setVisibleOnAllWorkspaces(v: boolean, o?: unknown): void { this.rec('setVisibleOnAllWorkspaces', v, o); }
  moveAboveThrows = false;
  moveAbove(mediaSourceId: string): void {
    this.rec('moveAbove', mediaSourceId);
    if (this.moveAboveThrows) throw new TypeError('Invalid media source id');
  }
  async loadFile(p: string): Promise<void> { this.rec('loadFile', p); }
  showInactive(): void { this.rec('showInactive'); }
  isDestroyed(): boolean { return this.destroyed; }
  destroy(): void { this.destroyed = true; this.rec('destroy'); }
  send(channel: string, payload: unknown): void { this.sent.push({ channel, payload }); }
  onReady(cb: () => void): void { this.readyCb = cb; }
  onGone(cb: () => void): void { this.goneCb = cb; }
  onPresentationPhase(
    cb: (payload: {
      sessionId: string;
      generation: number;
      actionId: string;
      phase: 'readyForInteraction' | 'finished';
    }) => void,
  ): void {
    this.presentationCb = cb;
  }
  fireReady(): void { this.readyCb?.(); }
  fireGone(): void { this.goneCb?.(); }
  firePresentation(
    actionId: string,
    phase: 'readyForInteraction' | 'finished',
    sessionId = 's',
    generation = 1,
  ): void {
    this.presentationCb?.({ sessionId, generation, actionId, phase });
  }
}

const BOUNDS = { x: 100, y: 50, width: 1440, height: 900 };
function harness() {
  const created: FakeCursorOverlayWindow[] = [];
  let displayChanged: (() => void) | undefined;
  let bounds = BOUNDS;
  const controller = createCursorOverlayController({
    createOverlayWindow: (options) => {
      const w = new FakeCursorOverlayWindow(options as Record<string, unknown>);
      created.push(w);
      return w as never;
    },
    resolveOverlayBounds: () => bounds,
    preloadPath: '/fake/preload.cjs',
    htmlPath: '/fake/overlay.html',
    subscribeDisplayChanges: (cb) => {
      displayChanged = cb;
      return () => { displayChanged = undefined; };
    },
  });
  return {
    controller,
    created,
    fireDisplayChanged: () => displayChanged?.(),
    setBounds: (next: typeof BOUNDS) => {
      bounds = next;
    },
  };
}

test('S14 window options: focusable:false + non-interactive flags + receive-only preload', () => {
  const opts = cursorOverlayWindowOptions(BOUNDS, '/p/preload.cjs') as Record<string, any>;
  assert.equal(opts.focusable, false);
  assert.equal(opts.transparent, true);
  assert.equal(opts.frame, false);
  assert.equal(opts.alwaysOnTop, true);
  assert.equal(opts.skipTaskbar, true);
  assert.equal(opts.acceptFirstMouse, false);
  assert.equal(opts.show, false);
  assert.equal(opts.webPreferences.preload, '/p/preload.cjs');
  assert.equal(opts.webPreferences.sandbox, true);
  assert.equal(opts.webPreferences.contextIsolation, true);
  assert.equal(opts.webPreferences.nodeIntegration, false);
});

test('ensure(): arms click-through BEFORE showInactive, never focuses', () => {
  const { controller, created } = harness();
  controller.ensure('sess-1');
  assert.equal(created.length, 1);
  const w = created[0];
  assert.equal(w.options.focusable, false);
  const order = w.calls.map((c) => c.m);
  const armIdx = order.indexOf('setIgnoreMouseEvents');
  const showIdx = order.indexOf('showInactive');
  assert.equal(showIdx, -1, 'window stays hidden until did-finish-load');
  w.fireReady();
  const readyOrder = w.calls.map((c) => c.m);
  assert.ok(
    armIdx >= 0 && readyOrder.indexOf('showInactive') > armIdx,
    `click-through armed before show (${readyOrder.join(',')})`,
  );
  const arm = w.calls.find((c) => c.m === 'setIgnoreMouseEvents')!;
  assert.deepEqual(arm.args, [true, { forward: true }]);
  // kCGOverlayWindowLevel (102) = NSPopUpMenuWindowLevel + 1, the level Codex
  // raises its cursor to. Above menus, below the screen saver.
  const aot = w.calls.find((c) => c.m === 'setAlwaysOnTop')!;
  assert.deepEqual(aot.args, [true, 'pop-up-menu', 1]);
  assert.ok(!order.includes('focus'), 'never focuses');
});

test('the cursor sinks a level once its motion settles over an exposed target', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'click',
    keepElevated: false,
  });
  const w = created[0];
  w.fireReady();
  const levelsDuringFlight = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  assert.deepEqual(levelsDuringFlight, [[true, 'pop-up-menu', 1]], 'elevated for the whole trip');

  w.firePresentation('a1', 'finished');
  await fence.finished;
  const levels = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  assert.deepEqual(levels.at(-1), [true, 'floating', 0]);
  // The fallback, and only the fallback. With no window to order against there
  // is nothing to sit above, so the level is all that is left — and dropping it
  // would put the cursor behind the window it points at. When there IS a window
  // (the test below) the level comes off and the cursor is ordered instead,
  // which is what stops it hanging over the user's own windows.
  assert.ok(
    levels.every((args) => args[0] === true),
    'with no target to order against, the overlay stays on always-on-top',
  );
});

test('with a target window, the resting cursor is ordered above it instead of floating over everything', async () => {
  // `'floating'` is above every ordinary application window, which is how the
  // cursor came to hang over whatever the user was reading while pointing at a
  // window buried behind it. Codex sinks to the target's own order; so does
  // this, now that `moveAbove` turns out to be the same AppKit primitive.
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 400,
    screenY: 300,
    kind: 'click',
    keepElevated: false,
    targetWindowId: 4321,
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await fence.finished;

  const ordering = w.calls
    .filter((c) => c.m === 'setAlwaysOnTop' || c.m === 'moveAbove')
    .map((c) => [c.m, ...c.args]);
  // Both calls, in this order: AppKit confines ordering to a window level, so
  // the level has to come off first, and dropping the level alone leaves the
  // overlay at the front of its layer covering exactly what it should not.
  assert.deepEqual(ordering.slice(-2), [
    ['setAlwaysOnTop', false, undefined, undefined],
    ['moveAbove', 'window:4321:0'],
  ]);
});

test('a target that went away leaves the cursor visible rather than stranded', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 400,
    screenY: 300,
    kind: 'click',
    keepElevated: false,
    targetWindowId: 4321,
  });
  const w = created[0];
  w.moveAboveThrows = true;
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await fence.finished;

  const levels = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  // Without putting the level back, a window destroyed between the action and
  // the settle leaves the cursor at normal level, buried, until the next action.
  assert.deepEqual(levels.at(-1), [true, 'floating', 0]);
});

test('a landing on a different window re-orders the cursor onto that window', async () => {
  // The overlay hook attaches `targetWindowId` to `complete` as well as `move`,
  // and the sink used to read it only in `move`. An action whose `onActionBegin`
  // early-returned (no presentation point to fly to) never calls `move`, so the
  // sink kept the previous action's window and ordered the cursor above THAT —
  // behind the window it is now pointing at.
  const { controller, created } = harness();
  const first = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 400,
    screenY: 300,
    kind: 'click',
    keepElevated: false,
    targetWindowId: 10,
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await first.finished;
  assert.deepEqual(
    w.calls.filter((c) => c.m === 'moveAbove').map((c) => c.args),
    [['window:10:0']],
    'the first action rests above its own window',
  );

  // Second action: no move(), because it had no point to fly to. It lands on a
  // different window and completes.
  controller.complete({
    actionId: 'a2',
    sessionId: 's',
    screenX: 900,
    screenY: 600,
    kind: 'click',
    pulse: true,
    targetWindowId: 20,
  });

  assert.deepEqual(
    w.calls.filter((c) => c.m === 'moveAbove').map((c) => c.args),
    [['window:10:0'], ['window:20:0']],
    'the landing re-orders onto the window it actually landed on',
  );
});

test('a landing on the same window does not re-order for nothing', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 400,
    screenY: 300,
    kind: 'click',
    keepElevated: false,
    targetWindowId: 10,
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await fence.finished;
  controller.complete({
    actionId: 'a2',
    sessionId: 's',
    screenX: 900,
    screenY: 600,
    kind: 'click',
    pulse: true,
    targetWindowId: 10,
  });
  assert.deepEqual(
    w.calls.filter((c) => c.m === 'moveAbove').map((c) => c.args),
    [['window:10:0']],
    'the same window at the same level is still a no-op',
  );
});

test('the fence declares the deadline the release gate actually needs', () => {
  // The runtime sizes its backstop from this. Left off, the runtime falls back
  // to its own constant, which is shorter than a long move takes and dispatches
  // the click with the glyph still travelling.
  const { controller } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 400,
    screenY: 300,
    kind: 'click',
  });
  assert.equal(
    fence.readyTimeoutMs,
    cursorPresentationReadyDeadlineMs(),
    'the fence carries the deadline derived from the motion model',
  );
});

test('a covered target keeps the cursor elevated after it settles', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'click',
    keepElevated: true,
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await fence.finished;
  const levels = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  assert.deepEqual(levels, [[true, 'pop-up-menu', 1]], 'one level, set once, never lowered');
});

test('a new launch raises the cursor again before it travels', async () => {
  const { controller, created } = harness();
  const first = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'click',
    keepElevated: false,
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await first.finished;

  controller.move({
    actionId: 'a2',
    sessionId: 's',
    screenX: 600,
    screenY: 500,
    kind: 'click',
    keepElevated: false,
  });
  const levels = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  assert.deepEqual(levels, [
    [true, 'pop-up-menu', 1],
    [true, 'floating', 0],
    [true, 'pop-up-menu', 1],
  ]);
});

test('a move that says nothing about stacking never sinks', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'a1',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'click',
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('a1', 'finished');
  await fence.finished;
  const levels = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  assert.deepEqual(levels, [[true, 'pop-up-menu', 1]]);
});

test('a completion with no live presentation raises no level it cannot lower', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'coordinate',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'click',
    keepElevated: false,
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('coordinate', 'finished');
  await fence.finished;

  controller.complete({
    actionId: 'semantic',
    sessionId: 's',
    screenX: 320,
    screenY: 260,
    kind: 'click',
    pulse: true,
  });
  const levels = w.calls.filter((c) => c.m === 'setAlwaysOnTop').map((c) => c.args);
  assert.deepEqual(levels.at(-1), [true, 'floating', 0], 'stays where the settle left it');
});

test('renderer loss and a display change that moves the overlay teardown the live overlay', () => {
  const gone = harness();
  gone.controller.ensure('s');
  gone.created[0].fireGone();
  assert.equal(gone.created[0].destroyed, true);
  assert.equal(gone.controller.isActive(), false);

  const display = harness();
  display.controller.ensure('s');
  display.setBounds({ x: -1920, y: 0, width: 3360, height: 1080 });
  display.fireDisplayChanged();
  assert.equal(display.created[0].destroyed, true);
  assert.equal(display.controller.isActive(), false);
});

test('a display change that leaves the union of displays alone keeps the overlay', () => {
  // `display-metrics-changed` fires for `workArea` too, and on a real machine
  // that arrives every couple of seconds because the menu bar or the Dock
  // changed shape — measured here with the primary display's work area
  // alternating between 875 and 873 points high with no windows open at all.
  // The overlay spans display *bounds*, so none of that moves it, and tearing
  // down on the bare event destroyed it mid-load: the window never reached
  // `onReady`, never showed, and a turn with a single dispatch produced no
  // visible cursor at all.
  const { controller, created, fireDisplayChanged } = harness();
  controller.ensure('s');
  fireDisplayChanged();
  assert.equal(created[0].destroyed, false, 'a work-area twitch is not a reason to rebuild');
  assert.equal(controller.isActive(), true);
  assert.equal(created.length, 1, 'and it does not build a second one either');
});

test('persistence: move() does NOT recreate the window; sends window-local coords', () => {
  const { controller, created } = harness();
  controller.move({ actionId: 'a0', sessionId: 's', screenX: 300, screenY: 250, kind: 'move' });
  controller.move({ actionId: 'a1', sessionId: 's', screenX: 500, screenY: 450, kind: 'click' });
  controller.move({ actionId: 'a2', sessionId: 's', screenX: 700, screenY: 650, kind: 'move' });
  assert.equal(created.length, 1, 'one window across 3 moves');
  const w = created[0];
  // before ready → queued; fire ready → reset first, then the 3 moves.
  w.fireReady();
  assert.equal(w.sent[0].channel, 'overlay:reset');
  assert.deepEqual(w.sent[0].payload, { sessionId: 's', generation: 1 });
  const moves = w.sent.filter((s) => s.channel === 'overlay:move');
  assert.equal(moves.length, 3);
  // window-local = screen − bounds.origin (100,50)
  assert.deepEqual(moves[0].payload, { actionId: 'a0', x: 200, y: 200, kind: 'move', pressed: false });
  assert.deepEqual(moves[1].payload, { actionId: 'a1', x: 400, y: 400, kind: 'click', pressed: false });
  controller.move({
    actionId: 'a-instant',
    sessionId: 's',
    screenX: 520,
    screenY: 470,
    kind: 'click',
    instant: true,
  });
  const instantMove = w.sent.filter((s) => s.channel === 'overlay:move').at(-1);
  assert.deepEqual(instantMove?.payload, {
    actionId: 'a-instant',
    x: 420,
    y: 420,
    kind: 'click',
    pressed: false,
    instant: true,
  });
  // a post-ready move sends immediately
  controller.move({ actionId: 'a3', sessionId: 's', screenX: 200, screenY: 150, kind: 'move' });
  const movesAfter = w.sent.filter((s) => s.channel === 'overlay:move');
  assert.equal(movesAfter.length, 5);
  assert.deepEqual(movesAfter[4].payload, { actionId: 'a3', x: 100, y: 100, kind: 'move', pressed: false });
});

test('multi-display union bounds preserve negative-origin secondary coordinates', () => {
  const created: FakeCursorOverlayWindow[] = [];
  const controller = createCursorOverlayController({
    createOverlayWindow: (options) => {
      const window = new FakeCursorOverlayWindow(options as Record<string, unknown>);
      created.push(window);
      return window as never;
    },
    resolveOverlayBounds: () => ({
      x: -1920,
      y: -180,
      width: 4480,
      height: 1620,
    }),
    preloadPath: '/fake/preload.cjs',
    htmlPath: '/fake/overlay.html',
    subscribeDisplayChanges: () => () => {},
  });
  controller.move({
    actionId: 'secondary',
    sessionId: 's',
    screenX: -960,
    screenY: 540,
    kind: 'click',
  });
  created[0].fireReady();
  assert.deepEqual(
    created[0].sent.find((message) => message.channel === 'overlay:move')?.payload,
    {
      actionId: 'secondary',
      x: 960,
      y: 720,
      kind: 'click',
      pressed: false,
    },
  );
});

test('presentation fence follows renderer phases and ignores stale action ids', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'live',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'move',
  });
  const observed: string[] = [];
  fence.readyForInteraction.then(() => observed.push('ready'));
  fence.finished.then(() => observed.push('finished'));
  created[0].firePresentation('stale', 'finished');
  created[0].firePresentation('live', 'finished', 'other', 1);
  created[0].firePresentation('live', 'finished', 's', 2);
  await Promise.resolve();
  assert.deepEqual(observed, []);
  created[0].firePresentation('live', 'readyForInteraction');
  await Promise.resolve();
  assert.deepEqual(observed, ['ready']);
  created[0].firePresentation('live', 'finished');
  await Promise.resolve();
  assert.deepEqual(observed, ['ready', 'finished']);
});

test('load failure tears down the window and releases pending fences', async () => {
  const created: FakeCursorOverlayWindow[] = [];
  const controller = createCursorOverlayController({
    createOverlayWindow: (options) => {
      const window = new FakeCursorOverlayWindow(options as Record<string, unknown>);
      window.loadFile = async () => {
        throw new Error('load failed');
      };
      created.push(window);
      return window as never;
    },
    resolveOverlayBounds: () => BOUNDS,
    preloadPath: '/fake/preload.cjs',
    htmlPath: '/fake/overlay.html',
    subscribeDisplayChanges: () => () => {},
  });
  const fence = controller.move({
    actionId: 'failed-load',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'move',
  });
  await Promise.all([fence.readyForInteraction, fence.finished]);
  assert.equal(created[0].destroyed, true);
  assert.equal(controller.isActive(), false);
});

test('finished presentation releases ownership for a later semantic completion', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'coordinate',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'move',
  });
  const w = created[0];
  w.fireReady();
  w.firePresentation('coordinate', 'finished');
  await fence.finished;

  controller.complete({
    actionId: 'semantic',
    sessionId: 's',
    screenX: 320,
    screenY: 260,
    kind: 'click',
    pulse: true,
  });
  const lastCompletion = w.sent.filter((message) => message.channel === 'overlay:complete').at(-1);
  assert.equal(
    lastCompletion?.payload && (lastCompletion.payload as { actionId: string }).actionId,
    'semantic',
  );
});

test('supersede and teardown release pending presentation fences', async () => {
  const { controller } = harness();
  const first = controller.move({
    actionId: 'first',
    sessionId: 's',
    screenX: 300,
    screenY: 250,
    kind: 'move',
  });
  controller.move({
    actionId: 'second',
    sessionId: 's',
    screenX: 400,
    screenY: 350,
    kind: 'move',
  });
  await Promise.all([first.readyForInteraction, first.finished]);
  const second = controller.move({
    actionId: 'third',
    sessionId: 's',
    screenX: 500,
    screenY: 450,
    kind: 'click',
  });
  controller.destroyAll();
  await Promise.all([second.readyForInteraction, second.finished]);
});

test('complete() sends exact backend coordinate only for the live action', () => {
  const { controller, created } = harness();
  controller.move({ actionId: 'a1', sessionId: 's', screenX: 500, screenY: 450, kind: 'click' });
  const w = created[0];
  w.fireReady();

  controller.complete({
    actionId: 'stale',
    sessionId: 's',
    screenX: 500,
    screenY: 450,
    kind: 'click',
    pulse: true,
  });
  assert.equal(w.sent.filter((message) => message.channel === 'overlay:complete').length, 0);

  controller.complete({
    actionId: 'a1',
    sessionId: 's',
    screenX: 500,
    screenY: 450,
    kind: 'click',
    pulse: true,
  });
  const completed = w.sent.filter((message) => message.channel === 'overlay:complete');
  assert.deepEqual(completed[0]?.payload, {
    actionId: 'a1',
    x: 400,
    y: 400,
    kind: 'click',
    pulse: true,
  });
});

test('cancel() waits for renderer finished and sends no coordinate', async () => {
  const { controller, created } = harness();
  const fence = controller.move({
    actionId: 'failed',
    sessionId: 's',
    screenX: 500,
    screenY: 450,
    kind: 'click',
    instant: true,
  });
  const w = created[0];
  w.fireReady();

  controller.cancel({ actionId: 'stale', sessionId: 's' });
  assert.equal(w.sent.filter((message) => message.channel === 'overlay:cancel').length, 0);
  controller.cancel({ actionId: 'failed', sessionId: 's' });
  let finished = false;
  fence.finished.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);

  const cancelled = w.sent.filter((message) => message.channel === 'overlay:cancel');
  assert.deepEqual(cancelled, [{
    channel: 'overlay:cancel',
    payload: { actionId: 'failed' },
  }]);
  assert.equal('x' in (cancelled[0].payload as object), false);
  assert.equal('y' in (cancelled[0].payload as object), false);
  w.firePresentation('failed', 'finished');
  await Promise.all([fence.readyForInteraction, fence.finished]);
  assert.equal(finished, true);
});

test('complete() can present an executor-resolved semantic point without a speculative begin move', () => {
  const { controller, created } = harness();
  controller.ensure('s');
  const w = created[0];
  w.fireReady();

  controller.complete({
    actionId: 'semantic',
    sessionId: 's',
    screenX: 320,
    screenY: 260,
    kind: 'click',
    pulse: true,
  });
  const completed = w.sent.filter((message) => message.channel === 'overlay:complete');
  assert.deepEqual(completed[0]?.payload, {
    actionId: 'semantic',
    x: 220,
    y: 210,
    kind: 'click',
    pulse: true,
  });
});

test('teardown: clearForSession / abort / destroyAll destroy synchronously; supersede on session change', () => {
  const { controller, created } = harness();
  controller.move({ actionId: 'a0', sessionId: 's1', screenX: 300, screenY: 250, kind: 'move' });
  controller.clearForSession('other'); // non-match ignored
  assert.ok(!created[0].destroyed, 'non-matching clear ignored');
  controller.clearForSession('s1');
  assert.ok(created[0].destroyed, 'matching clear destroys');

  // supersede: a different session destroys the old window and creates a new one
  const h = harness();
  h.controller.ensure('sA');
  h.controller.ensure('sB');
  assert.ok(h.created[0].destroyed, 'old session window superseded');
  assert.equal(h.created.length, 2);
  assert.ok(!h.created[1].destroyed);

  // abort keys on actionId
  const h2 = harness();
  h2.controller.move({ actionId: 'act-9', sessionId: 's', screenX: 1, screenY: 1, kind: 'move' });
  h2.controller.abort('stale'); // ignored
  assert.ok(!h2.created[0].destroyed);
  h2.controller.abort('act-9');
  assert.ok(h2.created[0].destroyed);
});

test('fail-closed: empty ids and non-finite coords are no-ops', () => {
  const { controller, created } = harness();
  controller.ensure('');
  assert.equal(created.length, 0, 'empty sessionId → no window');
  controller.move({ actionId: 'a', sessionId: '', screenX: 10, screenY: 10, kind: 'move' });
  assert.equal(created.length, 0, 'empty sessionId move → no window');
  controller.move({ actionId: 'a', sessionId: 's', screenX: NaN, screenY: 10, kind: 'move' });
  assert.equal(created.length, 0, 'NaN coord → no window');
});
