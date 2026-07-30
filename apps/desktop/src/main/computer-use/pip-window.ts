import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import {
  PIP_SPRING,
  PipDragTracker,
  anchorFor,
  pipResizeEdge,
  clampToWorkArea,
  pickPipAnchor,
  pipAnchors,
  springAtRest,
  stepSpring,
  type MotionState,
  type PipAlignment,
  type Point,
  type Rect,
} from './pip-motion.js';

/**
 * Picture-in-picture mirror of the window Computer Use is driving.
 *
 * The agent cursor can only be seen when the target window is. During ordinary
 * background work it is not: the user is looking at something else and the
 * driven window is underneath it. Codex answers this with
 * `CUAServiceRemoteHostedPIPController` — a live mirror of the backgrounded
 * app, with the agent cursor drawn into it — under a setting worded "Show
 * backgrounded apps that Computer Use is working on in Picture-in-Picture
 * mode." That is the real fix for occlusion: stop competing for the user's
 * screen and give the work its own small window.
 *
 * Codex streams via ScreenCaptureKit across XPC. Maka does not need either.
 * Every mutating action already returns a fresh screenshot of the target
 * (captured after the settle wait, so it shows the settled result), and that
 * frame is already in hand by the time the action completes. Mirroring it costs
 * nothing beyond the window. The trade is that this is a flipbook of
 * post-action frames rather than continuous video — enough to see what the
 * agent is doing, which is the point.
 */
export interface ComputerUsePipController {
  /** Show (or update) the mirror for a session with a freshly captured frame. */
  present(input: PipPresentInput): void;
  /** Draw the agent cursor inside the mirror, in target-window coordinates. */
  setCursor(input: { sessionId: string; x: number; y: number } | { sessionId: string }): void;
  clearForSession(sessionId: string): void;
  destroyAll(): void;
  isVisible(): boolean;
  /**
   * What the mirror's stop control runs. Same shape the status item uses, and
   * pointed at the same code, so stopping from the menu bar, from the mirror
   * and from the window cannot drift apart.
   */
  setStopHandler(handler: (sessionId: string) => void): void;
  /** Test seam. */
  currentSessionId(): string | null;
  /** Test seam: which corner the mirror is resting on. */
  currentAlignment(): PipAlignment;
}

export interface PipPresentInput {
  sessionId: string;
  /** Base64 image of the driven window, as the backend captured it. */
  base64: string;
  mimeType: 'image/png' | 'image/jpeg';
  widthPx: number;
  heightPx: number;
  /**
   * Window title. Not rendered — Codex's tiles carry no chrome at any size, and
   * identity comes from the mirrored content itself. Kept on the input because
   * the backend already has it and a future affordance (a tooltip, a hover
   * label) would want it rather than re-deriving it.
   */
  title?: string;
}

/**
 * The subset of a BrowserWindow needed to parent the mirror.
 *
 * Structural rather than `BrowserWindow` so the controller stays testable
 * without Electron; the one place that needs the real thing is the `parent`
 * constructor option, which is cast at that boundary.
 */
export interface ParentWindowLike {
  isDestroyed(): boolean;
}

export interface PipWindowLike {
  send(channel: string, payload: unknown): void;
  onReady(cb: () => void): void;
  onGone(cb: () => void): void;
  /**
   * Messages from this window's renderer only.
   *
   * Scoped to the WebContents rather than global `ipcMain`, so the drag and
   * the controls cannot be driven by any other renderer in the app.
   */
  onMessage(cb: (channel: string, payload: unknown) => void): void;
  setBounds(bounds: Rectangle): void;
  getBounds(): Rectangle;
  showInactive(): void;
  /** Click-through, with mouse moves still forwarded to the page. */
  setIgnoreMouseEvents(ignore: boolean): void;
  isDestroyed(): boolean;
  destroy(): void;
}

/**
 * The hover controls, from Codex's `performControlWithIdentifier:`.
 *
 * Codex has three — `stop`, `hide`, `close` — because its PiP is a stack:
 * `close` dismisses one tile and `hide` dismisses the stack. Maka mirrors one
 * window at a time, so those two are the same gesture and only one of them
 * earns a button.
 */
type PipControlId = 'stop' | 'hide';


