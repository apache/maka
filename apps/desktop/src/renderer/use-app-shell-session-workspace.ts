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
import { MESSAGE_QUEUE_MAX_ENTRIES } from '@maka/runtime-host/protocol';
import { useAppShellSessionUiState } from './app-shell-session-ui-state';
import { useAppShellSessionList } from './use-app-shell-session-list';
import { createBootstrapSelectionLease } from './bootstrap-selection-lease';
import {
  clearNewTaskReloadIntent,
  hasNewTaskReloadIntent,
  markNewTaskReloadIntent,
} from './new-task-reload-intent';
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';
import {
  mergeTransientMessageProjection,
  projectQueuedTransientMessages as applyQueuedTransientProjection,
  reconcileTransientMessages,
} from './transient-message-projection.js';

type ToastApi = {
  error(title: string, description?: string): void;
};

type MessageListUpdater = (
  next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[]),
) => void;

type TransientUserMessage = TransientUserMessageProjection;

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
  const messagesRef = useRef<StoredMessage[]>([]);
  const [transientMessages, setTransientMessages] = useState<TransientUserMessage[]>([]);
  const transientMessagesBySessionRef = useRef(
    new Map<string, Map<string, TransientUserMessage>>(),
  );
  const transcriptRangeRef = useRef<DesktopTranscriptRangeController | undefined>(undefined);
  const [messageLoadPending, setMessageLoadPending] = useState(false);
  const messageRetryPendingRef = useRef<Set<string>>(new Set());
  const stopPendingRef = useRef<Set<string>>(new Set());

  function projectTransientMessages(
    sessionId: string,
    durable: readonly StoredMessage[],
  ): TransientUserMessage[] {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending || pending.size === 0) return [];
    let includeTransient = true;
    try {
      const range = transcriptRangeRef.current?.store.range();
      includeTransient = range?.sessionId !== sessionId || !range.hasNewer;
    } catch {
      // An unopened transcript has no historical range to hide the live tail from.
    }
    const projected = reconcileTransientMessages(pending, durable, { includeTransient });
    if (pending.size === 0) {
      transientMessagesBySessionRef.current.delete(sessionId);
    }
    return projected;
  }

  const setMessagesForActiveSession: MessageListUpdater = (next) => {
    const projected = typeof next === 'function' ? next([...messagesRef.current]) : next;
    messagesRef.current = projected;
    setMessages(projected);
    const sessionId = activeIdRef.current;
    setTransientMessages(sessionId ? projectTransientMessages(sessionId, projected) : []);
  };

  function addTransientMessage(sessionId: string, message: TransientUserMessage): void {
    let pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending) {
      pending = new Map();
      transientMessagesBySessionRef.current.set(sessionId, pending);
    }
    pending.set(message.id, message);
    if (activeIdRef.current === sessionId) {
      setTransientMessages(projectTransientMessages(sessionId, messagesRef.current));
    }
  }

  function updateTransientMessage(sessionId: string, message: TransientUserMessage): void {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    const current = pending?.get(message.id);
    if (!pending || !current) return;
    pending.set(message.id, mergeTransientMessageProjection(current, message));
    if (activeIdRef.current === sessionId) {
      setTransientMessages(projectTransientMessages(sessionId, messagesRef.current));
    }
  }

  function projectQueuedTransientMessages(
    sessionId: string,
    messages: readonly TransientUserMessage[],
  ): void {
    let pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending && messages.length === 0) return;
    if (!pending) {
      pending = new Map();
      transientMessagesBySessionRef.current.set(sessionId, pending);
    }
    applyQueuedTransientProjection(pending, messages);
    if (activeIdRef.current === sessionId) {
      setTransientMessages(projectTransientMessages(sessionId, messagesRef.current));
    }
  }

  async function retireCancelledTransientMessages(sessionId: string): Promise<void> {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending || pending.size === 0) return;
    try {
      // A legal Host queue already fills the protocol's per-query cap, and an
      // unreconciled root Message sits beside it, so asking about every row at
      // once fails the whole proof and retires nothing.
      const messageIds = [...pending.keys()];
      const cancelled: string[] = [];
      for (let from = 0; from < messageIds.length; from += MESSAGE_QUEUE_MAX_ENTRIES) {
        const result = await window.maka.sessions.queryCancelledMessages(
          sessionId,
          messageIds.slice(from, from + MESSAGE_QUEUE_MAX_ENTRIES),
        );
        cancelled.push(...result.cancelledMessageIds);
      }
      const current = transientMessagesBySessionRef.current.get(sessionId);
      if (!current) return;
      for (const messageId of cancelled) current.delete(messageId);
      if (current.size === 0) transientMessagesBySessionRef.current.delete(sessionId);
      if (activeIdRef.current === sessionId) {
        setTransientMessages(projectTransientMessages(sessionId, messagesRef.current));
      }
    } catch {
      // A failed proof query leaves presentation intact until canonical proof arrives.
    }
  }

  function removeTransientMessage(sessionId: string, messageId: string): void {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending?.delete(messageId)) return;
    if (pending.size === 0) transientMessagesBySessionRef.current.delete(sessionId);
    if (activeIdRef.current === sessionId) {
      setTransientMessages(projectTransientMessages(sessionId, messagesRef.current));
    }
  }

  function setActiveId(next: string | undefined): void {
    selectionRevisionRef.current += 1;
    // Clear here, not in the read effect: a layout-effect clear would wipe an
    // optimistic first message before the first paint.
    if (!next) {
      setMessageLoadPending(false);
    } else if (next !== activeIdRef.current) {
      messagesRef.current = [];
      setMessages([]);
      setTransientMessages(projectTransientMessages(next, []));
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
    messagesRef.current = [];
    setMessages([]);
    setTransientMessages([]);
  }

  function clearOwnedSessionState(sessionId: string): void {
    messageRetryPendingRef.current.delete(sessionId);
    stopPendingRef.current.delete(sessionId);
    transientMessagesBySessionRef.current.delete(sessionId);
    if (activeIdRef.current === sessionId) setTransientMessages([]);
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
    transientMessages,
    setMessages: setMessagesForActiveSession,
    addTransientMessage,
    updateTransientMessage,
    projectQueuedTransientMessages,
    retireCancelledTransientMessages,
    removeTransientMessage,
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
