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
import type { TransientUserMessageProjection } from '@maka/ui';
import { useAppShellSessionUiState } from './app-shell-session-ui-state.js';
import {
  selectActiveSessionId,
  useSessionCatalogController,
} from './session-catalog-state.js';
import { useExternalStoreSelector } from './use-external-store-selector.js';
import { useAppShellSessionList } from './use-app-shell-session-list.js';
import { createBootstrapSelectionLease } from './bootstrap-selection-lease.js';
import { hasNewTaskReloadIntent } from './new-task-reload-intent.js';
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';
import {
  createSessionWorkspaceActions,
  type SessionWorkspaceActions,
} from './session-workspace-actions.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

type TransientUserMessage = TransientUserMessageProjection;

export function useAppShellSessionWorkspace(toastApi: ToastApi) {
  // The catalog and the selection are one authority, and it is a store: the
  // Session rail subscribes to it directly instead of receiving it from the
  // shell's render (#4109).
  const catalog = useSessionCatalogController();
  const activeId = useExternalStoreSelector(catalog, selectActiveSessionId);
  const activeIdRef = useRef<string | undefined>(undefined);
  const sessionUi = useAppShellSessionUiState();
  const sessionList = useAppShellSessionList(toastApi, {
    catalog,
    activeIdRef,
    liveTurnBySessionRef: sessionUi.liveTurnBySessionRef,
    clearTurnTransientStateIfCurrent: sessionUi.clearTurnTransientStateIfCurrent,
  });
  const selectionRevisionRef = useRef(0);
  const bootstrapSelectionLeaseRef = useRef<ReturnType<typeof createBootstrapSelectionLease> | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const messagesRef = useRef<StoredMessage[]>([]);
  const [transientMessages, setTransientMessages] = useState<TransientUserMessage[]>([]);
  const transientMessagesBySessionRef = useRef(
    new Map<string, Map<string, TransientUserMessage>>(),
  );
  const transcriptRangeRef = useRef<DesktopTranscriptRangeController | undefined>(undefined);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const messageRetryPendingRef = useRef<Set<string>>(new Set());
  const stopPendingRef = useRef<Set<string>>(new Set());

  const actionsRef = useRef<SessionWorkspaceActions | null>(null);
  // Every dep below is a ref box, a state setter, or a method of the
  // once-created session-UI controller, so one instance serves the renderer's
  // lifetime. Consumers list these in dep arrays and pass them as props; a
  // per-render identity there is what defeated the Session rail's memo.
  actionsRef.current ??= createSessionWorkspaceActions({
    activeIdRef,
    messagesRef,
    transientMessagesBySessionRef,
    transcriptRangeRef,
    selectionRevisionRef,
    messageRetryPendingRef,
    stopPendingRef,
    // The store is the authority for the selection, so the factory's single
    // write point goes to it rather than to a `useState` beside it. The
    // controller is created once per renderer, so this identity is fixed and
    // the once-created factory may capture it.
    setActiveIdState: catalog.setActiveSessionId,
    setMessagesState: setMessages,
    setTransientMessagesState: setTransientMessages,
    setMessageLoadPending,
    clearSessionUiState: sessionUi.clearSessionUiState,
  });
  const actions = actionsRef.current;

  if (!bootstrapSelectionLeaseRef.current) {
    bootstrapSelectionLeaseRef.current = createBootstrapSelectionLease({
      readActiveId: () => activeIdRef.current,
      readSelectionRevision: () => selectionRevisionRef.current,
      select: actions.setActiveId,
    });
    if (hasNewTaskReloadIntent()) bootstrapSelectionLeaseRef.current.release();
  }

  return {
    ...sessionList,
    sessionCatalogController: catalog,
    activeId,
    activeIdRef,
    bootstrapSelectionLease: bootstrapSelectionLeaseRef.current,
    ...actions,
    messages,
    transientMessages,
    transcriptRangeRef,
    messageLoadPending,
    setMessageLoadPending,
    messageRetryPendingRef,
    stopPendingRef,
    sessionUiController: sessionUi.controller,
    liveTurnBySessionRef: sessionUi.liveTurnBySessionRef,
    sessionEventHealthBySessionRef: sessionUi.sessionEventHealthBySessionRef,
    setMessageLoadErrorBySession: sessionUi.setMessageLoadErrorBySession,
    setMessageRetryPendingBySession: sessionUi.setMessageRetryPendingBySession,
    setStopPendingBySession: sessionUi.setStopPendingBySession,
    setLiveTurnBySession: sessionUi.setLiveTurnBySession,
    setShellRunUpdatesBySession: sessionUi.setShellRunUpdatesBySession,
    setInteractionBySession: sessionUi.setInteractionBySession,
    setMessageQueueBySession: sessionUi.setMessageQueueBySession,
    setSessionEventHealthBySession: sessionUi.setSessionEventHealthBySession,
    setPendingPermissionModeBySession: sessionUi.setPendingPermissionModeBySession,
    setPendingSessionModelBySession: sessionUi.setPendingSessionModelBySession,
    confirmLiveTurn: sessionUi.confirmLiveTurn,
  };
}