export interface CreatePipControllerDeps {
  createWindow?: (options: BrowserWindowConstructorOptions) => PipWindowLike;
  resolveBounds?: (aspect: number) => Rectangle;
  /**
   * Where the app window is, so the mirror can sit against it.
   *
   * Codex's `PIPStackHost` is built from an owner window plus an anchor rect
   * and a set of corner anchors (`initWithHostID:ownerWindow:anchorContentRect:
   * anchors:presentationScope:`), rather than from a screen. Anchoring to the
   * app keeps the mirror with the thing it belongs to — pin it to a display and
   * it stays behind on the old screen the moment the user drags the app to
   * another one.
   *
   * Returns undefined when there is no app window, in which case the mirror
   * falls back to the primary display's corner, as Codex's own
   * `defaultHostForPositioning` / `fallbackAnchor` do.
   */
  resolveAnchorRect?: () => Rectangle | undefined;
  /**
   * Subscribe to app-window geometry changes; return an unsubscribe.
   *
   * Only resizes are acted on — see the subscription below for why a move is
   * deliberately ignored.
   */
  subscribeAnchorChanges?: (cb: () => void) => () => void;
  /**
   * The app window itself, to make the mirror its child.
   *
   * This is how Codex does it. `PIPStackWindow` is an
   * `NSWindowStyleMaskNonactivatingPanel` at `setLevel: 0` — plain
   * `NSNormalWindowLevel`, not floating — that becomes a child of its owner via
   * `addChildWindow:ordered:` (`attachToOwnerWindowForPositioning`). Both of
   * the mirror's original faults came from not doing this, and both were
   * measured on Electron 43 before the change:
   *
   *   parent moves    → child follows, same window-server transaction, no code
   *   parent resizes  → child does not move, so the anchor needs recomputing
   *   isAlwaysOnTop() → false, so it never covers an unrelated app
   *
   * `alwaysOnTop` with no level defaults to `floating`, which put the mirror
   * above every other app; repositioning on each `move` put a second
   * transaction one frame behind the drag, so the mirror visibly trailed the
   * window it belongs to. Child-window ordering removes the first and
   * child-window positioning removes the second.
   *
   * The comment on the geometry subscription used to say repositioning a small
   * window was "cheap enough not to debounce". It is cheap. It is also late.
   */
  resolveParentWindow?: () => ParentWindowLike | undefined;
  /**
   * Where the pointer is, in screen points.
   *
   * Read on the main side rather than taken from the renderer's `screenX` so
   * the drag cannot drift: the window is moved in screen points and the
   * pointer is read in screen points, with no CSS-pixel conversion in between.
   */
  cursorPoint?: () => Point;
  /** Work area of whichever display holds a rect, for the release clamp. */
  workAreaFor?: (rect: Rectangle) => Rect;
  /** Monotonic-enough clock, injectable so drag physics can be tested exactly. */
  now?: () => number;
  /** Schedule one animation step; returns a cancel. Defaults to ~60Hz. */
  scheduleFrame?: (cb: () => void) => () => void;
  /**
   * Schedule the next hover check; returns a cancel. Defaults to ~20Hz.
   *
   * Hover is decided here rather than in the page. Codex does the same, with
   * `addGlobalMonitorForEventsMatchingMask:` feeding
   * `updateHoverFromCurrentMouseLocation` — it never asks the window whether
   * the pointer is inside it. Electron has no global mouse monitor, so this
   * polls the pointer instead; the alternative, forwarding moves to a
   * click-through window and letting the page decide, drops events, which was
   * measured on this machine before it was replaced.
   */
  scheduleHoverCheck?: (cb: () => void) => () => void;
  preloadPath?: string;
  htmlPath?: string;
}

/**
 * Longest edge of the mirror, in points.
 *
 * Recovered from Codex, which defaults to 200 and clamps to [100, 400] — the
 * same constant appears in its capture service and again in its Electron
 * host's native addon, and the clamp is repeated across six methods. This was
 * 420 on a guess, which is above Codex's absolute maximum and about 4.4x the
 * area of its default. A mirror of peripheral information should not be the
 * second-largest thing on the screen.
 */
const PIP_DEFAULT_EDGE = 200;
const PIP_MIN_EDGE = 100;
const PIP_MAX_EDGE = 400;
/** Inset from the screen corner, matching Codex's 24pt anchor inset. */
const PIP_MARGIN = 24;

