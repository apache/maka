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

import type { SessionEvent } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import type { UiLocale } from '@maka/core/ui-locale';
import {
  applyLiveTurnEvent,
  clearInteractions,
  dequeueInteractionByRequestId,
  dequeueInteractionByToolUseId,
  enqueueInteraction,
  reconcileTerminalLiveTurn,
  settleLiveTurnStep,
  type LiveTurnProjection,
  type InteractionQueues,
} from '@maka/ui';
import type { RefreshMessagesOptions } from './app-shell-chat-actions.js';
import {
  isNoRealConnectionEvent,
  noRealConnectionReasonFromEvent,
  noRealConnectionSetupDescription,
  sessionEventErrorMessage,
} from './model-connection-errors.js';
import { getDesktopConversationCopy } from './locales/conversation-copy.js';

type RefBox<T> = { current: T };
type StateUpdater<T> = (updater: (current: T) => T) => void;

const TERMINAL_HANDOFF_ATTEMPTS = 3;
const TERMINAL_HANDOFF_RETRY_DELAY_MS = 120;

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string; turnId: string; eventId: string },
  ): void;
};

export interface AppShellSessionEventHandlers {
  handleEvent(sessionId: string, event: SessionEvent): void;
  reconcilePersistedMessages(sessionId: string, messages: readonly StoredMessage[]): void;
  settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void>;
  flushDisplayEvents(sessionId: string): void;
  markDisplayPending(sessionId: string): void;
  markDisplayReady(sessionId: string): void;
}

export interface AppShellSessionDisplayBatch {
  readonly pendingEvents: Map<string, SessionEvent[]>;
  readonly displayPendingSessions: Set<string>;
  framePending: boolean;
}

export function createAppShellSessionDisplayBatch(): AppShellSessionDisplayBatch {
  return { pendingEvents: new Map(), displayPendingSessions: new Set(), framePending: false };
}

