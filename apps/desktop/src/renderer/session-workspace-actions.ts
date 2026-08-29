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

/**
 * Session-workspace actions: active-session selection, the durable message
 * list, and the transient (optimistic) message projection.
 *
 * Every dependency here is a ref box, a React state setter, or a method of the
 * once-created session-UI controller — all fixed for the renderer's lifetime.
 * The factory therefore runs ONCE (issue #1043's `useStableActions` exists for
 * factories whose closures capture changing deps; these capture none, so the
 * cheaper structural guarantee applies). Declaring these in the hook body
 * instead handed every consumer a fresh identity per render, and
 * `activateSession` alone rebuilt the Session rail's whole command chain, which
 * defeated `SessionNavRow`'s `memo` on every commit.
 */

import type { StoredMessage } from '@maka/core/session';
import type { TransientUserMessageProjection } from '@maka/ui';
import { MESSAGE_QUEUE_MAX_ENTRIES } from '@maka/runtime-host/protocol';
import { clearNewTaskReloadIntent, markNewTaskReloadIntent } from './new-task-reload-intent.js';
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';
import {
  mergeTransientMessageProjection,
  projectQueuedTransientMessages as applyQueuedTransientProjection,
  reconcileTransientMessages,
} from './transient-message-projection.js';

type RefBox<T> = { current: T };

type TransientUserMessage = TransientUserMessageProjection;

export type MessageListUpdater = (
  next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[]),
) => void;

export interface SessionWorkspaceActions {
  setActiveId(next: string | undefined): void;
  startNewSession(): void;
  clearOwnedSessionState(sessionId: string): void;
  setMessages: MessageListUpdater;
  addTransientMessage(sessionId: string, message: TransientUserMessage): void;
  updateTransientMessage(sessionId: string, message: TransientUserMessage): void;
  projectQueuedTransientMessages(
    sessionId: string,
    messages: readonly TransientUserMessage[],
  ): void;
  retireCancelledTransientMessages(sessionId: string): Promise<void>;
  removeTransientMessage(sessionId: string, messageId: string): void;
}

export function createSessionWorkspaceActions(deps: {
  activeIdRef: RefBox<string | undefined>;
  messagesRef: RefBox<StoredMessage[]>;
  transientMessagesBySessionRef: RefBox<Map<string, Map<string, TransientUserMessage>>>;
  transcriptRangeRef: RefBox<DesktopTranscriptRangeController | undefined>;
  selectionRevisionRef: RefBox<number>;
  messageRetryPendingRef: RefBox<Set<string>>;
  stopPendingRef: RefBox<Set<string>>;
  setActiveIdState: (next: string | undefined) => void;
  setMessagesState: (next: StoredMessage[]) => void;
  setTransientMessagesState: (next: TransientUserMessage[]) => void;
  setMessageLoadPending: (pending: boolean) => void;
  clearSessionUiState: (sessionId: string) => void;
}): SessionWorkspaceActions {
  const {
    activeIdRef,
    messagesRef,
    transientMessagesBySessionRef,
    transcriptRangeRef,
    selectionRevisionRef,
    messageRetryPendingRef,
    stopPendingRef,
    setActiveIdState,
    setMessagesState,
    setTransientMessagesState,
    setMessageLoadPending,
    clearSessionUiState,
  } = deps;

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

  function reprojectActiveTransients(sessionId: string): void {
    if (activeIdRef.current !== sessionId) return;
    setTransientMessagesState(projectTransientMessages(sessionId, messagesRef.current));
  }

  const setMessages: MessageListUpdater = (next) => {
    const projected = typeof next === 'function' ? next([...messagesRef.current]) : next;
    messagesRef.current = projected;
    setMessagesState(projected);
    const sessionId = activeIdRef.current;
    setTransientMessagesState(
      sessionId ? projectTransientMessages(sessionId, projected) : [],
    );
  };

  function addTransientMessage(sessionId: string, message: TransientUserMessage): void {
    let pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending) {
      pending = new Map();
      transientMessagesBySessionRef.current.set(sessionId, pending);
    }
    pending.set(message.id, message);
    reprojectActiveTransients(sessionId);
  }

  function updateTransientMessage(sessionId: string, message: TransientUserMessage): void {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    const current = pending?.get(message.id);
    if (!pending || !current) return;
    pending.set(message.id, mergeTransientMessageProjection(current, message));
    reprojectActiveTransients(sessionId);
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
    reprojectActiveTransients(sessionId);
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
      reprojectActiveTransients(sessionId);
    } catch {
      // A failed proof query leaves presentation intact until canonical proof arrives.
    }
  }

  function removeTransientMessage(sessionId: string, messageId: string): void {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending?.delete(messageId)) return;
    if (pending.size === 0) transientMessagesBySessionRef.current.delete(sessionId);
    reprojectActiveTransients(sessionId);
  }

  function setActiveId(next: string | undefined): void {
    selectionRevisionRef.current += 1;
    // Clear here, not in the read effect: a layout-effect clear would wipe an
    // optimistic first message before the first paint.
    if (!next) {
      setMessageLoadPending(false);
    } else if (next !== activeIdRef.current) {
      messagesRef.current = [];
      setMessagesState([]);
      setTransientMessagesState(projectTransientMessages(next, []));
      setMessageLoadPending(true);
    }
    activeIdRef.current = next;
    if (next) clearNewTaskReloadIntent();
    setActiveIdState(next);
  }

  function startNewSession(): void {
    markNewTaskReloadIntent();
    setActiveId(undefined);
    messagesRef.current = [];
    setMessagesState([]);
    setTransientMessagesState([]);
  }

  function clearOwnedSessionState(sessionId: string): void {
    messageRetryPendingRef.current.delete(sessionId);
    stopPendingRef.current.delete(sessionId);
    transientMessagesBySessionRef.current.delete(sessionId);
    if (activeIdRef.current === sessionId) setTransientMessagesState([]);
    clearSessionUiState(sessionId);
  }

  return {
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    setMessages,
    addTransientMessage,
    updateTransientMessage,
    projectQueuedTransientMessages,
    retireCancelledTransientMessages,
    removeTransientMessage,
  };
}
