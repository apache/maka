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
import { useAppShellSessionUiState } from './app-shell-session-ui-state';
import { useAppShellSessionList } from './use-app-shell-session-list';
import { createBootstrapSelectionLease } from './bootstrap-selection-lease';
import {
  clearNewTaskReloadIntent,
  hasNewTaskReloadIntent,
  markNewTaskReloadIntent,
} from './new-task-reload-intent';
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';
import { reconcileTransientMessages } from './transient-message-projection.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

type MessageListUpdater = (
  next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[]),
) => void;

export function useAppShellSessionWorkspace(toastApi: ToastApi) {
  const [activeId, setActiveIdState] = useState<string | undefined>();
  const activeIdRef = useRef<string | undefined>(undefined);
  const sessionUi = useAppShellSessionUiState();
  const sessionList = useAppShellSessionList(toastApi, {
    activeIdRef,
    liveTurnBySessionRef: sessionUi.liveTurnBySessionRef,
    clearTurnTransientStateIfCurrent: sessionUi.clearTurnTransientStateIfCurrent,
  });
  const selectionRevisionRef = useRef(0);
  const bootstrapSelectionLeaseRef = useRef<ReturnType<typeof createBootstrapSelectionLease> | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const transientMessagesBySessionRef = useRef(new Map<string, Map<string, StoredMessage>>());
  const transcriptRangeRef = useRef<DesktopTranscriptRangeController | undefined>(undefined);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const messageRetryPendingRef = useRef<Set<string>>(new Set());
  const stopPendingRef = useRef<Set<string>>(new Set());

  function mergeTransientMessages(sessionId: string, durable: readonly StoredMessage[]): StoredMessage[] {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending || pending.size === 0) return [...durable];
    const projected = reconcileTransientMessages(pending, durable);
    if (pending.size === 0) {
      transientMessagesBySessionRef.current.delete(sessionId);
    }
    return projected;
  }

  const setMessagesForActiveSession: MessageListUpdater = (next) => {
    setMessages((current) => {
      const projected = typeof next === 'function' ? next([...current]) : next;
      const sessionId = activeIdRef.current;
      return sessionId ? mergeTransientMessages(sessionId, projected) : projected;
    });
  };

  function addTransientMessage(sessionId: string, message: StoredMessage): void {
    let pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending) {
      pending = new Map();
      transientMessagesBySessionRef.current.set(sessionId, pending);
    }
    pending.set(message.id, message);
    if (activeIdRef.current === sessionId) {
      setMessages((current) => mergeTransientMessages(sessionId, current));
    }
  }

  function removeTransientMessage(sessionId: string, messageId: string): void {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (pending?.delete(messageId) && pending.size === 0) {
      transientMessagesBySessionRef.current.delete(sessionId);
    }
    if (activeIdRef.current === sessionId) {
      setMessages((current) => current.filter((message) => message.id !== messageId));
    }
  }

  function setActiveId(next: string | undefined): void {
    selectionRevisionRef.current += 1;
    // Clear here, not in the read effect: a layout-effect clear would wipe an
    // optimistic first message before the first paint.
    if (!next) {
      setMessageLoadPending(false);
    } else if (next !== activeIdRef.current) {
      setMessages([]);
      setMessageLoadPending(true);
    }
    activeIdRef.current = next;
    if (next) clearNewTaskReloadIntent();
    setActiveIdState(next);
  }

  if (!bootstrapSelectionLeaseRef.current) {
    bootstrapSelectionLeaseRef.current = createBootstrapSelectionLease({
      readActiveId: () => activeIdRef.current,
      readSelectionRevision: () => selectionRevisionRef.current,
      select: setActiveId,
    });
    if (hasNewTaskReloadIntent()) bootstrapSelectionLeaseRef.current.release();
  }

  function startNewSession(): void {
    markNewTaskReloadIntent();
    setActiveId(undefined);
    setMessages([]);
  }

  function clearOwnedSessionState(sessionId: string): void {
    messageRetryPendingRef.current.delete(sessionId);
    stopPendingRef.current.delete(sessionId);
    transientMessagesBySessionRef.current.delete(sessionId);
    sessionUi.clearSessionUiState(sessionId);
  }

  return {
    ...sessionList,
    activeId,
    activeIdRef,
    bootstrapSelectionLease: bootstrapSelectionLeaseRef.current,
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    messages,
    setMessages: setMessagesForActiveSession,
    addTransientMessage,
    removeTransientMessage,
    mergeTransientMessages,
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
