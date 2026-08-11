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
    showModelSetupToast,
    toastApi,
    notifyRunEnded,
  } = options;

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
      case 'error':
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
        void refreshMessages(sessionId, terminalRefreshOptions(before));
        break;
      }
      default:
        break;
    }
  }

  return { handleEvent, reconcilePersistedMessages, settleAssistantStreaming };
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