function defaultDistDir(): string {
  // Same walk the cursor overlay uses, and for the same reason: prod tsc emits
  // dist/main/computer-use/*.js while `npm run dev` esbuild-bundles into
  // dist/main/main.js. app.getAppPath() differs between those and again when
  // Electron is pointed at a loose script, so derive the location from this
  // module instead of asking the app where it thinks it lives.
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (basename(dir) === 'dist') return join(dir, 'overlay');
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(start, '..', '..', 'overlay');
}

/**
 * Bottom-right of the primary display, sized to the target's aspect ratio.
 *
 * Deliberately not centred and not on top of the user's likely work area: the
 * mirror is peripheral information, and a window that lands in the middle of
 * the screen to tell you about background work has defeated its own purpose.
 */
export function pipDisplaySize(
  aspect: number,
  maxEdge: number = PIP_DEFAULT_EDGE,
): { width: number; height: number } {
  // Aspect-preserving fit into a square box, exactly as Codex does it: scale by
  // min(edge/w, edge/h) so the longest edge lands on `edge` and never above.
  // Non-finite input falls back to the default rather than producing NaN
  // bounds, which is what Codex's own clamp does.
  const edge = Number.isFinite(maxEdge)
    ? Math.min(PIP_MAX_EDGE, Math.max(PIP_MIN_EDGE, Math.round(maxEdge)))
    : PIP_DEFAULT_EDGE;
  const ratio = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return {
    width: ratio >= 1 ? edge : Math.max(1, Math.round(edge * ratio)),
    height: ratio >= 1 ? Math.max(1, Math.round(edge / ratio)) : edge,
  };
}

/**
 * Place the mirror against the app window's bottom-right, inset by the same
 * 24pt Codex uses, and clamp it onto whichever display actually contains it.
 *
 * The clamp matters more than the anchor: an app window near a screen edge
 * would otherwise push the mirror off-screen or onto a neighbouring display,
 * which is exactly the "why is there something on my second monitor" failure.
 */
export function pipBoundsForAnchor(
  aspect: number,
  anchor: Rectangle | undefined,
  workArea: Rectangle,
): Rectangle {
  const { width, height } = pipDisplaySize(aspect);
  const base = anchor ?? workArea;
  const x = base.x + base.width - width - PIP_MARGIN;
  const y = base.y + base.height - height - PIP_MARGIN;
  return {
    width,
    height,
    x: Math.min(Math.max(x, workArea.x + PIP_MARGIN), workArea.x + workArea.width - width - PIP_MARGIN),
    y: Math.min(Math.max(y, workArea.y + PIP_MARGIN), workArea.y + workArea.height - height - PIP_MARGIN),
  };
}

function defaultResolveBounds(aspect: number, anchor?: Rectangle): Rectangle {
  const require = createRequire(import.meta.url);
  const { screen } = require('electron') as typeof import('electron');
  const display = anchor
    ? screen.getDisplayMatching(anchor)
    : screen.getPrimaryDisplay();
  return pipBoundsForAnchor(aspect, anchor, display.workArea);
}

/**
 * Recovered from Codex's `RemoteHostedPIPContentCreateStackPanel`, which builds
 * the panel as:
 *
 *   NSPanel styleMask: 0x80  (NSWindowStyleMaskNonactivatingPanel)
 *   setLevel: 0              (NSNormalWindowLevel — deliberately not floating)
 *   setOpaque: NO, backgroundColor: clearColor
 *   setHasShadow: NO         (the content draws its own)
 *   setHidesOnDeactivate: NO
 *   setMovableByWindowBackground: NO
 *
 * and then attaches it to the owner window with `addChildWindow:ordered:`.
 * Every option below that has an Electron equivalent follows it.
 */
