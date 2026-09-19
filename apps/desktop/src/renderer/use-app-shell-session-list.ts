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

import { useRef } from 'react';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  normalizeSessionSummaryForDisplay,
} from './session-status-presentation.js';
import {
  createSessionListRefresher,
  type SessionListRefresher,
} from './session-read-state.js';
import {
  selectAuthoritativeSessionIds,
  type SessionCatalogController,
} from './session-catalog-state.js';
import { sessionIdSetsEqual } from './features/conversation/index.js';
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
  },
) {
  const uiLocale = useUiLocale();
  const uiLocaleRef = useRef(uiLocale);
  uiLocaleRef.current = uiLocale;
  const { catalog } = options;
  // Selected from the catalog store rather than held here: the rail follows the
  // same authority without the shell carrying it down a prop chain (#4109). The
  // shell reads rows through its own selectors — this hook only carries the
  // membership set and the imperative surface.
  const authoritativeSessionIds = useExternalStoreSelector(
    catalog,
    selectAuthoritativeSessionIds,
    undefined,
    sessionIdSetsEqual,
  );
  const sessionsRef = useRef<DesktopSessionSummary[]>([]);
  const refresherRef = useRef<SessionListRefresher<DesktopSessionSummary> | null>(null);
  const pendingPatchesRef = useRef(
    new Map<string, { resolve: (session: DesktopSessionSummary | null) => void }[]>(),
  );
  const patchDrainActiveRef = useRef(false);

  function commitSessions(next: DesktopSessionSummary[]): void {
    sessionsRef.current = next;
    catalog.commitSessions(next);
  }

  function commitPatch(sessionId: string, summary: DesktopSessionSummary | null): void {
    catalog.commitPatch(sessionId, summary);
    sessionsRef.current = [...catalog.getState().sessions];
  }

  // `sessions:changed` carries the changed row's id, so the hot path reads and
  // commits only that row. Calls arriving while a batch is in flight fold into
  // the next drain instead of queueing one IPC per event.
  async function drainSessionPatches(): Promise<void> {
    try {
      while (pendingPatchesRef.current.size > 0) {
        const batch = [...pendingPatchesRef.current.entries()];
        pendingPatchesRef.current.clear();
        await Promise.all(batch.map(async ([sessionId, waiters]) => {
          try {
            const summary = await window.maka.sessions.get(sessionId);
            const normalized = summary === null
              ? null
              : normalizeSessionSummaryForDisplay(summary);
            commitPatch(sessionId, normalized);
            waiters.forEach(({ resolve }) => resolve(normalized));
          } catch {
            // A failed row read must not evict the row; fall back to a full
            // refresh (deduped by the refresher) so it cannot strand stale.
            waiters.forEach(({ resolve }) => resolve(null));
            void refresherRef.current?.refresh().catch(() => undefined);
          }
        }));
      }
    } finally {
      patchDrainActiveRef.current = false;
    }
  }

  function refreshChangedSession(sessionId: string): Promise<DesktopSessionSummary | null> {
    const pending = new Promise<DesktopSessionSummary | null>((resolve) => {
      const waiters = pendingPatchesRef.current.get(sessionId);
      if (waiters) waiters.push({ resolve });
      else pendingPatchesRef.current.set(sessionId, [{ resolve }]);
    });
    if (!patchDrainActiveRef.current) {
      patchDrainActiveRef.current = true;
      void drainSessionPatches();
    }
    return pending;
  }

  if (!refresherRef.current) {
    refresherRef.current = createSessionListRefresher({
      listSessions: () => window.maka.sessions.list(),
      currentSessions: () => sessionsRef.current,
      commitSessions: (next) => commitSessions(next.map(normalizeSessionSummaryForDisplay)),
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
    refreshChangedSession(sessionId: string): Promise<DesktopSessionSummary | null>;
    seedSessions(
      snapshotSessions: readonly DesktopSessionSummary[],
    ): DesktopSessionSummary[];
  } | null>(null);
  actionsRef.current ??= {
    async refreshSessions() {
      return refresherRef.current!.refresh();
    },
    refreshChangedSession,
    seedSessions(snapshotSessions) {
      const next = snapshotSessions.map(normalizeSessionSummaryForDisplay);
      commitSessions(next);
      return next;
    },
  };
  const { refreshSessions, seedSessions } = actionsRef.current;

  return {
    authoritativeSessionIds,
    sessionsRef,
    refreshSessions,
    refreshChangedSession: actionsRef.current.refreshChangedSession,
    seedSessions,
  };
}
