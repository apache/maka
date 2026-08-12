import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  compensateFillScroll,
  DEFAULT_MOUNT_WINDOW,
  fillMountWindow,
  initialMountWindow,
  reconcileMountWindow,
  type MountWindowState,
  type ViewportMetrics,
} from './progressive-turn-mount.js';
import { prefixHeightFor, type TurnGeometryRecord } from './turn-size-index.js';
import { createBrowserWarmupScheduler, type WarmupScheduler } from './turn-size-warmup.js';

/**
 * React adapter for the #2052 progressive transcript mount.
 *
 * The window is reconciled during render, not in an effect: the first commit
 * after a session switch must already be the small one, or the ~0.35s
 * full-tree commit the issue measured has happened before any effect runs.
 * The render-phase setState below follows React's derived-state pattern and
 * terminates because reconcileMountWindow returns its input by identity once
 * the state agrees with the props.
 *
 * Growing the window happens one idle chunk per commit: the fill effect
 * schedules a single step, the commit for that step re-runs the effect, and
 * the next idle callback continues until start reaches 0. Viewport metrics
 * are read in the idle callback, before React commits the wider window, and
 * the matching layout effect rewrites scrollTop in the same frame as that
 * commit, so the fill never moves what the user is reading (or, within the
 * bottom lock, keeps the transcript pinned).
 */
export function useProgressiveTurnMount(input: {
  sessionId: string | undefined;
  turnIds: readonly string[];
  scrollRef: RefObject<HTMLElement | null>;
  scrollBehavior: ScrollBehavior;
  /** Search navigation target; mounted before use-chat-scroll queries it. */
  targetTurnId?: string;
  /**
   * Turn geometry measured on a previous visit (#2224). When every
   * unmounted turn has a height, the caller renders a prefix spacer
   * instead of letting the document grow during the fill.
   */
  seededGeometry?: TurnGeometryRecord;
  scheduler?: WarmupScheduler;
}): {
  /** Render turns from this index on; 0 means the transcript is complete. */
  start: number;
  /** True once every turn is mounted; gates the turn-size warm-up. */
  filled: boolean;
  /**
   * Height standing in for the unmounted prefix, undefined when any prefix
   * turn lacks a measurement; 0 once the transcript is complete.
   */
  prefixHeight: number | undefined;
  /** Mount a specific turn now and scroll to it once it exists. */
  revealTurn: (turnId: string) => void;
} {
  const config = DEFAULT_MOUNT_WINDOW;
  const [pendingReveal, setPendingReveal] = useState<string | undefined>(undefined);
  const revealId = pendingReveal ?? input.targetTurnId;
  const ensureIndex = revealId === undefined ? undefined : input.turnIds.indexOf(revealId);

  const [mountWindow, setMountWindow] = useState<MountWindowState>(() =>
    initialMountWindow(input.sessionId, input.turnIds.length, config),
  );
  const reconciled = reconcileMountWindow(
    mountWindow,
    { key: input.sessionId, length: input.turnIds.length },
    config,
    ensureIndex,
  );
  if (reconciled !== mountWindow) setMountWindow(reconciled);

  const beforeFillRef = useRef<ViewportMetrics | undefined>(undefined);
  const schedulerRef = useRef<WarmupScheduler | undefined>(undefined);
  if (schedulerRef.current === undefined) {
    schedulerRef.current = input.scheduler ?? createBrowserWarmupScheduler();
  }

  useEffect(() => {
    const scheduler = schedulerRef.current;
    if (!scheduler || reconciled.start === 0) return;
    return scheduler.requestIdle(() => {
      const root = input.scrollRef.current;
      beforeFillRef.current = root
        ? { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight }
        : undefined;
      setMountWindow((current) => fillMountWindow(current, config));
    });
  }, [reconciled.start, reconciled.key, config, input.scrollRef]);

  useLayoutEffect(() => {
    const before = beforeFillRef.current;
    beforeFillRef.current = undefined;
    if (!before) return;
    const root = input.scrollRef.current;
    if (!root) return;
    root.scrollTop = compensateFillScroll(before, root.scrollHeight).scrollTop;
  }, [reconciled.start, input.scrollRef]);

  // Fill progress published the way the warm-up publishes its own terminal
  // state (data-turn-warmup): tests and tooling can wait on the fill's real
  // boundary instead of guessing at idle timing.
  useEffect(() => {
    const root = input.scrollRef.current;
    if (!root) return;
    root.dataset.progressiveFill = reconciled.start === 0 ? 'complete' : 'filling';
    return () => {
      delete root.dataset.progressiveFill;
    };
  }, [reconciled.start, input.scrollRef]);

  // A reveal request is served across two commits: the render above widens
  // the window through ensureIndex, and once the element exists this effect
  // performs the scroll the rail could not (its querySelector found nothing).
  useEffect(() => {
    if (!pendingReveal) return;
    const root = input.scrollRef.current;
    const element = root?.querySelector(`[data-turn-id="${CSS.escape(pendingReveal)}"]`);
    if (element && 'scrollIntoView' in element) {
      (element as HTMLElement).scrollIntoView({ behavior: input.scrollBehavior, block: 'start' });
      setPendingReveal(undefined);
    }
  }, [pendingReveal, reconciled.start, input.scrollBehavior, input.scrollRef]);

  const revealTurn = useCallback((turnId: string) => {
    setPendingReveal(turnId);
  }, []);

  return {
    start: reconciled.start,
    filled: reconciled.start === 0,
    prefixHeight: prefixHeightFor(input.turnIds, reconciled.start, input.seededGeometry),
    revealTurn,
  };
}