export function createAppShellSessionEventHandlers(options: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  liveTurnBySessionRef: RefBox<Record<string, LiveTurnProjection>>;
  refreshMessages: (sessionId: string, options?: RefreshMessagesOptions) => Promise<boolean>;
  refreshSessions: () => Promise<unknown>;
  setLiveTurnBySession: StateUpdater<Record<string, LiveTurnProjection>>;
  setInteractionBySession: StateUpdater<InteractionQueues>;
  onInteractionChanged?: (sessionId: string) => void;
  /** A boundary decision settled: the session's execution boundary may have moved. */
  onExecutionBoundaryChanged?: (sessionId: string) => void;
  showModelSetupToast: (
    description: string,
    reason?: string,
    diagnosticTarget?: { sessionId: string },
  ) => void;
  toastApi: ToastApi;
  notifyRunEnded?: (payload: { kind: 'completed' | 'errored'; sessionId: string; body?: string }) => void;
  scheduleFrame?: (callback: () => void) => void;
  displayBatch?: AppShellSessionDisplayBatch;
}): AppShellSessionEventHandlers {
  const {
    uiLocale,
    activeIdRef,
    liveTurnBySessionRef,
    refreshMessages,
    refreshSessions,
    setLiveTurnBySession,
    setInteractionBySession,
    onInteractionChanged,
    onExecutionBoundaryChanged,
    showModelSetupToast,
    toastApi,
    notifyRunEnded,
  } = options;
  const scheduleFrame = options.scheduleFrame ?? (
    typeof requestAnimationFrame === 'function'
      ? (callback: () => void) => {
          let pending = true;
          const run = () => {
            if (!pending) return;
            pending = false;
            callback();
          };
          requestAnimationFrame(run);
          window.setTimeout(run, 100);
        }
      : undefined
  );
  const displayBatch = options.displayBatch ?? createAppShellSessionDisplayBatch();

  function applyProjectionEvents(
    projection: LiveTurnProjection | undefined,
    events: readonly SessionEvent[],
  ): LiveTurnProjection | undefined {
    let next = projection;
    for (const event of events) next = applyLiveTurnEvent(next, event, uiLocale);
    return next;
  }

  function replaceLiveTurns(
    current: Record<string, LiveTurnProjection>,
    batches: ReadonlyMap<string, readonly SessionEvent[]>,
  ): Record<string, LiveTurnProjection> {
    let next = current;
    for (const [sessionId, events] of batches) {
      const projection = applyProjectionEvents(current[sessionId], events);
      if (projection === current[sessionId]) continue;
      if (next === current) next = { ...current };
      if (projection) next[sessionId] = projection;
      else delete next[sessionId];
    }
    return next;
  }

  function takePendingDisplayEvents(sessionId: string): SessionEvent[] {
    const events = displayBatch.pendingEvents.get(sessionId) ?? [];
    displayBatch.pendingEvents.delete(sessionId);
    return events;
  }

  function scheduleDisplayEvent(sessionId: string, event: SessionEvent): void {
    const events = displayBatch.pendingEvents.get(sessionId);
    if (events) events.push(event);
    else displayBatch.pendingEvents.set(sessionId, [event]);
    if (displayBatch.framePending || !scheduleFrame) return;
    displayBatch.framePending = true;
    scheduleFrame(() => {
      displayBatch.framePending = false;
      if (displayBatch.pendingEvents.size === 0) return;
      const batches = new Map(displayBatch.pendingEvents);
      displayBatch.pendingEvents.clear();
      setLiveTurnBySession((current) => replaceLiveTurns(current, batches));
    });
  }

  function flushDisplayEvents(sessionId: string): void {
    const events = takePendingDisplayEvents(sessionId);
    if (events.length === 0) return;
    updateLiveTurn(sessionId, events);
  }

  function markDisplayPending(sessionId: string): void {
    displayBatch.displayPendingSessions.add(sessionId);
  }

  function markDisplayReady(sessionId: string): void {
    displayBatch.displayPendingSessions.delete(sessionId);
  }

  function canBatchDisplayEvents(sessionId: string): boolean {
    return !displayBatch.displayPendingSessions.has(sessionId);
  }

  function updateLiveTurn(sessionId: string, events: readonly SessionEvent[]): void {
    setLiveTurnBySession((current) => replaceLiveTurns(current, new Map([[sessionId, events]])));
  }

  function settleLiveStep(sessionId: string, stepId: string): void {
    setLiveTurnBySession((current) => {
      const projection = current[sessionId];
      if (!projection) return current;
      const settled = settleLiveTurnStep(projection, stepId);
      if (settled === projection) return current;
      const next = { ...current };
      if (settled) next[sessionId] = settled;
      else delete next[sessionId];
      return next;
    });
  }

  async function settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void> {
    return handoffAssistantStreaming(sessionId, messageId, true);
  }

  async function handoffAssistantStreaming(
    sessionId: string,
    messageId: string | undefined,
    requireCompletedLiveText: boolean,
  ): Promise<void> {
    const projection = liveTurnBySessionRef.current[sessionId];
    if (!projection || !messageId) return;
    const step = projection.steps.find((candidate) => candidate.stepId === messageId);
    if (!step?.text || (requireCompletedLiveText && !step.text.complete)) return;
    const attempts = requireCompletedLiveText ? 1 : TERMINAL_HANDOFF_ATTEMPTS;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const refreshed = await refreshMessages(sessionId, {
        requiredAssistantMessageId: messageId,
      }).catch(() => false);
      if (refreshed) {
        settleLiveStep(sessionId, messageId);
        return;
      }
      if (
        attempt + 1 >= attempts ||
        !liveTurnBySessionRef.current[sessionId]?.steps.some(
          (candidate) => candidate.stepId === messageId,
        )
      ) return;
      await new Promise<void>((resolve) => {
        globalThis.setTimeout(resolve, TERMINAL_HANDOFF_RETRY_DELAY_MS);
      });
    }
  }

  function reconcilePersistedMessages(sessionId: string, messages: readonly StoredMessage[]): void {
    const pending = takePendingDisplayEvents(sessionId);
    setLiveTurnBySession((current) => {
      const projection = applyProjectionEvents(current[sessionId], pending);
      if (!projection) return current;
      const reconciled = reconcileTerminalLiveTurn(projection, messages);
      if (reconciled === current[sessionId]) return current;
      const next = { ...current };
      if (reconciled) next[sessionId] = reconciled;
      else delete next[sessionId];
      return next;
    });
  }

  function terminalRefreshOptions(projection: LiveTurnProjection | undefined): RefreshMessagesOptions | undefined {
    const messageId = [...(projection?.steps ?? [])].reverse().find((step) => step.text)?.stepId;
    return messageId ? { requiredAssistantMessageId: messageId } : undefined;
  }

  function handleEvent(sessionId: string, event: SessionEvent): void {
    if (
      scheduleFrame
      && activeIdRef.current === sessionId
      && canBatchDisplayEvents(sessionId)
      && (event.type === 'text_delta' || event.type === 'thinking_delta')
    ) {
      scheduleDisplayEvent(sessionId, event);
      return;
    }
    const pending = takePendingDisplayEvents(sessionId);
    const before = applyProjectionEvents(liveTurnBySessionRef.current[sessionId], pending);
    updateLiveTurn(sessionId, [...pending, event]);

    switch (event.type) {
      case 'text_complete':
        void refreshMessages(sessionId, { requiredAssistantMessageId: event.messageId }).catch(() => false);
        break;
      case 'sandbox_boundary_request':
      case 'user_question_request':
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => enqueueInteraction(current, sessionId, event));
        break;
      // The runtime drops its owner on this ack, not on the tool result that
      // follows it, so this is where the request stops being answerable — the
      // same point its boundary sibling settles on, below.
      case 'user_question_answer_ack':
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) =>
          dequeueInteractionByRequestId(current, sessionId, event.requestId),
        );
        break;
      case 'sandbox_boundary_decision_ack':
        onInteractionChanged?.(sessionId);
        // #1611: an approved expansion changes only the boundary's revision —
        // no session field moves — so the boundary read model has to be told,
        // or the permission label keeps describing the permissions the session
        // had before the user granted more.
        onExecutionBoundaryChanged?.(sessionId);
        setInteractionBySession((current) =>
          dequeueInteractionByRequestId(current, sessionId, event.requestId),
        );
        break;
      case 'tool_result':
        setInteractionBySession((current) => dequeueInteractionByToolUseId(current, sessionId, event.toolUseId));
        void refreshMessages(sessionId);
        break;
      case 'error':
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => clearInteractions(current, sessionId));
        if (activeIdRef.current === sessionId) {
          if (isNoRealConnectionEvent(event)) {
            const reason = noRealConnectionReasonFromEvent(event);
            showModelSetupToast(
              noRealConnectionSetupDescription(reason, uiLocale),
              reason,
              { sessionId },
            );
          } else {
            const copy = getDesktopConversationCopy(uiLocale).actions;
            toastApi.error(
              copy.conversationErrorTitle,
              sessionEventErrorMessage(event, uiLocale),
              sessionEventDiagnosticDetails(sessionId, event),
              { sessionId, turnId: event.turnId, eventId: event.id },
            );
          }
        }
        notifyRunEnded?.({ kind: 'errored', sessionId, body: sessionEventErrorMessage(event, uiLocale) });
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      case 'abort':
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => clearInteractions(current, sessionId));
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      case 'complete': {
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => clearInteractions(current, sessionId));
        if (event.stopReason === 'end_turn' || event.stopReason === 'max_tokens') {
          const body = [...(before?.steps ?? [])].reverse().find((step) => step.text?.text)?.text?.text;
          notifyRunEnded?.({ kind: 'completed', sessionId, body });
        }
        void refreshSessions();
        const terminalMessageId = terminalRefreshOptions(before)?.requiredAssistantMessageId;
        if (terminalMessageId) {
          // Terminal durability, rather than Astryx's animation callback, is
          // the authority for handing streamed text to the transcript. The
          // callback remains the fast path, but a remount or interrupted-turn
          // race can no longer strand the final reply in live-only state.
          void handoffAssistantStreaming(sessionId, terminalMessageId, false);
        } else {
          void refreshMessages(sessionId);
        }
        break;
      }
      default:
        break;
    }
  }

  return {
    handleEvent,
    reconcilePersistedMessages,
    settleAssistantStreaming,
    flushDisplayEvents,
    markDisplayPending,
    markDisplayReady,
  };
}

function sessionEventDiagnosticDetails(
  sessionId: string,
  event: Extract<SessionEvent, { type: 'error' }>,
): string {
  return [
    `Session: ${sessionId}`,
    `Turn: ${event.turnId}`,
    `Event: ${event.id}`,
    `Reason: ${event.reason ?? '<none>'}`,
    `Code: ${event.code ?? '<none>'}`,
    `Recoverable: ${event.recoverable}`,
    `Message: ${event.message}`,
    ...(event.details === undefined
      ? []
      : [`Details: ${JSON.stringify(event.details)}`]),
  ].join('\n');
}
