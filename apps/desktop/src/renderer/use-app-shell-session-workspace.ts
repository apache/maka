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
import * as Conversation from './features/conversation/index.js';
import {
  selectActiveSessionId,
  useSessionCatalogController,
} from './session-catalog-state.js';
import { useExternalStoreSelector } from './use-external-store-selector.js';
import { useAppShellSessionList } from './use-app-shell-session-list.js';
import { createBootstrapSelectionLease } from './bootstrap-selection-lease.js';
import { hasNewTaskReloadIntent } from './new-task-reload-intent.js';
import type { DesktopTranscriptRangeController } from './platform/desktop/desktop-transcript-range-store.js';
import {
  createSessionWorkspaceActions,
  type SessionWorkspaceActions,
} from './session-workspace-actions.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

export function useAppShellSessionWorkspace(toastApi: ToastApi) {
  // The catalog and the selection are one authority, and it is a store: the
  // Session rail subscribes to it directly instead of receiving it from the
  // shell's render (#4109).
  const catalog = useSessionCatalogController();
  const requestedSessionId = useExternalStoreSelector(catalog, selectActiveSessionId);
  const activeIdRef = useRef<string | undefined>(undefined);
  const actionsRef = useRef<SessionWorkspaceActions | null>(null);
  const sessionList = useAppShellSessionList(toastApi, { catalog });
  const { controller: sessionUiController, publication, display } = Conversation.useAppShellSessionUiState(
    sessionList.sessions,
    requestedSessionId,
    activeIdRef,
    (sessionId, messages, controller: DesktopTranscriptRangeController) =>
      actionsRef.current!.commitTranscript(sessionId, messages, controller),
  );
  const selectionRevisionRef = useRef(0);
  const bootstrapSelectionLeaseRef = useRef<ReturnType<typeof createBootstrapSelectionLease> | null>(null);
  const {
    messagesRef, transcriptRangeRef, setMessagesState,
    messages, publishedTranscriptRange, publishTranscript, isMessagePublished,
  } = publication;
  const {
    transientMessagesBySessionRef,
    setTransientMessagesState, setMessageLoadPending,
  } = display;

  // The captured publication setter only reads stable refs and writes React
  // state. Along with the controller methods and other refs, it lets one
  // actions instance serve the renderer's lifetime without defeating the
  // Session rail's memo with new action identities on every render.
  const actions = actionsRef.current ??= createSessionWorkspaceActions({
    activeIdRef,
    readRequestedSessionId: () => catalog.getState().activeSessionId,
    isReadableSession: (id) => catalog.getState().sessions.some(
      (session) => session.id === id && session.localState !== 'pending',
    ),
    messagesRef,
    transientMessagesBySessionRef,
    transcriptRangeRef,
    selectionRevisionRef,
    // The store is the authority for the selection, so the factory's single
    // write point goes to it rather than to a `useState` beside it. The
    // controller is created once per renderer, so this identity is fixed and
    // the once-created factory may capture it.
    setActiveIdState: catalog.setActiveSessionId,
    setMessagesState,
    setTransientMessagesState,
    setMessageLoadPending,
    clearSessionUiState: sessionUiController.clearSessionUiState,
  });
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
    requestedSessionId,
    activeIdRef,
    bootstrapSelectionLease: bootstrapSelectionLeaseRef.current,
    ...actions,
    messages,
    publishedTranscriptRange,
    publishTranscript,
    isMessagePublished,
    transcriptRangeRef,
    ...display,
    // The store's own surface, not a copy of it. Consumers reach setters and
    // claims through the controller.
    sessionUiController,
  };
}
