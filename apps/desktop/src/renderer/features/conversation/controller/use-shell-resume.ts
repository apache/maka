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

import { useEffect, useRef, useState } from 'react';
import type { UiLocale } from '@maka/core/ui-locale';
import { resumeParkToastCopy } from '@maka/ui';
import { localizedShellErrorMessage, type getShellCopy } from '../../../locales/shell-copy.js';
import { createResumeAvailabilityTracker } from '../../../application/contracts/resume-availability.js';
import { useConversationServices } from '../services.js';

type ToastApi = {
  info(title: string, description?: string): void;
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string },
  ): void;
};

/**
 * Owns the #1223 safe-boundary resume cluster — the in-flight
 * `resumePendingSessionId` guard, the per-session parked-diagnostic
 * descriptions, and the `resumeInterruptedSession` handler driving
 * `sessions.resumeLatest` — and, since #5903, `resumeAvailableBySession`: the
 * authoritative answer to "could the latest interrupted Turn resume right
 * now", read from the Host's resume planner (`sessions.queryResumeLatest`)
 * rather than the renderer's banner heuristic. Availability refreshes on
 * session switch and on the tracked session's turn/status boundaries — the
 * only moments the answer can change — and on the click's own outcome.
 *
 * Both consumers get a fully built action so the call sites stay one-line
 * pass-throughs: `safeResumeAction` for the interrupted-Turn banner,
 * `composerResumeAction` for the composer's send-slot offer. Building them
 * here is also what keeps one hook instance behind both — the pending guard
 * is shared, so the banner and the composer button can never race a second
 * resume IPC past the first. The slot also offers Resume for a Turn the user
 * just stopped (#5923): it only renders after a fresh `ready` answer, which
 * requires the stop's terminal transition to have completed.
 *
 * `activeId` is the displayed session (what the pending/detail/gating reads
 * key on); `ownerActiveId` is what the handler snapshots and what
 * availability tracks, so a session switch mid-resume settles the ORIGINAL
 * session's flags. The Guest fork of the composer props never picks
 * `resumeAction` up (guestComposerProps chooses its keys), so the composer
 * offer needs no shared-session gate of its own.
 */
export function useShellResume(options: {
  activeId: string | undefined;
  ownerActiveId: string | undefined;
  sharedSessionActive: boolean;
  toastApi: ToastApi;
  shellCopy: ReturnType<typeof getShellCopy>['app'];
  uiLocale: UiLocale;
}): {
  safeResumeAction: { pending: boolean; detail: string | undefined; onResume(): void } | undefined;
  composerResumeAction: { pending: boolean; onResume(): void } | undefined;
} {
  const { activeId, ownerActiveId, sharedSessionActive, toastApi, shellCopy, uiLocale } = options;
  const services = useConversationServices();
  const [resumePendingSessionId, setResumePendingSessionId] = useState<string | null>(null);
  const [resumeParkDescriptionBySession, setResumeParkDescriptionBySession] = useState<Record<string, string>>({});
  const [resumeAvailableBySession, setResumeAvailableBySession] = useState<Record<string, boolean>>({});
  const ownerActiveIdRef = useRef(ownerActiveId);
  ownerActiveIdRef.current = ownerActiveId;
  const trackerRef = useRef<ReturnType<typeof createResumeAvailabilityTracker> | null>(null);
  if (trackerRef.current === null) {
    trackerRef.current = createResumeAvailabilityTracker({
      query: (sessionId) => services.resume.queryPlan(sessionId),
      onAvailability: (sessionId, available) => {
        setResumeAvailableBySession((current) =>
          current[sessionId] === available ? current : { ...current, [sessionId]: available },
        );
      },
    });
  }
  const tracker = trackerRef.current;

  // A session switch re-reads the offer for the session being opened; a stale
  // answer for the session left behind is keyed by id and cannot bleed across.
  useEffect(() => {
    if (ownerActiveId === undefined) return;
    tracker.request(ownerActiveId);
  }, [ownerActiveId, tracker]);

  // Turn and status boundaries of the tracked session are the only moments
  // the answer can change: a turn starting makes the session busy, a turn
  // ending interrupted is what creates a resumable candidate at all. A Host
  // rebound can invalidate the previous answer just as much, so it re-reads
  // too — the tracker retracts the stale offer while the fresh read flies.
  useEffect(() => {
    return services.resume.subscribeChanges((event) => {
      const current = ownerActiveIdRef.current;
      if (current === undefined || event.sessionId !== current) return;
      if (
        event.reason !== 'turn-status-change' &&
        event.reason !== 'status-change' &&
        event.reason !== 'rebound'
      ) {
        return;
      }
      tracker.request(current);
    });
  }, [services, tracker]);

  async function resumeInterruptedSession(): Promise<void> {
    const sessionId = ownerActiveId;
    if (!sessionId || resumePendingSessionId !== null) return;
    setResumePendingSessionId(sessionId);
    try {
      const result = await services.resume.start(sessionId);
      if (result.disposition === 'park') {
        tracker.settle(sessionId, false);
        const parkCopy = resumeParkToastCopy(result.rejectionReasons, uiLocale);
        setResumeParkDescriptionBySession((current) => ({
          ...current,
          [sessionId]: parkCopy.description,
        }));
        toastApi.error(parkCopy.title, parkCopy.description, undefined, { sessionId });
      } else {
        // The resumed Turn is starting now, so the offer is gone even before
        // the status events re-read it as busy.
        tracker.settle(sessionId, false);
        setResumeParkDescriptionBySession((current) => {
          const { [sessionId]: _removed, ...remaining } = current;
          void _removed;
          return remaining;
        });
        toastApi.info(shellCopy.resumeStartedTitle, shellCopy.resumeStartedDescription);
      }
    } catch (error) {
      toastApi.error(
        shellCopy.resumeFailedTitle,
        localizedShellErrorMessage(
          error,
          shellCopy.resumeFailedFallback,
          uiLocale,
        ),
        undefined,
        { sessionId },
      );
    } finally {
      setResumePendingSessionId((current) => current === sessionId ? null : current);
    }
  }

  const safeResumeAction = !sharedSessionActive && activeId
    ? {
        pending: resumePendingSessionId === activeId,
        detail: resumeParkDescriptionBySession[activeId],
        onResume: () => { void resumeInterruptedSession(); },
      }
    : undefined;
  const composerResumeAction = activeId && resumeAvailableBySession[activeId]
    ? {
        pending: resumePendingSessionId === activeId,
        onResume: () => { void resumeInterruptedSession(); },
      }
    : undefined;

  return { safeResumeAction, composerResumeAction };
}
