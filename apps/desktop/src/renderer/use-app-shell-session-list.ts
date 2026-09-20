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

import { useMemo, useRef } from 'react';
import { useUiLocale } from '@maka/ui';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';
import { localizedShellErrorMessage } from './locales/shell-copy.js';
import {
  normalizeSessionSummaryForDisplay,
} from './session-status-presentation.js';
import {
  createSessionListRefresher,
} from './session-read-state.js';
import {
  selectAuthoritativeSessionIds,
  type SessionCatalogController,
} from './application/contracts/session-catalog/session-catalog-state.js';
import { sessionIdSetsEqual } from './application/contracts/session-catalog/session-id-set.js';
import { useExternalStoreSelector } from './application/contracts/session-catalog/use-external-store-selector.js';
import { createSessionPatchDrain } from './platform/desktop/session-catalog-sync.js';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

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
  // The catalog is the authority; the box only adapts its read shape.
  const sessionsRef = useMemo(
    () => ({ get current() { return catalog.getState().sessions; } }),
    [catalog],
  );
  const refresher = useMemo(() => {
    let observedAtRevision = 0;
    return createSessionListRefresher({
      listSessions: () => {
        observedAtRevision = catalog.getState().revision;
        return window.maka.sessions.list();
      },
      currentSessions: () => [...sessionsRef.current],
      commitSessions: (next) =>
        catalog.commitSessions(next.map(normalizeSessionSummaryForDisplay), { observedAtRevision }),
      onError: (error) => {
        const locale = uiLocaleRef.current;
        const copy = getDesktopConversationCopy(locale).actions;
        toastApi.error(
          copy.refreshSessionsFailedTitle,
          localizedShellErrorMessage(error, copy.refreshSessionsFailedFallback, locale),
        );
      },
    });
  }, [catalog, sessionsRef]);

  // Fixed identities for the renderer's lifetime: everything closes over ref
  // boxes or the stable controller, and consumers list the actions in dep
  // arrays and hand them down as props (see `session-workspace-actions.ts`).
  // Row-level refresh reads the changed row only; the drain lives on the
  // Desktop adapter because the bridge is not reachable from this layer.
  const actions = useMemo(() => {
    const drain = createSessionPatchDrain({
      normalize: normalizeSessionSummaryForDisplay,
      commitPatch: (sessionId, summary) => catalog.commitPatch(sessionId, summary),
      onReadFailure: () => void refresher.refresh().catch(() => undefined),
    });
    return {
      refreshSessions: () => refresher.refresh(),
      refreshChangedSession: drain.request,
      seedSessions(snapshotSessions: readonly DesktopSessionSummary[]) {
        const next = snapshotSessions.map(normalizeSessionSummaryForDisplay);
        catalog.commitSessions(next);
        return next;
      },
    };
  }, [catalog, refresher]);

  return { authoritativeSessionIds, sessionsRef, ...actions };
}
