import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The outcome of one attempt to learn a session's boundary from main.
 *
 * `unreadable` is the fact this read model exists to carry: main was asked,
 * every attempt failed, and the renderer still does not know what the session
 * may do. Without it a failed read is indistinguishable from a read that has
 * not answered yet, and the surface has no honest state to show (#1629).
 */
export type ExecutionBoundaryReadResult =
  | { outcome: 'read'; boundary: ExecutionBoundaryReadModel }
  | { outcome: 'unreadable' }
  | { outcome: 'cancelled' };

/**
 * Delays before each retry of a failed boundary read.
 *
 * Bounded on purpose. A boundary read fails for two very different reasons: a
 * main process that has not finished settling the session yet — which the next
 * attempt fixes — and something actually broken, which no number of attempts
 * fixes. This schedule rides out the first (four reads, with 1.75s of waiting
 * spread between them on top of whatever the reads themselves cost) and then
 * stops, so the second becomes a state the user is told about rather than a
 * poll that runs until the window closes.
 */
export const EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS: readonly number[] = [150, 400, 1200];

/**
 * Read a boundary, retrying a failure on the bounded schedule above.
 *
 * Split out of the hook so the failure path is testable without a renderer:
 * the retry policy is the fix for #1629, so it has to be assertable directly.
 */
export async function readExecutionBoundaryWithRetry(input: {
  read(): Promise<ExecutionBoundaryReadModel>;
  wait(delayMs: number): Promise<void>;
  cancelled(): boolean;
  retryDelaysMs?: readonly number[];
}): Promise<ExecutionBoundaryReadResult> {
  const retryDelaysMs = input.retryDelaysMs ?? EXECUTION_BOUNDARY_READ_RETRY_DELAYS_MS;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    if (input.cancelled()) return { outcome: 'cancelled' };
    try {
      const boundary = await input.read();
      // A read outlives its caller: main answers whenever it answers, and by
      // then the session may have been switched away from. Re-check before
      // claiming a result, or a reply nobody is waiting for any more comes back
      // looking exactly like a live answer.
      return input.cancelled() ? { outcome: 'cancelled' } : { outcome: 'read', boundary };
    } catch {
      // Retried below, or reported as unreadable once the schedule runs out.
    }
    const delayMs = retryDelaysMs[attempt];
    if (delayMs === undefined) break;
    if (input.cancelled()) return { outcome: 'cancelled' };
    await input.wait(delayMs);
  }
  return input.cancelled() ? { outcome: 'cancelled' } : { outcome: 'unreadable' };
}

/**
 * A settled boundary read together with the session it was made for, so a
 * result can never be shown against a different session. `boundary` is
 * `undefined` when the read gave up — the session is known, the answer is not.
 */
export interface ActiveExecutionBoundarySnapshot {
  sessionId: string;
  boundary: ExecutionBoundaryReadModel | undefined;
}

/**
 * The boundary belonging to `activeSessionId`, or `undefined` while none has
 * been read for it yet. Fails closed on session switches without needing an
 * explicit clear: a snapshot for another session simply does not match.
 */
export function activeExecutionBoundaryOf(
  snapshot: ActiveExecutionBoundarySnapshot | undefined,
  activeSessionId: string | undefined,
): ExecutionBoundaryReadModel | undefined {
  if (!activeSessionId || snapshot?.sessionId !== activeSessionId) return undefined;
  return snapshot.boundary;
}

/**
 * Whether the boundary read for `activeSessionId` ran out of attempts.
 *
 * The boundary alone cannot say this: "still reading" and "asked and failed"
 * are both `undefined`, and only the second one is something to tell the user.
 */
export function activeExecutionBoundaryUnreadable(
  snapshot: ActiveExecutionBoundarySnapshot | undefined,
  activeSessionId: string | undefined,
): boolean {
  if (!activeSessionId || snapshot?.sessionId !== activeSessionId) return false;
  return snapshot.boundary === undefined;
}

/** Where a settled read writes back. Both come straight from `useState`. */
export interface ActiveExecutionBoundaryReadCommit {
  setReading(reading: boolean): void;
  setSnapshot(snapshot: ActiveExecutionBoundarySnapshot): void;
}

/**
 * Start one generation of the boundary read and return the call that retires
 * it. Only a generation that has not been retired may commit.
 *
 * That invariant is the whole reason this is a named function rather than an
 * effect body. A read for session A can still be in flight when the user opens
 * B; A's reply arrives later and, uncontrolled, overwrites B's snapshot with
 * A's. The snapshot then names a session that is not active, which reads as
 * "boundary unknown, and no failure to report" — the exact dead end #1629 is
 * about, this time with nothing left in flight to recover from it. The same
 * race puts a superseded revision back on screen after a `reload()`.
 *
 * The generation token is the `cancelled` flag closed over below: React runs a
 * cleanup before the next effect body, so one flag per call is already one flag
 * per generation, and no separate counter would say anything more.
 */
