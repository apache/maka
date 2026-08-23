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

import { createRequire } from 'node:module';
import {
  defaultCreateWindow,
  defaultDistDir,
  defaultResolveBounds,
  pipDisplaySize,
  pipWindowOptions,
  type ParentWindowLike,
  type PipWindowLike,
} from './pip-electron.js';
import { join } from 'node:path';
import type { BrowserWindowConstructorOptions, Rectangle } from 'electron';
import {
  PIP_MARGIN,
  PIP_SPRING,
  PipDragTracker,
  anchorFor,
  pipGripCorner,
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
 * `CUAServiceRemoteHostedPIPController` — a live mirror of the window being
 * driven, with the agent cursor drawn into it. That is the real fix for
 * occlusion: stop competing for the user's screen and give the work its own
 * small window.
 *
 * This comment used to attribute that to a setting worded "Show backgrounded
 * apps that Computer Use is working on in Picture-in-Picture mode", and to
 * describe the mirror as gated on the app being backgrounded. Neither survives
 * inspection: that sentence has zero matches anywhere in the shipped app, the
 * real preference is an opt-OUT named `computerUseAlwaysHidePictureInPicture`
 * ("Always hide picture in picture"), and the trigger contains no occlusion
 * term at all — a notification when a new skyshot arrives, admitted when a turn
 * is active and that window has no stream yet. Occlusion appears nowhere in the
 * controller or in the host's visibility predicate.
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
  /**
   * The run finished — one turn, not the whole session. Marks the mirror
   * complete and retires it after a while, instead of taking it away at the
   * moment a person looks over, and expires a dismissal so the next turn
   * starts from a mirror the user can see.
   */
  complete(sessionId: string): void;
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
 * How long a finished run's mirror stays before it retires.
 *
 * Codex's value, read from its own dispatch: `dispatch_time(DISPATCH_TIME_NOW,
 * 0x6FC23AC00)` is exactly 30 seconds.
 */
const PIP_COMPLETED_LINGER_MS = 30_000;






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
   * `complete` clears it, because that is where a run ends — see `hide`.
   */
  let hiddenSessionId: string | null = null;
  /** Pending retirement of a finished run's mirror. */
  let retire: ReturnType<typeof setTimeout> | undefined;
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

  /**
   * Tell the page which corner the tile is anchored to.
   *
   * The renderer needs this for exactly one thing, and it is not cosmetic: the
   * resize grip has to sit on the corner opposite the anchor, because that is
   * the corner that moves when the tile grows. `pipResizeEdge` already takes
   * its sign from the alignment; before this, nothing sent the alignment to the
   * page at all, so the grip stayed pinned to the tile's top-left in CSS and
   * only the default bottom-right anchor lined up. Throw the mirror to the
   * top-left and the grip sat on the pinned corner: dragging it down grew the
   * tile from the far edge while the handle itself could not move, so the
   * pointer left the grip on the first pixel.
   */
  function pushAlignment(): void {
    push('pip:layout', { alignment, gripCorner: pipGripCorner(alignment) });
  }

  function teardown(): void {
    if (retire) {
      clearTimeout(retire);
      retire = undefined;
    }
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
    // Clamped against the host's display, not the mirror's. The anchors are
    // corners of the app window, so they live in that window's display's
    // coordinates; clamping them into the work area of whichever display the
    // mirror happens to be on right now mixes two coordinate spaces and parks
    // the mirror against an arbitrary edge the moment the two differ — which
    // is every time the app is on an external display and the mirror is not.
    return clampToWorkArea(chosen.point, size, workAreaOf(host));
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
    pushAlignment();
    motion = { position: origin, velocity };
    // Same reason as `restPoint`: the anchor came out of the host's space, so
    // the clamp has to be the host's display too.
    motionTarget = clampToWorkArea(chosen.point, size, workAreaOf(host));
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
          // Dismissed for the rest of this run. `complete` puts it back, so
          // the next turn of the same conversation is a fresh decision — see
          // the note on `hiddenSessionId`.
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
    // Queued until the page loads. A fresh window inherits whichever corner the
    // last one was thrown to, so this cannot be left to the first drag.
    pushAlignment();
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
    // A window whose page never loads is not a mirror, it is a leak: nothing
    // shows it, nothing starts its hover watch, and nothing would ever destroy
    // it. Treat it as gone, which is what it is.
    created.onLoadFailure(() => {
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
      // is a statement about this run, not a setting. A run is a turn, which
      // is what `complete` marks the end of.
      if (hiddenSessionId === input.sessionId) return;
      const nextAspect =
        input.widthPx > 0 && input.heightPx > 0 ? input.widthPx / input.heightPx : aspect;
      const reshaped = Math.abs(nextAspect - aspect) > 0.01;
      aspect = nextAspect;
      // A frame means work resumed — whatever retirement was pending is wrong.
      if (retire) {
        clearTimeout(retire);
        retire = undefined;
      }
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

    /**
     * The run finished. Keep the mirror up for a while, then retire it.
     *
     * Destroying it the moment the turn ends takes the final state away at
     * exactly the moment a person wants to look at it: they were watching
     * background work precisely because they could not see the window, and the
     * answer arriving is when they look over. Codex holds the tile, plays a
     * completion effect on it, and removes it thirty seconds later.
     *
     * Not the same thing as stopping or deleting a session — those still tear
     * down immediately, because there the user has said they are done.
     *
     * This is also where a dismissal expires, and the reason it happens before
     * the early return: a hidden mirror has no window, so anything after the
     * `!win` check would never run for the case that needs it. `hide` is scoped
     * to a run and a run is a turn — the same turn end that brings
     * `computerUseOverlay.clearForSession` and `computerUseTools.clearSession`
     * brings this. Holding it for the whole session instead would leave a
     * follow-up driving another app for minutes with no mirror and no way to
     * ask for one back, short of stopping, archiving or deleting the session.
     * Between a control the user has to press twice and one they cannot undo,
     * the recoverable one wins.
     */
    complete(endedSessionId: string): void {
      if (hiddenSessionId === endedSessionId) hiddenSessionId = null;
      if (!win || sessionId !== endedSessionId) return;
      push('pip:completed', {});
      if (retire) clearTimeout(retire);
      retire = setTimeout(() => {
        retire = undefined;
        if (sessionId === endedSessionId) teardown();
      }, PIP_COMPLETED_LINGER_MS);
      // Nothing here is work the process should stay alive for.
      retire.unref?.();
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



// Re-exported so the tests that reach for these keep their import path while
// the code moves. The forwarding line is what makes this a move rather than a
// change; it comes out in a later cut, not this one.
export {
  pipBoundsForAnchor,
  pipDisplaySize,
  pipWindowOptions,
  type ParentWindowLike,
  type PipWindowLike,
} from './pip-electron.js';

// Re-exported so callers and tests keep their import path while the code
// moves. Comes out in a later cut.
export { withComputerUsePip } from './pip-feed.js';
