/**
 * Drag-to-grant permission onboarding — the lifecycle half.
 *
 * macOS gates Accessibility and Screen Recording behind TCC, and the
 * stock path is six steps ending in a file picker, which is where most
 * people give up. System Settings also accepts an `.app` bundle *dropped*
 * onto the permission list — the same explicit user consent Apple wants,
 * in one gesture. This controller runs that flow: open the right pane,
 * float a non-focusable card the user can drag the app out of, watch for
 * the grant, and get out of the way.
 *
 * Docking is progressive enhancement. Locating a foreign window needs
 * `CGWindowListCopyWindowInfo`, i.e. native code, so `locateSettingsWindow`
 * is optional: with it the card docks under the Settings window and
 * follows it; without it (no locator binary, or Settings not found) the
 * card anchors to the cursor, which is the Stage 1 behaviour that shipped
 * and works. Everything else — panel window, drag, grant poll — is stock
 * Electron. See docs/permission-onboarding-plan.md.
 *
 * Every dependency is injected so the state machine is testable under
 * `node --test` with no Electron runtime and no real timers.
 */

import type { DragGrantPermissionId } from '@maka/core';
import { isDragGrantPermissionId } from '@maka/core';
import type { LocatorResult } from './settings-window-locator.js';
import type { SettingsWindowFrame } from './settings-window-locator.js';
import { runFlight, type Rect } from './card-flight.js';

// The id list lives in @maka/core so the Permission Center row and this
// flow cannot disagree about which permissions the gesture applies to.
export type { DragGrantPermissionId };
export const isDragGrantPermission = isDragGrantPermissionId;

export type OverlayStartResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'invalid_id' | 'unsupported_platform' | 'already_open' | 'open_settings_failed';
      message?: string;
    };

export interface Bounds { x: number; y: number; width: number; height: number }

/** The window surface the controller drives; faked in tests. */
export interface PermissionOverlayWindowLike {
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  showInactive(): void;
  isDestroyed(): boolean;
  destroy(): void;
  send(channel: string, payload: unknown): void;
  onReady(cb: () => void): void;
  onGone(cb: () => void): void;
}

export interface PermissionOverlayDeps {
  platform: NodeJS.Platform;
  /** Card size, in DIP. */
  cardSize: { width: number; height: number };
  createWindow(bounds: { x: number; y: number; width: number; height: number }): PermissionOverlayWindowLike;
  /** Cursor position + the work area of the display it sits on. */
  getAnchor(): { x: number; y: number; workArea: { x: number; y: number; width: number; height: number } };
  /**
   * Work area of the display containing an arbitrary screen point.
   *
   * Docking must clamp against the display holding SYSTEM SETTINGS, which
   * is not necessarily the one holding the cursor. Displays routinely have
   * negative origins (an external above or left of the built-in panel), so
   * clamping to the wrong one does not merely nudge the card — it drags it
   * onto a different monitor.
   */
  workAreaForPoint?(x: number, y: number): { x: number; y: number; width: number; height: number };
  openSystemSettings(id: DragGrantPermissionId): Promise<{ ok: boolean; message?: string }>;
  /** Non-prompting read of the current grant state. */
  isGranted(id: DragGrantPermissionId): boolean;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  /** Payload the card renders (app icon + name + copy). */
  buildCardPayload(id: DragGrantPermissionId): unknown;
  /**
   * Optional: locate the System Settings window so the card can dock to
   * it. Absent (or resolving null) keeps the Stage 1 cursor anchor, which
   * is a working state — see docs/permission-onboarding-plan.md.
   */
  locateSettingsWindow?(): Promise<LocatorResult>;
  onGranted?(id: DragGrantPermissionId): void;
  log?(message: string): void;
  /** Animation clock + frame scheduler. Injected so tests never animate. */
  now?(): number;
  requestTick?(fn: () => void): void;
  /** System "reduce motion" setting; true skips the flight entirely. */
  reducedMotion?(): boolean;
}

