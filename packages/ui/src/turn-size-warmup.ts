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
 * Deadline for each chunk's idle slot.
 *
 * `requestIdleCallback` with no timeout promises nothing: it runs when the
 * scheduler finds an idle period, and a thread that stays busy never offers
 * one. That is not a corner case here — the walk is kicked off from the same
 * mount that is rendering the transcript, so it asks for idle time exactly
 * while the renderer is saturated laying out the turns it exists to measure.
 * On a slow enough machine the first chunk simply never runs and the session
 * keeps its 250px placeholder geometry for good, which is the bug the warm-up
 * was written to prevent. Observed directly at 50x CPU throttling: the walk
 * was created and then sat idle indefinitely without forcing a single chunk.
 *
 * A deadline turns "when convenient" into "soon, and no later than this". The
 * whole walk is a handful of chunks, so it still yields to real work first.
 */
const IDLE_CHUNK_DEADLINE_MS = 200;

function defaultScheduler(): WarmupScheduler | undefined {
  if (typeof requestAnimationFrame !== 'function') return undefined;
  return {
    requestIdle: typeof requestIdleCallback === 'function'
      ? (callback) => {
        const id = requestIdleCallback(callback, { timeout: IDLE_CHUNK_DEADLINE_MS });
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
   * Fires once, when the queue has drained and the last chunk has been
   * released — the moment transcript geometry stops moving.
   *
   * The walk is the only thing that knows this. From the outside it looks
   * identical to the idle gap between two chunks: no chunk is forced, and the
   * height holds still until the next one starts. Anything watching from
   * outside therefore has to guess, and guesses both ways — an observer that
   * calls a pause "done" stops early at an intermediate height, and one that
   * waits for quiet longer than a gap can outlive its own budget. Cancelling
   * the walk does not fire it: nothing settled.
   */
  onSettled?: () => void;
}): () => void {
  const scheduler = options.scheduler ?? defaultScheduler();
  if (!scheduler) return () => {};
  const chunkSize = options.chunkSize ?? 16;
  // Bottom-up queue. The live-streaming tail is already forced visible by CSS
  // and grows every frame — leave it alone.
  const queue = Array.from(options.turns())
    .filter((turn) => !turn.hasAttribute('data-live-streaming'))
    .reverse();
  let forcedChunk: WarmupTurnElement[] = [];
  let cancelScheduled: (() => void) | undefined;
  let settled = false;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    options.onSettled?.();
  };

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
      settle();
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
        else settle();
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
