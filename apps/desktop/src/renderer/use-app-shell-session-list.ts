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

import { useCallback, useRef } from 'react';
import { type LiveTurnProjection, useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  normalizeSessionSummaryForDisplay,
} from './session-status-presentation.js';
import {
  createSessionListRefresher,
  type SessionListRefresher,
} from './session-read-state.js';
import { reconcileSettledSessionTransients } from './settled-session-transients.js';
import {
  selectAuthoritativeSessionIds,
  selectCatalogRevision,
  selectSessions,
  type SessionCatalogController,
} from './session-catalog-state.js';
import { sessionIdSetsEqual } from './live-turn-snapshot.js';
import { useExternalStoreSelector } from './use-external-store-selector.js';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

type RefBox<T> = { current: T };

export function useAppShellSessionList(
  toastApi: ToastApi,
  options: {
    catalog: SessionCatalogController;
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
  const { catalog } = options;
  // Selected from the catalog store rather than held here: the rail follows the
  // same authority without the shell carrying it down a prop chain (#4109).
  const sessions = useExternalStoreSelector(catalog, selectSessions);
  const catalogRevision = useExternalStoreSelector(catalog, selectCatalogRevision);
  const authoritativeSessionIds = useExternalStoreSelector(
    catalog,
    selectAuthoritativeSessionIds,
    undefined,
    sessionIdSetsEqual,
  );
  const sessionsRef = useRef<DesktopSessionSummary[]>([]);
  const refresherRef = useRef<SessionListRefresher<DesktopSessionSummary> | null>(null);

  function commitSessions(next: DesktopSessionSummary[]): void {
    sessionsRef.current = next;
    catalog.commitSessions(next);
  }

  if (!refresherRef.current) {
    refresherRef.current = createSessionListRefresher({
      captureRequestContext: () => options.liveTurnBySessionRef.current,
      listSessions: () => window.maka.sessions.list(),
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

  // Fixed identities for the renderer's lifetime: both close over ref boxes and
  // a state setter only, and consumers list them in dep arrays and hand them
  // down as props (see `session-workspace-actions.ts`).
  const actionsRef = useRef<{
    refreshSessions(): Promise<DesktopSessionSummary[]>;
    seedSessions(
      snapshotSessions: readonly DesktopSessionSummary[],
    ): DesktopSessionSummary[];
  } | null>(null);
  actionsRef.current ??= {
    async refreshSessions() {
      return refresherRef.current!.refresh();
    },
    seedSessions(snapshotSessions) {
      const next = snapshotSessions.map(normalizeSessionSummaryForDisplay);
      commitSessions(next);
      return next;
    },
  };
  const { refreshSessions, seedSessions } = actionsRef.current;

  return {
    sessions,
    catalogRevision,
    authoritativeSessionIds,
    sessionsRef,
    refreshSessions,
    seedSessions,
  };
}