/** Poll cadence for the grant check. macOS exposes no usable notification
 *  for these two, so polling is the only option; 1.5s is responsive
 *  without being a busy-wait. */
export const GRANT_POLL_MS = 1_500;
/** Let the user read the "granted" state before the card disappears. */
export const GRANT_CLOSE_DELAY_MS = 1_200;
/**
 * Give-up timeout. Without it the card is immortal: it is always-on-top
 * across every Space, and Stage 1 cannot see that System Settings was
 * closed, so an abandoned flow would leave a floating card the user has
 * to hunt down. Ten minutes is long enough to find the pane and short
 * enough that a forgotten card cleans itself up.
 */
export const GIVE_UP_MS = 10 * 60 * 1_000;
/**
 * Docking tick. Each one spawns the locator, so this is 5 processes a
 * second — affordable for a short-lived onboarding card and not something
 * to generalise. Below ~100ms the spawn cost shows; above ~500ms the card
 * visibly lags a window the user is dragging.
 */
export const DOCK_POLL_MS = 200;
/** Gap between the Settings window and the card. */
export const DOCK_GAP_PX = 8;
/** Consecutive misses before we conclude Settings is gone, not just busy. */
export const DOCK_LOST_TICKS = 5;

export interface PermissionOverlayController {
  /** `sourceRect` is the on-screen rect of the button the user pressed, so
   *  the card can launch from it. Omitted → no flight, card just appears. */
  start(id: unknown, sourceRect?: Rect | null): Promise<OverlayStartResult>;
  /** Tear the card down: the × button, app quit, or a test. */
  dismiss(): void;
  isOpen(): boolean;
  /** Which permission is on screen. Assertion surface for tests. */
  activePermission(): DragGrantPermissionId | null;
}

