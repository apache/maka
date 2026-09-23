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

import type { ExecutionBoundaryReadModel } from '@maka/core/sandbox-boundary';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseDesktopSessionKey } from '../../../../shared/runtime-host-identity.js';
import { useConversationServices } from '../services.js';

/**
 * A settled boundary read together with the session it was made for, so a
 * result can never be shown against a different session. `boundary` is
 * `undefined` when the read failed — the session is known, the answer is not.
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
 * Whether the boundary read for `activeSessionId` failed.
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
}): () => void {
  let cancelled = false;
  void input.read(input.sessionId).then(
    (boundary) => boundary,
    () => undefined,
  ).then((boundary) => {
    // A retirement reaches this generation from exactly one place — React's
    // effect cleanup — which runs from the scheduler, never from the microtask
    // drain between the read settling and this callback.
    if (cancelled) return;
    input.commit.setReading(false);
    input.commit.setSnapshot({ sessionId: input.sessionId, boundary });
  });
  return () => {
    cancelled = true;
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
 * permanently and the composer never came back. A failed read is now reported
 * as `unreadable` so the surface can say so and offer another attempt. It is
 * not retried on a timer: the IPC gate already waits for a Host that is still
 * starting or reconnecting. What the gate cannot cover is a Host generation
 * that is replaced or fails under the read, so the boundary is read again
 * whenever the session's Host reports ready.
 * Every read runs as a generation that only commits while it is still the
 * current one — see `startActiveExecutionBoundaryRead` for why a late reply is
 * the same bug.
 */
export function useActiveExecutionBoundary(
  activeSessionId: string | undefined,
  /** Re-read when the session's stored permission mode changes under us. */
  permissionMode: string | undefined,
): {
  boundary: ExecutionBoundaryReadModel | undefined;
  /** The read for this session failed; the boundary is unknown. */
  unreadable: boolean;
  /** A read for this session is in flight. */
  reading: boolean;
  /** Report that this session's boundary may have changed; re-reads authority. */
  reload(sessionId: string): void;
} {
  const services = useConversationServices();
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
      read: (sessionId) => services.sessions.readExecutionBoundary(sessionId),
      commit: { setReading, setSnapshot },
    });
  }, [services, activeSessionId, permissionMode, reloadNonce]);

  useEffect(() => {
    if (!activeSessionId) return;
    const { hostId } = parseDesktopSessionKey(activeSessionId);
    // Not gated on `unreadable`: the ready push can arrive before a read on the
    // replaced generation fails, and a listener armed only after that failure
    // would never hear it.
    return services.runtimeHosts.subscribeChanges((event) => {
      if (event.readiness === 'ready' && event.hostId === hostId) {
        setReloadNonce((nonce) => nonce + 1);
      }
    });
  }, [services, activeSessionId]);

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
