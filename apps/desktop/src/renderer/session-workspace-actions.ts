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
 * once-created session-UI controller — all fixed for the renderer's lifetime —
 * so the factory runs ONCE and the identities follow structurally.
 *
 * Declaring these in the hook body instead handed every consumer a fresh
 * identity per render, and `activateSession` alone rebuilt the Session rail's
 * whole command chain, which defeated `SessionNavRow`'s `memo` on every commit.
 * That is asserted in `session-workspace-action-identity.test.ts`; whether a
 * factory earns its identity this way or through `useStableActions` is an
 * implementation choice the test does not care about.
 */

import type { StoredMessage } from '@maka/core/session';
import type { TransientUserMessageProjection } from '@maka/ui';
import { clearNewTaskReloadIntent, markNewTaskReloadIntent } from './new-task-reload-intent.js';
import type { DesktopTranscriptRangeController } from './platform/desktop/desktop-transcript-range-store.js';
import {
  mergeTransientMessageProjection,
  reconcileTransientMessages,
} from './application/contracts/transient-message-projection.js';

type RefBox<T> = { current: T };

type TransientUserMessage = TransientUserMessageProjection;

export type MessageListUpdater = (
  next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[]),
) => void;

export interface SessionWorkspaceActions {
  captureSelection(): () => boolean;
  isSessionSelected(sessionId: string | undefined): boolean;
  retiredSessionIds(sessions: readonly { id: string }[]): string[];
  setActiveId(next: string | undefined): void;
  startNewSession(): void;
  clearOwnedSessionState(sessionId: string): void;
  setMessages: MessageListUpdater;
  commitTranscript(sessionId: string, messages: StoredMessage[], controller?: DesktopTranscriptRangeController): boolean;
  addTransientMessage(sessionId: string, message: TransientUserMessage): void;
  updateTransientMessage(sessionId: string, message: TransientUserMessage): void;
  retireCancelledTransientMessages(sessionId: string): Promise<void>;
  removeTransientMessage(sessionId: string, messageId: string): void;
}

export function createSessionWorkspaceActions(deps: {
  activeIdRef: RefBox<string | undefined>;
  readRequestedSessionId(): string | undefined;
  isReadableSession(sessionId: string): boolean;
  messagesRef: RefBox<StoredMessage[]>;
  transientMessagesBySessionRef: RefBox<Map<string, Map<string, TransientUserMessage>>>;
  transcriptRangeRef: RefBox<DesktopTranscriptRangeController | undefined>;
  selectionRevisionRef: RefBox<number>;
  setActiveIdState: (next: string | undefined) => void;
  setMessagesState: (next: StoredMessage[]) => void;
  setTransientMessagesState: (next: TransientUserMessage[]) => void;
  setMessageLoadPending: (pending: boolean) => void;
  clearSessionUiState: (sessionId: string) => void;
}): SessionWorkspaceActions {
  const {
    activeIdRef,
    readRequestedSessionId,
    isReadableSession,
    messagesRef,
    transientMessagesBySessionRef,
    transcriptRangeRef,
    selectionRevisionRef,
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
    const current = pending.get(message.id);
    pending.set(message.id, current ? mergeTransientMessageProjection(current, message) : message);
    reprojectActiveTransients(sessionId);
  }

  function updateTransientMessage(sessionId: string, message: TransientUserMessage): void {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    const current = pending?.get(message.id);
    if (!pending || !current) return;
    pending.set(message.id, mergeTransientMessageProjection(current, message));
    reprojectActiveTransients(sessionId);
  }


  async function retireCancelledTransientMessages(sessionId: string): Promise<void> {
    const pending = transientMessagesBySessionRef.current.get(sessionId);
    if (!pending || pending.size === 0) return;
    try {
      const messageIds = [...pending.keys()];
      const { cancelledMessageIds } = await window.maka.sessions.queryCancelledMessages(
        sessionId,
        messageIds,
      );
      const current = transientMessagesBySessionRef.current.get(sessionId);
      if (!current) return;
      for (const messageId of cancelledMessageIds) current.delete(messageId);
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
    if (next !== readRequestedSessionId()) transcriptRangeRef.current = undefined;
    const changed = next !== activeIdRef.current;
    // An existing conversation is handed over by commitTranscript. New/local
    // tasks have no readable history yet and must show their staged first row
    // immediately so creating a task never waits for sending that same row.
    if (changed && (!next || !activeIdRef.current || !isReadableSession(next))) {
      activeIdRef.current = next;
      setMessages([]);
    }
    setMessageLoadPending(Boolean(next && changed));
    if (next) clearNewTaskReloadIntent();
    setActiveIdState(next);
  }

  function commitTranscript(sessionId: string, messages: StoredMessage[], controller?: DesktopTranscriptRangeController): boolean {
    if (readRequestedSessionId() !== sessionId) return false;
    transcriptRangeRef.current = controller;
    activeIdRef.current = sessionId;
    setMessages(messages);
    setMessageLoadPending(false);
    return true;
  }

  function startNewSession(): void {
    markNewTaskReloadIntent();
    setActiveId(undefined);
    messagesRef.current = [];
    setMessagesState([]);
    setTransientMessagesState([]);
  }

  function clearOwnedSessionState(sessionId: string): void {
    const requested = readRequestedSessionId();
    if (activeIdRef.current === sessionId) {
      activeIdRef.current = undefined;
      transcriptRangeRef.current = undefined;
      setMessages([]);
    }
    if (requested === sessionId) {
      const displayed = activeIdRef.current;
      setActiveId(displayed && isReadableSession(displayed) ? displayed : undefined);
    }
    transientMessagesBySessionRef.current.delete(sessionId);
    if (activeIdRef.current === sessionId) setTransientMessagesState([]);
    clearSessionUiState(sessionId);
  }

  return {
    isSessionSelected: (sessionId) => readRequestedSessionId() === sessionId && activeIdRef.current === sessionId,
    captureSelection() {
      const revision = selectionRevisionRef.current;
      return () => selectionRevisionRef.current === revision;
    },
    retiredSessionIds(sessions) {
      return [...new Set([activeIdRef.current, readRequestedSessionId()])].filter(
        (id): id is string => id !== undefined && !sessions.some((session) => session.id === id),
      );
    },
    setActiveId,
    startNewSession,
    clearOwnedSessionState,
    setMessages,
    commitTranscript,
    addTransientMessage,
    updateTransientMessage,
    retireCancelledTransientMessages,
    removeTransientMessage,
  };
}
