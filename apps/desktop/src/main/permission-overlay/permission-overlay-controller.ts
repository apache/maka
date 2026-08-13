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
 * Stage 1 (see docs/permission-onboarding-plan.md) is deliberately pure
 * Electron. The card is anchored to the cursor rather than docked to the
 * System Settings window, because locating a foreign window needs
 * `CGWindowListCopyWindowInfo` and therefore native code. Everything
 * else — the panel window, the drag, the poll — is stock, so Stage 1
 * ships without touching the build. Stage 2 adds the locator and docks.
 *
 * Every dependency is injected so the state machine is testable under
 * `node --test` with no Electron runtime and no real timers.
 */

import type { DragGrantPermissionId } from '@maka/core/capabilities';
import { isDragGrantPermissionId } from '@maka/core/capabilities';

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

export async function startScreenRecordingOnboarding<RequestResult extends { ok: boolean }>(deps: {
  requestAccess(): Promise<RequestResult>;
  isGranted(): boolean;
  startDrag(): Promise<OverlayStartResult>;
}): Promise<RequestResult | OverlayStartResult> {
  const requested = await deps.requestAccess();
  if (!requested.ok || deps.isGranted()) return requested;
  return deps.startDrag();
}

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
  /** Work area of the display the card should appear on. */
  getAnchor(): { x: number; y: number; workArea: { x: number; y: number; width: number; height: number } };
  openSystemSettings(id: DragGrantPermissionId): Promise<{ ok: boolean; message?: string }>;
  /** Non-prompting read of the current grant state. */
  isGranted(id: DragGrantPermissionId): boolean;
  setInterval(fn: () => void, ms: number): NodeJS.Timeout;
  clearInterval(handle: NodeJS.Timeout): void;
  setTimeout(fn: () => void, ms: number): NodeJS.Timeout;
  clearTimeout(handle: NodeJS.Timeout): void;
  /** Payload the card renders (app icon + name + copy). */
  buildCardPayload(id: DragGrantPermissionId): unknown;
  onGranted?(id: DragGrantPermissionId): void;
  log?(message: string): void;
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

export interface PermissionOverlayController {
  start(id: unknown): Promise<OverlayStartResult>;
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

  function stopTimers(): void {
    if (poll) { deps.clearInterval(poll); poll = null; }
    if (giveUp) { deps.clearTimeout(giveUp); giveUp = null; }
    if (closing) { deps.clearTimeout(closing); closing = null; }
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
    async start(id: unknown): Promise<OverlayStartResult> {
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
      const created = deps.createWindow(cardBounds());
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
      beginWatching(id);
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