export function pipWindowOptions(
  bounds: Rectangle,
  preloadPath: string,
  parent?: ParentWindowLike,
): BrowserWindowConstructorOptions {
  return {
    ...bounds,
    // Same focus contract as the cursor overlay: this reports on work happening
    // elsewhere, so taking focus would interrupt the very thing it describes.
    // Electron's `focusable: false` is what a nonactivating panel buys Codex.
    focusable: false,
    frame: false,
    transparent: true,
    // Codex's `setHasShadow: NO`. pip.html already draws its own shadow, so the
    // native one is a second shadow on top of it — and on a transparent window
    // the window server recomputes that shadow from the content's alpha every
    // time a frame lands, which is the one thing this window does constantly.
    hasShadow: false,
    // A child window is ordered against its parent, so it sits above the app it
    // belongs to and below everything it does not. Only when there is no app
    // window to attach to does the mirror have to claim a level of its own —
    // otherwise it would be buried with nothing to sit above.
    ...(parent ? { parent: parent as import('electron').BrowserWindow } : { alwaysOnTop: true }),
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    acceptFirstMouse: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export function createComputerUsePipController(
  deps: CreatePipControllerDeps = {},
): ComputerUsePipController {
  const resolveBounds =
    deps.resolveBounds ?? ((aspect: number) => defaultResolveBounds(aspect, deps.resolveAnchorRect?.()));
  const preloadPath = deps.preloadPath ?? join(defaultDistDir(), 'pip-preload.cjs');
  const htmlPath = deps.htmlPath ?? join(defaultDistDir(), 'pip.html');

  let win: PipWindowLike | null = null;
  let sessionId: string | null = null;
  let ready = false;
  let queue: Array<{ channel: string; payload: unknown }> = [];
  let aspect = 16 / 10;
  let unsubscribeAnchor: (() => void) | null = null;
  /**
   * The app window's size when the mirror was last positioned, and whether the
   * mirror is that window's child. Together they decide whether a geometry
   * change is one the window server has already handled.
   */
  let anchorSize: { width: number; height: number } | null = null;
  let parented = false;
  /**
   * Which corner the mirror rests on, and whether the user put it there.
   *
   * Once someone has thrown the mirror somewhere, a resize must bring it back
   * to *that* corner rather than to the default — moving it back to the
   * bottom-right would undo a decision they just made on purpose.
   */
  let alignment: PipAlignment = 'bottom-right';
  let drag: PipDragTracker | null = null;
  /**
   * A resize in flight: the edge and pointer height it started from.
   *
   * Codex's `PIPStackResizeInteraction` keeps exactly this pair
   * (`initialMaxDisplaySize`, `initialPointerScreenPoint`) and derives the new
   * edge from the pointer's vertical travel; nothing about the gesture is
   * incremental, so a jittery pointer cannot accumulate drift.
   */
  let resize: { edge: number; pointerY: number } | null = null;
  /** Longest edge the user has settled on, if they have moved it. */
  let chosenEdge: number | undefined;
  let motion: MotionState | null = null;
  let motionTarget: Point | null = null;
  let cancelFrame: (() => void) | null = null;
  /**
   * Which run the user dismissed the mirror for.
   *
   * A session id rather than a flag: `teardown` clears `sessionId`, so a flag
   * would be un-set by the very next frame of the run it was meant to dismiss.
   */
  let hiddenSessionId: string | null = null;
  let pointerInside = false;
  let cancelHover: (() => void) | null = null;
  let stopHandler: ((sessionId: string) => void) | undefined;

  const now = deps.now ?? (() => Date.now());
  // `unref` on both, because neither is work the process should stay alive
  // for. The hover poll in particular runs for as long as a mirror exists and
  // is cancelled only by teardown, so a referenced timer keeps the event loop
  // open forever — which is exactly what it did: `node --test` stopped exiting
  // the moment the poll landed, and sat there until it was killed.
  const scheduleFrame =
    deps.scheduleFrame ??
    ((cb: () => void) => {
      const handle = setTimeout(cb, 16);
      handle.unref?.();
      return () => clearTimeout(handle);
    });
  const scheduleHoverCheck =
    deps.scheduleHoverCheck ??
    ((cb: () => void) => {
      const handle = setTimeout(cb, 50);
      handle.unref?.();
      return () => clearTimeout(handle);
    });

  function push(channel: string, payload: unknown): void {
    if (!win || win.isDestroyed()) return;
    if (!ready) {
      // Keep only the newest frame: an unready window has no use for history,
      // and a backlog of base64 images is a real memory cost.
      queue = queue.filter((m) => m.channel !== channel);
      queue.push({ channel, payload });
      return;
    }
    win.send(channel, payload);
  }

  function teardown(): void {
    const w = win;
    win = null;
    sessionId = null;
    ready = false;
    queue = [];
    anchorSize = null;
    parented = false;
    drag = null;
    motion = null;
    motionTarget = null;
    pointerInside = false;
    cancelHover?.();
    cancelHover = null;
    cancelFrame?.();
    cancelFrame = null;
    unsubscribeAnchor?.();
    unsubscribeAnchor = null;
    if (w && !w.isDestroyed()) w.destroy();
  }

  function liveParent(): ParentWindowLike | undefined {
    const candidate = deps.resolveParentWindow?.();
    return candidate && !candidate.isDestroyed() ? candidate : undefined;
  }

  /**
   * The rect the mirror hangs off: the app window when there is one, otherwise
   * the display it is on. Codex calls this the host, and its
   * `defaultHostForPositioning` falls back the same way.
   */
  function hostRect(current: Rectangle): Rect {
    return deps.resolveAnchorRect?.() ?? workAreaOf(current);
  }

  function workAreaOf(rect: Rectangle): Rect {
    if (deps.workAreaFor) return deps.workAreaFor(rect);
    const require = createRequire(import.meta.url);
    const { screen } = require('electron') as typeof import('electron');
    return screen.getDisplayMatching(rect).workArea;
  }

  /** Rest position for the corner the mirror currently belongs to. */
  function restPoint(current: Rectangle): Point {
    const host = hostRect(current);
    const size = { width: current.width, height: current.height };
    const anchors = pipAnchors(host, size, PIP_MARGIN);
    const chosen = anchorFor(anchors, alignment) ?? anchors[anchors.length - 1]!;
    return clampToWorkArea(chosen.point, size, workAreaOf(current));
  }

  function moveTo(w: PipWindowLike, point: Point, size: { width: number; height: number }): void {
    w.setBounds({
      x: Math.round(point.x),
      y: Math.round(point.y),
      width: size.width,
      height: size.height,
    });
  }

  /**
   * Run the spring until it arrives.
   *
   * Codex drives this from a display link (`displayLinkDidRequestFrameAtTimestamp:`).
   * There is no display link in the main process, so the frame source is
   * injected — which also makes the physics testable without waiting for real
   * time to pass.
   */
  function animate(): void {
    cancelFrame?.();
    cancelFrame = null;
    let last = now();
    const tick = (): void => {
      const w = win;
      if (!w || w.isDestroyed() || !motion || !motionTarget) {
        cancelFrame = null;
        return;
      }
      const at = now();
      const dt = (at - last) / 1000;
      last = at;
      const spring = drag ? PIP_SPRING.dragging : PIP_SPRING.settling;
      motion = stepSpring(motion, motionTarget, spring, dt);
      const bounds = w.getBounds();
      moveTo(w, motion.position, { width: bounds.width, height: bounds.height });
      if (!drag && springAtRest(motion, motionTarget)) {
        moveTo(w, motionTarget, { width: bounds.width, height: bounds.height });
        motion = null;
        motionTarget = null;
        cancelFrame = null;
        return;
      }
      cancelFrame = scheduleFrame(tick);
    };
    cancelFrame = scheduleFrame(tick);
  }

  function beginDrag(w: PipWindowLike): void {
    const bounds = w.getBounds();
    const pointer = deps.cursorPoint?.() ?? { x: bounds.x, y: bounds.y };
    drag = new PipDragTracker(pointer, { x: bounds.x, y: bounds.y }, now());
    motion = { position: { x: bounds.x, y: bounds.y }, velocity: { x: 0, y: 0 } };
    motionTarget = { x: bounds.x, y: bounds.y };
    animate();
  }

  function moveDrag(w: PipWindowLike): void {
    if (!drag) return;
    const pointer = deps.cursorPoint?.();
    if (!pointer) return;
    // The spring targets the pointer rather than being snapped to it: that
    // trailing eighth of a second is what gives the window weight, and it is
    // why Codex uses a stiffer spring while dragging (900/55) than while
    // settling (320/42) instead of no spring at all.
    motionTarget = drag.update(pointer, now());
    if (!cancelFrame) animate();
    void w;
  }

  /**
   * Release: choose a corner from where the mirror is and how fast it was
   * thrown, then let the settling spring carry it there, seeded with the
   * release velocity so a throw keeps its momentum through the transition.
   */
  function endDrag(w: PipWindowLike): void {
    const tracker = drag;
    drag = null;
    if (!tracker) return;
    const pointer = deps.cursorPoint?.();
    if (pointer) tracker.update(pointer, now());
    const bounds = w.getBounds();
    const size = { width: bounds.width, height: bounds.height };
    const origin = tracker.windowOrigin;
    const velocity = tracker.velocity();
    const host = hostRect(bounds);
    const chosen = pickPipAnchor(pipAnchors(host, size, PIP_MARGIN), origin, velocity, host);
    alignment = chosen.alignment;
    motion = { position: origin, velocity };
    motionTarget = clampToWorkArea(chosen.point, size, workAreaOf(bounds));
    animate();
  }

  /**
   * Take the pointer only while it is on the mirror.
   *
   * Codex's tile takes the click unconditionally — `acceptsFirstMouse:` YES,
   * and a `hitTest:` that claims the whole view. Its tile is opt-in behind a
   * setting; ours appears whenever a run starts, so it has to cost nothing to
   * ignore. The window stays click-through until the pointer is actually over
   * it, which is also when its controls are worth showing.
   */
  function setPointerInside(w: PipWindowLike, inside: boolean): void {
    if (inside === pointerInside) return;
    pointerInside = inside;
    w.setIgnoreMouseEvents(!inside);
    push('pip:controls', { visible: inside });
  }

  function watchHover(w: PipWindowLike): void {
    cancelHover?.();
    const tick = (): void => {
      if (win !== w || w.isDestroyed()) {
        cancelHover = null;
        return;
      }
      // A drag owns the pointer until it ends: the mirror trails the cursor by
      // design, so the pointer being outside its bounds mid-drag means the
      // spring has not caught up, not that the user has left.
      if (!drag) {
        const pointer = deps.cursorPoint?.();
        const bounds = w.getBounds();
        if (pointer) {
          setPointerInside(
            w,
            pointer.x >= bounds.x &&
              pointer.y >= bounds.y &&
              pointer.x < bounds.x + bounds.width &&
              pointer.y < bounds.y + bounds.height,
          );
        }
      }
      cancelHover = scheduleHoverCheck(tick);
    };
    cancelHover = scheduleHoverCheck(tick);
  }

  function handleMessage(w: PipWindowLike, channel: string, payload: unknown): void {
    if (win !== w || w.isDestroyed()) return;
    switch (channel) {
      case 'pip:resize-begin': {
        const bounds = w.getBounds();
        const pointer = deps.cursorPoint?.();
        if (!pointer) return;
        resize = { edge: Math.max(bounds.width, bounds.height), pointerY: pointer.y };
        return;
      }
      case 'pip:resize-move': {
        if (!resize) return;
        const pointer = deps.cursorPoint?.();
        if (!pointer) return;
        const edge = pipResizeEdge(resize.edge, resize.pointerY, pointer.y, alignment);
        if (edge === chosenEdge) return;
        chosenEdge = edge;
        const size = pipDisplaySize(aspect, edge);
        const current = w.getBounds();
        // Re-seat as it grows: the mirror hangs off a corner, so a size change
        // moves the other three edges and leaving the origin alone would walk
        // it off its anchor.
        w.setBounds({ ...current, ...size });
        moveTo(w, restPoint({ ...current, ...size }), size);
        return;
      }
      case 'pip:resize-end':
        resize = null;
        return;
      case 'pip:pointer-down':
        beginDrag(w);
        return;
      case 'pip:pointer-move':
        moveDrag(w);
        return;
      case 'pip:pointer-up':
        endDrag(w);
        return;
      case 'pip:control': {
        const id = typeof payload === 'object' && payload !== null && 'id' in payload
          ? (payload as { id: unknown }).id
          : null;
        const session = sessionId;
        const control: PipControlId | null =
          id === 'stop' || id === 'hide' ? id : null;
        if (control === 'stop') {
          if (session) stopHandler?.(session);
          return;
        }
        if (control === 'hide') {
          hiddenSessionId = session;
          teardown();
        }
        return;
      }
      default:
        return;
    }
  }

  function ensure(nextSessionId: string): PipWindowLike {
    if (win && !win.isDestroyed() && sessionId === nextSessionId) return win;
    if (win) teardown();
    const parent = liveParent();
    const bounds = resolveBounds(aspect);
    const options = pipWindowOptions(bounds, preloadPath, parent);
    const created = deps.createWindow
      ? deps.createWindow(options)
      : defaultCreateWindow(options, htmlPath);
    win = created;
    sessionId = nextSessionId;
    ready = false;
    queue = [];
    parented = Boolean(parent);
    const anchor = deps.resolveAnchorRect?.();
    anchorSize = anchor ? { width: anchor.width, height: anchor.height } : null;
    created.onMessage((channel, payload) => handleMessage(created, channel, payload));
    created.onReady(() => {
      if (win !== created) return;
      ready = true;
      for (const m of queue) created.send(m.channel, m.payload);
      queue = [];
      created.showInactive();
      watchHover(created);
    });
    created.onGone(() => {
      if (win === created) teardown();
    });
    // Keep the mirror on the app window's corner across resizes and display
    // changes. A *move* is deliberately not acted on: a child window is carried
    // by its parent inside the same window-server transaction, so repositioning
    // it here would be both redundant and one frame late — and that lateness is
    // exactly the trailing the mirror used to show during a drag. A resize
    // leaves the child where it is while the corner moves out from under it, so
    // that one has to be recomputed.
    unsubscribeAnchor =
      deps.subscribeAnchorChanges?.(() => {
        if (win !== created || created.isDestroyed()) return;
        // A drag outranks the app window: whatever the window is doing, the
        // mirror is where the pointer is holding it.
        if (drag) return;
        const next = deps.resolveAnchorRect?.();
        if (parented && next && anchorSize &&
            next.width === anchorSize.width && next.height === anchorSize.height) {
          return;
        }
        anchorSize = next ? { width: next.width, height: next.height } : null;
        const current = created.getBounds();
        moveTo(created, restPoint(current), { width: current.width, height: current.height });
      }) ?? null;
    return created;
  }

  return {
    present(input: PipPresentInput): void {
      if (typeof input.sessionId !== 'string' || input.sessionId.length === 0) return;
      if (!input.base64) return;
      // Dismissed for this run. The next run gets a mirror again — hiding it
      // is a statement about this run, not a setting.
      if (hiddenSessionId === input.sessionId) return;
      const nextAspect =
        input.widthPx > 0 && input.heightPx > 0 ? input.widthPx / input.heightPx : aspect;
      const reshaped = Math.abs(nextAspect - aspect) > 0.01;
      aspect = nextAspect;
      const w = ensure(input.sessionId);
      // A reshape resizes the mirror, and a resized mirror no longer touches
      // the corner it was resting on — so re-seat it rather than leaving it
      // floating a few points off. Never while a drag or a settle is in
      // flight: those own the position until they finish.
      if (reshaped && !drag && !motion) {
        const current = w.getBounds();
        const size = pipDisplaySize(aspect, chosenEdge);
        w.setBounds({ ...current, ...size });
        moveTo(w, restPoint({ ...current, ...size }), size);
      }
      push('pip:frame', {
        src: `data:${input.mimeType};base64,${input.base64}`,
        widthPx: input.widthPx,
        heightPx: input.heightPx,
        ...(input.title ? { title: input.title } : {}),
      });
    },

    setCursor(input): void {
      if (!win || sessionId !== input.sessionId) return;
      push('pip:cursor', 'x' in input ? { x: input.x, y: input.y } : { hidden: true });
    },

    clearForSession(endedSessionId: string): void {
      if (hiddenSessionId === endedSessionId) hiddenSessionId = null;
      if (sessionId !== endedSessionId) return;
      teardown();
    },

    destroyAll(): void {
      hiddenSessionId = null;
      teardown();
    },

    setStopHandler(handler: (sessionId: string) => void): void {
      stopHandler = handler;
    },

    currentAlignment(): PipAlignment {
      return alignment;
    },

    isVisible(): boolean {
      return win !== null && !win.isDestroyed();
    },

    currentSessionId(): string | null {
      return sessionId;
    },
  };
}

function defaultCreateWindow(
  options: BrowserWindowConstructorOptions,
  htmlPath: string,
): PipWindowLike {
  const require = createRequire(import.meta.url);
  const { BrowserWindow } = require('electron') as typeof import('electron');
  const w = new BrowserWindow(options);
  // Click-through with moves forwarded: the page still sees the pointer cross
  // it, which is how it knows to ask for the clicks back.
  w.setIgnoreMouseEvents(true, { forward: true });
  void w.loadFile(htmlPath);
  const PIP_CHANNELS = [
    'pip:pointer-down',
    'pip:pointer-move',
    'pip:pointer-up',
    'pip:control',
    'pip:resize-begin',
    'pip:resize-move',
    'pip:resize-end',
  ] as const;
  return {
    send: (channel, payload) => w.webContents.send(channel, payload),
    onReady: (cb) => w.webContents.once('did-finish-load', cb),
    onGone: (cb) => w.once('closed', cb),
    onMessage: (cb) => {
      // `webContents.ipc` is scoped to this window, so nothing else in the app
      // can drive the mirror by sending on the same channel names.
      for (const channel of PIP_CHANNELS) {
        w.webContents.ipc.on(channel, (_event, payload) => cb(channel, payload));
      }
    },
    setBounds: (bounds) => w.setBounds(bounds),
    getBounds: () => w.getBounds(),
    showInactive: () => w.showInactive(),
    setIgnoreMouseEvents: (ignore) => w.setIgnoreMouseEvents(ignore, { forward: true }),
    isDestroyed: () => w.isDestroyed(),
    destroy: () => w.destroy(),
  };
}

/**
 * Feed the mirror from the same hook that drives the cursor.
 *
 * Wraps rather than replaces, for the same reason the status item does: the
 * cursor declines to draw in exactly the situations the mirror exists for. It
 * consumes the screenshot every mutating action already returns, so mirroring
 * costs no extra capture — and it covers semantic actions too, which the
 * cursor's own `onActionEnd` skips because they carry no end coordinate.
 */
export function withComputerUsePip<
  H extends {
    onActionBegin(action: never, context: never): unknown;
    onActionEnd?(action: never, result: never, context: never): unknown;
  },
>(hook: H, pip: ComputerUsePipController): H {
  return {
    ...hook,
    onActionBegin: hook.onActionBegin.bind(hook),
    onActionEnd(action: never, result: never, context: never) {
      const inner = hook.onActionEnd?.call(hook, action, result, context);
      try {
        presentToPip(pip, result, context);
      } catch {
        // A mirror that fails must never take the action down with it.
      }
      return inner;
    },
  } as H;
}

interface PipFeedResult {
  screenshot?: { base64: string; mimeType: 'image/png' | 'image/jpeg'; widthPx: number; heightPx: number };
  resolvedScreenPoint?: { x: number; y: number };
  observation?: {
    windowTitle?: string;
    windowBounds?: { x: number; y: number; width: number; height: number };
    screenshot?: { base64: string; mimeType: 'image/png' | 'image/jpeg'; widthPx: number; heightPx: number };
  };
}

function presentToPip(
  pip: ComputerUsePipController,
  result: PipFeedResult | undefined,
  context: { sessionId?: string } | undefined,
): void {
  const sessionId = context?.sessionId;
  if (!sessionId || !result) return;
  const shot = result.screenshot ?? result.observation?.screenshot;
  if (!shot?.base64) return;

  pip.present({
    sessionId,
    base64: shot.base64,
    mimeType: shot.mimeType,
    widthPx: shot.widthPx,
    heightPx: shot.heightPx,
    ...(result.observation?.windowTitle ? { title: result.observation.windowTitle } : {}),
  });

  // The cursor point is in screen coordinates; the mirror needs it in capture
  // pixels. Scale through the window rather than subtracting the origin alone,
  // so a Retina capture (wider than the window in points) still lands on the
  // right control instead of a quarter of the way into it.
  const point = result.resolvedScreenPoint;
  const bounds = result.observation?.windowBounds;
  if (!point || !bounds || bounds.width <= 0 || bounds.height <= 0) {
    pip.setCursor({ sessionId });
    return;
  }
  pip.setCursor({
    sessionId,
    x: ((point.x - bounds.x) / bounds.width) * shot.widthPx,
    y: ((point.y - bounds.y) / bounds.height) * shot.heightPx,
  });
}
