/**
 * Windowing decisions for progressively mounting a transcript (#2052).
 *
 * Switching back to a long session used to mount every turn in one React
 * commit, and the intrinsic cost of inserting ~22k nodes at once is a single
 * ~0.35s frame. The fix mounts only a tail window in that first commit and
 * grows the window upward during idle time. This module is the pure half:
 * the window arithmetic and the scroll compensation, with no React and no
 * DOM, so the decisions are testable the same way turn-size-warmup is.
 *
 * The window is described by `start`, the index of the first mounted turn.
 * Everything from `start` to the end is mounted, so the live tail is always
 * visible and turns appended while streaming never pass through the window
 * logic at all.
 */

export interface MountWindowState {
  /** Identity of the transcript the window belongs to (session id). */
  readonly key: string | undefined;
  /** Turn count the window was last reconciled against. */
  readonly length: number;
  /** Index of the first mounted turn; 0 means fully mounted. */
  readonly start: number;
}

export interface MountWindowConfig {
  /** Turns mounted in the first commit after a switch. */
  readonly initialWindow: number;
  /** Turns added per idle fill step. */
  readonly fillChunk: number;
}

export const DEFAULT_MOUNT_WINDOW: MountWindowConfig = {
  // A 2-turn transcript commits in 17-25ms per the issue's measurements, so
  // a tail of this size stays well under one 120Hz frame budget while still
  // filling the viewport on ordinary window heights.
  initialWindow: 10,
  // Small enough that a fill step cannot become its own long frame, large
  // enough that a 30-turn session finishes filling within a handful of idle
  // callbacks.
  fillChunk: 4,
};

function tailStart(length: number, config: MountWindowConfig): number {
  return Math.max(0, length - config.initialWindow);
}

/** The window a transcript starts with: its tail, before any fill has run. */
export function initialMountWindow(
  key: string | undefined,
  length: number,
  config: MountWindowConfig,
): MountWindowState {
  return { key, length, start: tailStart(length, config) };
}

/**
 * Decide the window for the next render. Returns `state` unchanged (same
 * reference) when nothing has to move, so a render-phase caller can compare
 * by identity and avoid a re-render loop.
 *
 * Three situations re-window to the tail:
 * - the key changed: this is the session switch the issue measured;
 * - the turn count jumped by more than one window in a single render: the
 *   same full-tree commit arrives through message loading and revision
 *   navigation without a key change, so a bulk arrival is treated like a
 *   switch;
 * - the count shrank to or below the window start: `turns.slice(start)` with
 *   start at or past the end renders an empty transcript.
 * A growing transcript otherwise keeps its start: streaming appends land in
 * the mounted tail.
 */
export function reconcileMountWindow(
  state: MountWindowState,
  next: { key: string | undefined; length: number },
  config: MountWindowConfig,
  ensureIndex?: number,
): MountWindowState {
  let start = state.start;
  if (state.key !== next.key || next.length - state.length > config.initialWindow) {
    start = tailStart(next.length, config);
  } else if (start >= next.length && next.length > 0) {
    start = tailStart(next.length, config);
  }
  if (ensureIndex !== undefined && ensureIndex >= 0 && ensureIndex < start) {
    start = ensureIndex;
  }
  if (start === state.start && state.key === next.key && state.length === next.length) {
    return state;
  }
  return { key: next.key, length: next.length, start };
}

/** One idle fill step: move the window up by a chunk. */
export function fillMountWindow(state: MountWindowState, config: MountWindowConfig): MountWindowState {
  if (state.start === 0) return state;
  return { ...state, start: Math.max(0, state.start - config.fillChunk) };
}

export interface ViewportMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Scroll compensation for a fill commit. Mounting turns above the viewport
 * grows the scroller upward; without compensation the content the user is
 * reading slides down by the inserted height.
 *
 * Inside Astryx's 10px bottom-lock threshold the answer is to stay pinned,
 * matching the warm-up's own finishing rule in use-chat-scroll; anywhere
 * else the previous scroll offset is preserved by adding the height delta.
 */
export function compensateFillScroll(
  before: ViewportMetrics,
  afterScrollHeight: number,
): { pin: boolean; scrollTop: number } {
  const distanceFromBottom = before.scrollHeight - before.scrollTop - before.clientHeight;
  if (distanceFromBottom <= 10) {
    return { pin: true, scrollTop: afterScrollHeight };
  }
  return { pin: false, scrollTop: before.scrollTop + (afterScrollHeight - before.scrollHeight) };
}
