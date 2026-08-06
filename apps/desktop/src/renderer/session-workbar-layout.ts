import { safeLocalStorageGet } from './browser-storage.js';

/**
 * 480 rather than the original 400: the trace tab's overview is a two-column
 * data grid, and at 400 its figures had to be squeezed against their labels
 * before the qualifier column had room. The stored width still wins, so only
 * a reader who never dragged the handle sees the change.
 */
export const SESSION_WORKBAR_DEFAULT_WIDTH = 480;
export const SESSION_WORKBAR_MIN_WIDTH = 320;
export const SESSION_WORKBAR_MAX_WIDTH = 600;
// 'quote' is a transient tab that only exists while a quote side-panel excerpt
// is active; it is never persisted as a default (see readSessionWorkbarTab).
export type SessionWorkbarTab = 'tasks' | 'browser' | 'files' | 'inspector' | 'quote';

/**
 * Seeds `useResizable`'s `defaultSize`. Deliberately unclamped: the hook clamps
 * whatever it is handed against `minSizePx`/`maxSizePx`, so a second clamp here
 * would be a duplicate authority over the bounds.
 *
 * Rounding is a different job, and still ours. `clampSize` bounds without
 * rounding, so a fractional stored value survives hydration and reaches the
 * panel, storage and `aria-valuenow` unchanged until the next drag. Every other
 * way a width enters the app is already integral; this is the one entry point
 * reading a value the app cannot vouch for.
 */
export function readSessionWorkbarWidth(): number {
  const stored = Number(safeLocalStorageGet('maka-session-workbar-width-v1'));
  return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : SESSION_WORKBAR_DEFAULT_WIDTH;
}

export function readSessionWorkbarCollapsed(): boolean {
  const stored = safeLocalStorageGet('maka-session-workbar-collapsed-v1');
  if (stored === 'false') return false;
  if (stored === 'true') return true;
  return true;
}

export function readSessionWorkbarTab(): SessionWorkbarTab {
  const stored = safeLocalStorageGet('maka-session-workbar-tab-v1');
  return stored === 'browser' || stored === 'files' || stored === 'inspector' ? stored : 'tasks';
}