export function startActiveExecutionBoundaryRead(input: {
  sessionId: string;
  read(sessionId: string): Promise<ExecutionBoundaryReadModel>;
  commit: ActiveExecutionBoundaryReadCommit;
  retryDelaysMs?: readonly number[];
}): () => void {
  let cancelled = false;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseWait: (() => void) | undefined;
  void readExecutionBoundaryWithRetry({
    read: () => input.read(input.sessionId),
    // Released on cancel so a retired generation does not sit out the rest of a
    // backoff before the loop notices.
    wait: (delayMs) =>
      new Promise<void>((resolve) => {
        releaseWait = resolve;
        waitTimer = setTimeout(resolve, delayMs);
      }),
    cancelled: () => cancelled,
    retryDelaysMs: input.retryDelaysMs,
  }).then((result) => {
    // The read's own re-check is the whole boundary, and it is enough. A
    // retirement reaches this generation from exactly one place — React's
    // effect cleanup — which runs from the scheduler, never from the microtask
    // drain between the read resolving and this callback. Another reply
    // landing in that drain can only queue a React update behind this callback,
    // not ahead of it.
    if (result.outcome === 'cancelled') return;
    input.commit.setReading(false);
    input.commit.setSnapshot({
      sessionId: input.sessionId,
      boundary: result.outcome === 'read' ? result.boundary : undefined,
    });
  });
  return () => {
    cancelled = true;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    releaseWait?.();
  };
}

/**
 * The desktop's read model for the active session's execution boundary — the
 * one place that decides when the renderer's copy of the boundary is stale.
 *
 * The boundary is main-process authority, so an Effect synchronising with it is
 * the right tool; what this hook must never become is a mirror of renderer
 * state. It therefore keeps exactly one fact (the last settled read from main)
 * and re-reads on the two events that can change it: the active session
 * changing, and a caller reporting that a boundary decision settled (#1611).
 *
 * Before #1611 the surface displayed every managed boundary as Auto, so a stale
 * snapshot was invisible. Now that the label reports what the session may
 * actually do, staleness would be an active false statement about permissions:
 * a read-only session that has just been granted write access would keep
 * showing "read only". Approving an expansion only bumps the boundary's
 * revision — no session field changes — so nothing else here can notice it.
 *
 * #1629: a failed read used to be swallowed, leaving the snapshot unset for
 * good. Nothing here re-fires on its own, so the surface fell closed
 * permanently and the composer never came back. A failed read is now retried on
 * a bounded schedule and, when that runs out, reported as `unreadable` so the
 * surface can say so and offer another attempt. Every read runs as a generation
 * that only commits while it is still the current one — see
 * `startActiveExecutionBoundaryRead` for why a late reply is the same bug.
 */
export function useActiveExecutionBoundary(
  activeSessionId: string | undefined,
  /** Re-read when the session's stored permission mode changes under us. */
  permissionMode: string | undefined,
): {
  boundary: ExecutionBoundaryReadModel | undefined;
  /** The read for this session ran out of attempts; the boundary is unknown. */
  unreadable: boolean;
  /** A read for this session is in flight. */
  reading: boolean;
  /** Report that this session's boundary may have changed; re-reads authority. */
  reload(sessionId: string): void;
} {
  const [snapshot, setSnapshot] = useState<ActiveExecutionBoundarySnapshot | undefined>();
  const [reading, setReading] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    // Armed synchronously by every generation and cleared only by one that is
    // still current, so `reading` needs no generation of its own: a retired
    // read can no longer report the newest one as finished.
    setReading(activeSessionId !== undefined);
    if (!activeSessionId) return;
    return startActiveExecutionBoundaryRead({
      sessionId: activeSessionId,
      read: (sessionId) => window.maka.sessions.readExecutionBoundary(sessionId),
      commit: { setReading, setSnapshot },
    });
  }, [activeSessionId, permissionMode, reloadNonce]);

  const reload = useCallback((sessionId: string) => {
    // Only the active session is read here, so a decision settled on any other
    // session has nothing to refresh. This is also the user's way out of an
    // unreadable boundary: the settled read is left in place, so a re-read that
    // succeeds replaces it and one that fails leaves the notice where it was.
    if (activeSessionIdRef.current !== sessionId) return;
    setReloadNonce((nonce) => nonce + 1);
  }, []);

  return {
    boundary: activeExecutionBoundaryOf(snapshot, activeSessionId),
    unreadable: activeExecutionBoundaryUnreadable(snapshot, activeSessionId),
    reading,
    reload,
  };
}