export function createPermissionOverlayController(
  deps: PermissionOverlayDeps,
): PermissionOverlayController {
  let win: PermissionOverlayWindowLike | null = null;
  let active: DragGrantPermissionId | null = null;
  let poll: NodeJS.Timeout | null = null;
  let giveUp: NodeJS.Timeout | null = null;
  let closing: NodeJS.Timeout | null = null;
  let dock: NodeJS.Timeout | null = null;
  let cancelFlight: (() => void) | null = null;
  // Docking memory, hoisted so the pre-flight locate in `start()` can seed
  // it: without that, the first tick re-writes bounds the flight already
  // delivered, and a card that has been located once still looks "never
  // seen" to the went-away check.
  let lastDockKey = '';
  let everLocated = false;

  function stopTimers(): void {
    if (poll) { deps.clearInterval(poll); poll = null; }
    if (giveUp) { deps.clearTimeout(giveUp); giveUp = null; }
    if (closing) { deps.clearTimeout(closing); closing = null; }
    if (dock) { deps.clearInterval(dock); dock = null; }
    if (cancelFlight) { cancelFlight(); cancelFlight = null; }
  }

  function teardown(): void {
    // Timers first: a poll tick that outlives the window would read a
    // destroyed handle.
    stopTimers();
    const current = win;
    win = null;
    active = null;
    if (current && !current.isDestroyed()) current.destroy();
  }

  /**
   * Anchor the card near the cursor, clamped into the display's work
   * area. The user has just clicked our button, so the cursor is the
   * best available proxy for where they are looking — and it is on the
   * display they are actually using, which a hardcoded position is not.
   */
  function cardBounds(): { x: number; y: number; width: number; height: number } {
    const { x, y, workArea } = deps.getAnchor();
    const { width, height } = deps.cardSize;
    const clamp = (value: number, min: number, max: number): number =>
      Math.round(Math.min(Math.max(value, min), max));
    return {
      width,
      height,
      // Centred horizontally on the cursor, and below it, so the card does
      // not land under the pointer that is about to drag out of it.
      x: clamp(x - width / 2, workArea.x, workArea.x + workArea.width - width),
      y: clamp(y + 24, workArea.y, workArea.y + workArea.height - height),
    };
  }

  /**
   * Place the card against the System Settings window.
   *
   * BELOW the window, not over it. The card is always-on-top; parking it
   * across the Privacy list would cover the very rows the user has to
   * drop onto, which is worse than not docking at all. Sitting under the
   * window also makes "drag it up into the list" literally true.
   *
   * Centred on the whole window rather than on the content pane. Alma
   * offsets by a hardcoded 170px sidebar to centre over the pane; that
   * number is exactly the kind of internal-layout constant that rots
   * across macOS releases, and being 100px off-centre costs nothing while
   * being wrong about the sidebar width looks broken.
   */
  function dockedBounds(frame: SettingsWindowFrame): Bounds {
    const { width, height } = deps.cardSize;
    // The display under the Settings window's centre — see workAreaForPoint.
    const workArea = deps.workAreaForPoint
      ? deps.workAreaForPoint(frame.x + frame.width / 2, frame.y + frame.height / 2)
      : deps.getAnchor().workArea;
    const clamp = (value: number, min: number, max: number): number =>
      Math.round(Math.min(Math.max(value, min), max));

    const x = clamp(
      frame.x + (frame.width - width) / 2,
      workArea.x,
      workArea.x + workArea.width - width,
    );
    const below = frame.y + frame.height + DOCK_GAP_PX;
    // No room underneath (Settings near the bottom of the display): tuck
    // the card just inside the window's lower edge instead of letting the
    // clamp shove it somewhere unrelated.
    const y = below + height <= workArea.y + workArea.height
      ? below
      : clamp(frame.y + frame.height - height - DOCK_GAP_PX, workArea.y, workArea.y + workArea.height - height);
    return { x, y: Math.round(y), width, height };
  }

  /**
   * Fly the card from `from` to `to`. The destination is the resting
   * position we know NOW; if the locator resolves a docked position a
   * moment later, the docking tracker retargets from wherever the flight
   * left the card, which reads as one continuous move rather than a jump.
   */
  function flyTo(target: PermissionOverlayWindowLike, from: Rect, to: Rect): void {
    if (cancelFlight) cancelFlight();
    cancelFlight = runFlight({
      from,
      to,
      reducedMotion: deps.reducedMotion?.() ?? false,
      now: deps.now!,
      requestTick: deps.requestTick!,
      setFrame: (rect) => {
        if (win !== target || target.isDestroyed()) return;
        target.setBounds(rect);
      },
      onDone: () => { cancelFlight = null; },
    });
  }

  function beginDocking(target: PermissionOverlayWindowLike): void {
    const locate = deps.locateSettingsWindow;
    if (!locate) return;
    let misses = 0;

    dock = deps.setInterval(() => {
      if (win !== target || target.isDestroyed()) return;
      void locate().then((result) => {
        // Identity, not just liveness: `locate()` is a real async spawn, so
        // this continuation can land after teardown and after a NEW card
        // opened. Checking only "some window is alive" would move that new
        // window using the previous session's geometry.
        if (win !== target || target.isDestroyed()) return;
        if (!result.ok) {
          // A locator that CANNOT run is not evidence about System
          // Settings. Treating it as "the user closed the pane" is how a
          // build shipped without the binary would kill its own card one
          // second after opening it.
          if (result.reason !== 'not_running' && result.reason !== 'no_settings_window') {
            deps.log?.(`[permission-overlay] locator unavailable (${result.reason}) — staying on the cursor anchor`);
            if (dock) { deps.clearInterval(dock); dock = null; }
            return;
          }
          if (!everLocated) return;
          if (++misses < DOCK_LOST_TICKS) return;
          deps.log?.('[permission-overlay] System Settings went away — closing the card');
          teardown();
          return;
        }
        const frame = result.frame;
        everLocated = true;
        misses = 0;
        const next = dockedBounds(frame);
        const key = `${next.x},${next.y},${next.width},${next.height}`;
        // Only touch the window when the target actually moved: setBounds
        // on every tick fights the user's own drag of the Settings window.
        // While the entrance flight owns the bounds, record the target but
        // do not write it: the flight's 16ms steps would overwrite us and we
        // would overwrite the flight, visibly fighting for its whole 620ms.
        if (cancelFlight) { lastDockKey = ''; return; }
        if (key === lastDockKey) return;
        lastDockKey = key;
        target.setBounds(next);
      });
    }, DOCK_POLL_MS);
  }

  function beginWatching(id: DragGrantPermissionId): void {
    poll = deps.setInterval(() => {
      if (!win || win.isDestroyed()) { teardown(); return; }
      if (!deps.isGranted(id)) return;
      // Granted: tell the card so it can show the confirmation, stop
      // polling, and close after the user has had a chance to see it.
      if (poll) { deps.clearInterval(poll); poll = null; }
      win.send('permission-overlay:granted', { permission: id });
      deps.onGranted?.(id);
      closing = deps.setTimeout(teardown, GRANT_CLOSE_DELAY_MS);
    }, GRANT_POLL_MS);

    giveUp = deps.setTimeout(() => {
      deps.log?.(`[permission-overlay] ${id}: gave up after ${GIVE_UP_MS}ms with no grant`);
      teardown();
    }, GIVE_UP_MS);
  }

  return {
    async start(id: unknown, sourceRect?: Rect | null): Promise<OverlayStartResult> {
      if (!isDragGrantPermission(id)) return { ok: false, reason: 'invalid_id' };
      if (deps.platform !== 'darwin') return { ok: false, reason: 'unsupported_platform' };
      // Re-entry is not an error the user should see, but it must not
      // stack a second window or a second pair of timers on the first.
      if (win && !win.isDestroyed()) {
        return active === id ? { ok: true } : { ok: false, reason: 'already_open' };
      }

      // Already granted: opening a card that says "drag this in" over a
      // list the app is already on would be a lie.
      if (deps.isGranted(id)) return { ok: true };

      const opened = await deps.openSystemSettings(id);
      if (!opened.ok) {
        return { ok: false, reason: 'open_settings_failed', message: opened.message };
      }

      active = id;
      lastDockKey = '';
      everLocated = false;
      // Launch from the button when the caller told us where it is, so the
      // card is seen to come OUT of the control the user just pressed.
      // Without a source rect it simply appears at the resting position.
      const resting = cardBounds();
      const canFly = Boolean(sourceRect && deps.now && deps.requestTick);
      const created = deps.createWindow(canFly ? { ...sourceRect! } : resting);
      win = created;
      created.onGone(() => {
        // The window can also go away on its own (user closed it, render
        // process died). Only tear down if it is still the current one.
        if (win === created) teardown();
      });
      created.onReady(() => {
        if (win !== created || created.isDestroyed()) return;
        created.send('permission-overlay:show', deps.buildCardPayload(id));
        created.showInactive();
      });
      // Resolve the docked position BEFORE flying, so the card makes one
      // continuous move from the button to where it will actually live.
      // Flying to the cursor anchor first and letting the tracker correct
      // it afterwards is what made the two fight over the same bounds.
      let destination = resting;
      if (deps.locateSettingsWindow) {
        try {
          const located = await deps.locateSettingsWindow();
          if (located.ok) {
            destination = dockedBounds(located.frame);
            everLocated = true;
            lastDockKey = `${destination.x},${destination.y},${destination.width},${destination.height}`;
          }
        } catch {
          // A locator that throws is a "cannot dock", not a failure to open.
        }
      }
      // `start()` awaited above; the card may have been dismissed meanwhile.
      if (win !== created || created.isDestroyed()) return { ok: true };

      if (canFly) flyTo(created, sourceRect!, destination);
      else created.setBounds(destination);
      beginWatching(id);
      beginDocking(created);
      return { ok: true };
    },

    dismiss(): void {
      teardown();
    },

    isOpen(): boolean {
      return win !== null && !win.isDestroyed();
    },

    activePermission(): DragGrantPermissionId | null {
      return active;
    },
  };
}
