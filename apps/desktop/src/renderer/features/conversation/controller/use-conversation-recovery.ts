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

import { useEffect, useEffectEvent } from 'react';
import type { SessionSummary } from '@maka/core/session';
import { sessionExpectsEventStream, type SessionEventStreamSnapshot } from '@maka/core/session-event-health';
import { evaluateSessionEventStreamSnapshot } from '../../../application/contracts/session-catalog/session-event-health.js';
import { mergeShellRunNotification, mergeShellRunUpdates, ShellRunHydration, type ShellRunUpdatesBySession } from '../../../application/contracts/shell-run-update-state.js';
import type { ConversationObservationServices } from '../transcript-ports.js';
type RefBox<T> = { current: T };
type SessionEventHealthUpdater = (updater: (current: Record<string, SessionEventStreamSnapshot>) => Record<string, SessionEventStreamSnapshot>) => void;
export function useShellRunUpdates(options: {
  services: ConversationObservationServices;
  activeId: string | undefined;
  hydrate?: boolean;
  setShellRunUpdatesBySession: (updater: (current: ShellRunUpdatesBySession) => ShellRunUpdatesBySession) => void;
}) {
  const applyUpdates = useEffectEvent(
    (sessionId: string, updates: Awaited<ReturnType<ConversationObservationServices['shellRuns']['list']>>) => {
    options.setShellRunUpdatesBySession((current) => {
      const active = current[sessionId];
      const retained = active ? { [sessionId]: active } : {};
      return mergeShellRunUpdates(
        retained,
        updates.filter((update) => update.sessionId === sessionId),
      );
    });
    },
  );

  useEffect(() => {
    const sessionId = options.activeId;
    options.setShellRunUpdatesBySession((current) => {
      if (!sessionId) return {};
      const active = current[sessionId];
      return active ? { [sessionId]: active } : {};
    });
    if (!sessionId) return;

    let disposed = false;
    let retryTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
    let retryDelayMs = 250;
    const hydration = new ShellRunHydration();
    if (options.hydrate === false) hydration.commit(0);
    const unsubscribe = options.services.shellRuns.subscribeUpdates((update) => {
      if (disposed) return;
      const live = hydration.accept(update);
      if (live) {
        options.setShellRunUpdatesBySession((current) =>
          mergeShellRunNotification(current, sessionId, live),
        );
      }
    });
    const hydrate = (epoch: number) => {
      if (options.hydrate === false) return;
      void options.services.shellRuns
        .list(sessionId)
        .then((updates) => {
          if (disposed) return;
          const buffered = hydration.commit(epoch);
          if (!buffered) return;
          applyUpdates(sessionId, updates);
          retryDelayMs = 250;
          for (const update of buffered.updates) {
            options.setShellRunUpdatesBySession((current) => mergeShellRunNotification(current, sessionId, update));
          }
          if (buffered.overflowed) hydrate(epoch);
        })
        .catch(() => {
          if (disposed || !hydration.isCurrent(epoch)) return;
          retryTimer = globalThis.setTimeout(() => {
            retryTimer = undefined;
            hydrate(epoch);
          }, retryDelayMs);
          retryDelayMs = Math.min(retryDelayMs * 2, 5_000);
        });
    };
    const unsubscribeResync = options.services.shellRuns.subscribeResync((event) => {
      if (disposed || options.hydrate === false || event.sessionId !== sessionId) return;
      const epoch = hydration.begin();
      retryDelayMs = 250;
      if (retryTimer !== undefined) {
        globalThis.clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      hydrate(epoch);
    });
    if (options.hydrate !== false) hydrate(hydration.begin());
    return () => {
      disposed = true;
      if (retryTimer !== undefined) globalThis.clearTimeout(retryTimer);
      unsubscribe();
      unsubscribeResync();
    };
  }, [options.activeId, options.hydrate]);
}

export function useSessionEventHealthPolling(options: {
  services: ConversationObservationServices;
  activeId: string | undefined;
  activeInteraction: { requestId: string } | undefined;
  activeSession: SessionSummary | undefined;
  activeStreamingLive: boolean;
  hasInFlightLiveTools: boolean;
  refreshMessages: (sessionId: string) => Promise<boolean>;
  refreshSessions: () => Promise<unknown>;
  sessionEventHealthBySessionRef: RefBox<Record<string, SessionEventStreamSnapshot>>;
  setSessionEventHealthBySession: SessionEventHealthUpdater;
}) {
  const {
    activeId,
    activeInteraction,
    activeSession,
    activeStreamingLive,
    hasInFlightLiveTools,
    refreshMessages,
    refreshSessions,
    sessionEventHealthBySessionRef,
    setSessionEventHealthBySession,
  } = options;

  useEffect(() => {
    if (!activeId) return;
    const hasLiveActivity = activeStreamingLive || hasInFlightLiveTools || Boolean(activeInteraction);
    const evaluate = () => {
      const result = evaluateSessionEventStreamSnapshot({
        previous: sessionEventHealthBySessionRef.current[activeId],
        now: Date.now(),
        sessionStatus: activeSession?.status,
        hasLiveActivity,
      });
      if (!result.snapshot) return;
      setSessionEventHealthBySession((current) => ({
        ...current,
        [activeId]: result.snapshot!,
      }));
      if (result.shouldRefresh) {
        void refreshSessions();
        void refreshMessages(activeId);
      }
    };
    // #1979: a stream nobody expects has nothing to observe — `evaluate` can only
    // derive `closed` and can never ask for a refresh, and no one renders either
    // field. So an idle session gets no probe at all, not merely a cheaper one.
    // Both inputs to `expected` are deps of this effect, so a session that starts
    // running re-arms on its own; `markSessionEventStreamClosed` still records the
    // closed stream when the subscription itself goes away.
    if (!sessionExpectsEventStream(activeSession?.status, hasLiveActivity)) return;
    evaluate();
    const interval = globalThis.setInterval(evaluate, 5_000);
    const unsubscribeVisible = options.services.subscribeVisible(evaluate);
    return () => {
      globalThis.clearInterval(interval);
      unsubscribeVisible();
    };
  }, [activeId, activeSession?.status, activeStreamingLive, hasInFlightLiveTools, activeInteraction?.requestId]);
}
