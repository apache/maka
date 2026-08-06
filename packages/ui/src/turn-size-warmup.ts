/**
 * Chunked, bottom-up warm-up for `content-visibility: auto` chat turns.
 *
 * Off-screen turns are render-skipped and occupy only the
 * `contain-intrinsic-size: auto 250px` placeholder until first rendered, so a
 * long session's scroll geometry is badly underestimated. Scrolling up then
 * inflates each turn from 250px to its real height; scroll anchoring
 * compensates and the top keeps receding ("endless scroll"). Rendering every
 * turn once records its last remembered size (the `auto` keyword), after which
 * the geometry stays exact for the life of the DOM node.
 *
 * The walk is chunked over idle time (no one-shot full-history layout jank)
 * and runs bottom-up: the user starts pinned at the bottom, so true sizes are
 * laid down in the direction they will scroll.
 */

export interface WarmupTurnElement {
  readonly isConnected: boolean;
  hasAttribute(qualifiedName: string): boolean;
  readonly style: { contentVisibility: string; contain: string };
}

export interface WarmupScheduler {
  /** Schedule work for idle time; returns a cancel function. */
  requestIdle(callback: () => void): () => void;
  /** Schedule work at the next rendering opportunity; returns a cancel function. */
  requestFrame(callback: () => void): () => void;
}

/**
 * Upper bound on how long idle-chunked work (turn-size warm-up, progressive
 * transcript fill) may wait for a free main-thread slice. Without a deadline,
 * bare `requestIdleCallback` can starve under sustained layout/paint load —
 * CI observed a 90-turn fill stuck mid-window for >10s while the count still
 * crept up four at a time. The timeout forces each step to run even when the
 * browser never reports idle; when the thread is free, rIC still fires early.
 *
 * 100ms is long enough not to stampede short frames under light load, and
 * short enough that a 20-step fill of a long session still completes in a
 * couple of seconds of worst-case scheduling alone.
 */
const BROWSER_IDLE_TIMEOUT_MS = 100;

/**
 * Default browser scheduler shared by warm-up and progressive mount. Returns
 * `undefined` when `requestAnimationFrame` is missing (SSR / no window).
 */
export function createBrowserWarmupScheduler(): WarmupScheduler | undefined {
  if (typeof requestAnimationFrame !== 'function') return undefined;
  return {
    requestIdle: typeof requestIdleCallback === 'function'
      ? (callback) => {
        const id = requestIdleCallback(callback, { timeout: BROWSER_IDLE_TIMEOUT_MS });
        return () => cancelIdleCallback(id);
      }
      : (callback) => {
        const id = setTimeout(callback, 1);
        return () => clearTimeout(id);
      },
    requestFrame: (callback) => {
      const id = requestAnimationFrame(callback);
      return () => cancelAnimationFrame(id);
    },
  };
}

export function createTurnSizeWarmup(options: {
  turns: () => ArrayLike<WarmupTurnElement>;
  chunkSize?: number;
  scheduler?: WarmupScheduler;
  /**
   * The moment this walk is done: the queue has drained and the last chunk has
   * been released.
   *
   * Scoped to the turns `turns()` returned when the walk was created — the
   * queue is snapshotted once, below. A turn that appears afterwards is not
   * walked and does not hold this back, so this says "every turn I was given
   * has its final-layout size", not "the transcript will never move again".
   * Warming a growing transcript would need a walk per batch, which nothing
   * asks for: turns that arrive later arrive rendered.
   *
   * The walk is the only thing that knows this. From outside, the end looks
   * exactly like the idle gap between two chunks — no chunk is forced, and the
   * height holds still until the next one starts — so an outside observer has
   * to guess, and guesses wrong both ways: calling a gap "done" reports an
   * intermediate height, and waiting out a gap that never ends outlives its own
   * budget. Both were observed against this module's own E2E.
   *
   * Fires exactly once per walk, by control flow rather than by a flag: the two
   * terminal paths below — a queue that drained with nothing live left in it,
   * and the release of the last chunk — are mutually exclusive within a step,
   * and neither schedules further work. Cancelling reaches neither: nothing
   * settled.
   */
  onSettled?: () => void;
}): () => void {
  const scheduler = options.scheduler ?? createBrowserWarmupScheduler();
  if (!scheduler) return () => {};
  const chunkSize = options.chunkSize ?? 16;
  // Bottom-up queue. The live-streaming tail is already forced visible by CSS
  // and grows every frame, so leave it alone. Seeded turns (#2224) carry a
  // measured intrinsic size from a previous visit, so their placeholder is
  // already the real height and there is nothing left for the walk to learn.
  // If a turn's content changed between visits (a late image, an edit), its
  // seed is stale until the turn scrolls into view and renders; that error is
  // bounded to the changed turns and self-heals, which is the trade taken for
  // skipping their forced render here.
  const queue = Array.from(options.turns())
    .filter((turn) => !turn.hasAttribute('data-live-streaming') && !turn.hasAttribute('data-size-seeded'))
    .reverse();
  let forcedChunk: WarmupTurnElement[] = [];
  let cancelScheduled: (() => void) | undefined;

  const release = (): void => {
    for (const turn of forcedChunk) {
      turn.style.contentVisibility = '';
      turn.style.contain = '';
    }
    forcedChunk = [];
  };

  const step = (): void => {
    let chunk: WarmupTurnElement[] = [];
    while (chunk.length === 0 && queue.length > 0) {
      chunk = queue.splice(0, chunkSize).filter((turn) => turn.isConnected);
    }
    if (chunk.length === 0) {
      options.onSettled?.();
      return;
    }
    forcedChunk = chunk;
    for (const turn of forcedChunk) {
      turn.style.contentVisibility = 'visible';
      // `content-visibility: auto` keeps layout/style/paint containment even
      // while an element is on screen; a bare `visible` drops it, and the
      // containment difference shifts layout by a few pixels per turn. The
      // remembered size must be measured under the SAME containment the turn
      // will have when it later scrolls into view, or every arrival corrects
      // the height and the scrollbar drifts.
      turn.style.contain = 'layout style paint';
    }
    // Hold the forced styles across one full rendering opportunity: the first
    // frame callback fires before the layout that renders the chunk (and
    // records its remembered sizes), so release on the following frame.
    cancelScheduled = scheduler.requestFrame(() => {
      cancelScheduled = scheduler.requestFrame(() => {
        release();
        if (queue.length > 0) cancelScheduled = scheduler.requestIdle(step);
        else options.onSettled?.();
      });
    });
  };

  cancelScheduled = scheduler.requestIdle(step);
  return () => {
    cancelScheduled?.();
    cancelScheduled = undefined;
    release();
    queue.length = 0;
  };
}
