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

import { useRef, useState } from 'react';
import type { StoredMessage } from '@maka/core/session';
import { type LiveTurnProjection, useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  mergeSessionSummaryListForDisplay,
  normalizeSessionSummaryForDisplay,
} from './session-status-presentation';
import {
  applyLocalSessionRead,
  applySessionReadOverrides,
  createSessionListRefresher,
  type SessionListRefresher,
  type SessionReadBoundaries,
} from './session-read-state';
import { reconcileSettledSessionTransients } from './settled-session-transients.js';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

type RefBox<T> = { current: T };

export function useAppShellSessionList(
  toastApi: ToastApi,
  options: {
    activeIdRef: RefBox<string | undefined>;
    liveTurnBySessionRef: RefBox<Record<string, LiveTurnProjection>>;
    clearTurnTransientStateIfCurrent: (
      sessionId: string,
      expected: LiveTurnProjection | undefined,
    ) => void;
  },
) {
  const uiLocale = useUiLocale();
  const uiLocaleRef = useRef(uiLocale);
  uiLocaleRef.current = uiLocale;
  const [sessions, setSessionsState] = useState<DesktopSessionSummary[]>([]);
  const [authoritativeSessionIds, setAuthoritativeSessionIds] =
    useState<ReadonlySet<string> | null>(null);
  const sessionsRef = useRef<DesktopSessionSummary[]>([]);
  const sessionReadBoundariesRef = useRef<SessionReadBoundaries>({});
  const refresherRef = useRef<SessionListRefresher<DesktopSessionSummary> | null>(null);

  function commitSessions(next: DesktopSessionSummary[]): void {
    sessionsRef.current = next;
    setSessionsState(next);
  }

  function setSessions(
    updater: (current: DesktopSessionSummary[]) => DesktopSessionSummary[],
  ): void {
    setSessionsState((current) => {
      const next = mergeSessionSummaryListForDisplay(current, updater(current));
      sessionsRef.current = next;
      return next;
    });
  }

  if (!refresherRef.current) {
    refresherRef.current = createSessionListRefresher({
      captureRequestContext: () => options.liveTurnBySessionRef.current,
      listSessions: () => window.maka.sessions.list(),
      readBoundaries: () => sessionReadBoundariesRef.current,
      currentSessions: () => sessionsRef.current,
      commitSessions: (next, observedLiveTurnBySession) => {
        const normalized = next.map(normalizeSessionSummaryForDisplay);
        reconcileSettledSessionTransients({
          activeId: options.activeIdRef.current,
          sessions: normalized,
          observedLiveTurnBySession,
          clearTurnTransientStateIfCurrent: options.clearTurnTransientStateIfCurrent,
        });
        commitSessions(normalized);
        setAuthoritativeSessionIds(new Set(normalized.map(({ id }) => id)));
      },
      onError: (error) => {
        const locale = uiLocaleRef.current;
        const copy = getDesktopConversationCopy(locale).actions;
        toastApi.error(
          copy.refreshSessionsFailedTitle,
          localizedShellErrorMessage(error, copy.refreshSessionsFailedFallback, locale),
        );
      },
    });
  }

  async function refreshSessions(): Promise<DesktopSessionSummary[]> {
    return refresherRef.current!.refresh();
  }

  function seedSessions(
    snapshotSessions: readonly DesktopSessionSummary[],
  ): DesktopSessionSummary[] {
    const next = applySessionReadOverrides([...snapshotSessions], sessionReadBoundariesRef.current)
      .map(normalizeSessionSummaryForDisplay);
    commitSessions(next);
    return next;
  }

  function upsertSessionSummary(session: DesktopSessionSummary): void {
    setSessions((current) => [
      normalizeSessionSummaryForDisplay(session),
      ...current.filter((entry) => entry.id !== session.id),
    ]);
  }

  function markSessionReadLocally(sessionId: string, readMessages: readonly StoredMessage[]): void {
    setSessions((current) => applyLocalSessionRead(
      sessionReadBoundariesRef.current,
      current,
      sessionId,
      readMessages,
    ));
  }

  return {
    sessions,
    authoritativeSessionIds,
    sessionsRef,
    setSessions,
    refreshSessions,
    seedSessions,
    upsertSessionSummary,
    markSessionReadLocally,
  };
}
