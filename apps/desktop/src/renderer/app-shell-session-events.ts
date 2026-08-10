import type { SessionEvent, StoredMessage, UiLocale } from '@maka/core';
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

type ToastApi = {
  error(title: string, description?: string, diagnosticDetails?: string): void;
};

export interface AppShellSessionEventHandlers {
  handleEvent(sessionId: string, event: SessionEvent): void;
  projectOptimisticSteering(sessionId: string, messageId: string, text: string, ts?: number): boolean;
  rollbackOptimisticSteering(sessionId: string, messageId: string): void;
  reconcilePersistedMessages(sessionId: string, messages: readonly StoredMessage[]): void;
  settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void>;
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
  /** Runtime consumed this exact queued input at a same-turn step boundary. */
  onSteeringConsumed?: (sessionId: string, messageId: string) => void;
  /** The turn completed; any admitted steering not consumed is next-turn input. */
  onTurnCompleted?: (sessionId: string) => void;
  /** Error/abort has different queue semantics; discard local disposition tracking. */
  onTurnInterrupted?: (sessionId: string) => void;
  showModelSetupToast: (description: string, reason?: string) => void;
  toastApi: ToastApi;
  notifyRunEnded?: (payload: { kind: 'completed' | 'errored'; sessionId: string; body?: string }) => void;
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
    onSteeringConsumed,
    onTurnCompleted,
    onTurnInterrupted,
    showModelSetupToast,
    toastApi,
    notifyRunEnded,
  } = options;
  const optimisticSteeringIds = new Set<string>();

  function optimisticSteeringKey(sessionId: string, messageId: string): string {
    return `${sessionId}:${messageId}`;
  }

  function updateLiveTurn(sessionId: string, event: SessionEvent): void {
    setLiveTurnBySession((current) => {
      const nextProjection = applyLiveTurnEvent(current[sessionId], event, uiLocale);
      if (nextProjection === current[sessionId]) return current;
      const next = { ...current };
      if (nextProjection) next[sessionId] = nextProjection;
      else delete next[sessionId];
      return next;
    });
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

  function projectOptimisticSteering(
    sessionId: string,
    messageId: string,
    text: string,
    ts = Date.now(),
  ): boolean {
    const projection = liveTurnBySessionRef.current[sessionId];
    if (!projection) return false;
    optimisticSteeringIds.add(optimisticSteeringKey(sessionId, messageId));
    updateLiveTurn(sessionId, {
      type: 'steering_message',
      id: `optimistic-steering:${messageId}`,
      turnId: projection.turnId,
      ts,
      messageId,
      content: { text, displayText: text },
    });
    return true;
  }

  function rollbackOptimisticSteering(sessionId: string, messageId: string): void {
    if (!optimisticSteeringIds.delete(optimisticSteeringKey(sessionId, messageId))) return;
    setLiveTurnBySession((current) => {
      const projection = current[sessionId];
      if (!projection?.steering?.some((message) => message.id === messageId)) return current;
      const steering = projection.steering.filter((message) => message.id !== messageId);
      const nextProjection = { ...projection };
      if (steering.length > 0) nextProjection.steering = steering;
      else delete nextProjection.steering;
      return { ...current, [sessionId]: nextProjection };
    });
  }

  async function settleAssistantStreaming(sessionId: string, messageId?: string): Promise<void> {
    const projection = liveTurnBySessionRef.current[sessionId];
    if (!projection || !messageId) return;
    const step = projection.steps.find((candidate) => candidate.stepId === messageId);
    if (!step?.text?.complete) return;
    const refreshed = await refreshMessages(sessionId, { requiredAssistantMessageId: messageId }).catch(() => false);
    if (!refreshed) return;
    settleLiveStep(sessionId, messageId);
  }

  function reconcilePersistedMessages(sessionId: string, messages: readonly StoredMessage[]): void {
    setLiveTurnBySession((current) => {
      const projection = current[sessionId];
      if (!projection) return current;
      const reconciled = reconcileTerminalLiveTurn(projection, messages);
      if (reconciled === projection) return current;
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
    const before = liveTurnBySessionRef.current[sessionId];
    updateLiveTurn(sessionId, event);

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
      case 'steering_message':
        optimisticSteeringIds.delete(optimisticSteeringKey(sessionId, event.messageId));
        onSteeringConsumed?.(sessionId, event.messageId);
        // #1954: the runtime persisted a mid-turn steering message as a user
        // RuntimeEvent; re-read so the injected text appears in the transcript
        // (previously fell into the default branch and stayed invisible until
        // the next unrelated refresh).
        void refreshMessages(sessionId);
        break;
      case 'error':
        onTurnInterrupted?.(sessionId);
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => clearInteractions(current, sessionId));
        if (activeIdRef.current === sessionId) {
          if (isNoRealConnectionEvent(event)) {
            const reason = noRealConnectionReasonFromEvent(event);
            showModelSetupToast(noRealConnectionSetupDescription(reason, uiLocale), reason);
          } else {
            const copy = getDesktopConversationCopy(uiLocale).actions;
            toastApi.error(
              copy.conversationErrorTitle,
              sessionEventErrorMessage(event, uiLocale),
              sessionEventDiagnosticDetails(sessionId, event),
            );
          }
        }
        notifyRunEnded?.({ kind: 'errored', sessionId, body: sessionEventErrorMessage(event, uiLocale) });
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      case 'abort':
        onTurnInterrupted?.(sessionId);
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => clearInteractions(current, sessionId));
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      case 'complete': {
        onTurnCompleted?.(sessionId);
        onInteractionChanged?.(sessionId);
        setInteractionBySession((current) => clearInteractions(current, sessionId));
        if (event.stopReason === 'end_turn' || event.stopReason === 'max_tokens') {
          const body = [...(before?.steps ?? [])].reverse().find((step) => step.text?.text)?.text?.text;
          notifyRunEnded?.({ kind: 'completed', sessionId, body });
        }
        void refreshSessions();
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      }
      default:
        break;
    }
  }

  return {
    handleEvent,
    projectOptimisticSteering,
    rollbackOptimisticSteering,
    reconcilePersistedMessages,
    settleAssistantStreaming,
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
