import type { CollaborationMode } from '@maka/core/collaboration';
import type { InlineReference, QuoteRef } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { SessionSummary, StoredMessage } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import type { UiLocale } from '@maka/core/ui-locale';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';
import {
  armLiveTurn,
  dequeueInteractionByRequestId,
  type InteractionQueues,
  type LiveTurnProjection,
  type NavSelection,
} from '@maka/ui';
import type { RendererIngestInput } from '../preload/bridge-contract.js';
import { messageRefreshErrorMessage } from './app-shell-copy.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { preflightAttachmentItems } from './attachment-preflight.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';
import {
  showSkillInvocationFeedback,
  skillInvocationDisplayText,
} from './skill-invocation-feedback.js';

export type PendingAttachment = {
  /** Unique per staged item; keys the preview cache and its cleanup, so a
   *  preview resolving after its item left the list can never strand an
   *  orphan entry. */
  stagingKey: string;
  displayName: string;
  mimeType?: string;
  kind: import('@maka/core/events').AttachmentRef['kind'];
  size: number;
  /** Composer drawer thumbnail source for image attachments. Merged in from
   *  the preview cache only after the URL has actually decoded as an image,
   *  so a set previewUrl always means "renderable" — anything else keeps the
   *  named file card. */
  previewUrl?: string;
  source: { type: 'approval'; approvalId: string; name: string } | { type: 'file'; file: File };
};

/** Stable identity for a staged attachment across preview-URL merges. The
 *  drawer list is re-derived when a preview lands, so submitted items must
 *  be matched by their source — never by object reference. */
export function pendingAttachmentSourceKey(attachment: PendingAttachment): unknown {
  return attachment.source.type === 'approval' ? `approval:${attachment.source.approvalId}` : attachment.source.file;
}

export interface WorkspaceFileReferencePosition {
  value: string;
  start: number;
}
import {
  isNoRealConnectionError,
  noRealConnectionReasonFromError,
  noRealConnectionSetupDescription,
} from './model-connection-errors.js';
import { readSettledMessages, type RefreshMessagesOptions } from './session-message-settlement.js';

export type { RefreshMessagesOptions };

const USER_MESSAGE_VISIBLE_TIMEOUT_MS = 1_200;
const USER_MESSAGE_VISIBLE_POLL_MS = 40;

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
};

type RefBox<T> = { current: T };
type BooleanRecordUpdater = (updater: (current: Record<string, boolean>) => Record<string, boolean>) => void;
type LiveTurnRecordUpdater = (
  updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>,
) => void;
type MessageListUpdater = (next: StoredMessage[] | ((current: StoredMessage[]) => StoredMessage[])) => void;
type MessageLoadErrorUpdater = (updater: (current: Record<string, string>) => Record<string, string>) => void;
type InteractionQueueUpdater = (updater: (current: InteractionQueues) => InteractionQueues) => void;

type PendingNewChatModel = {
  llmConnectionSlug: string;
  model: string;
} | null;

type PendingNewChatThinkingLevel = ThinkingLevel | null;

type ToastApi = {
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
};

export interface AppShellChatActions {
  send(
    text: string,
    pending?: readonly PendingAttachment[],
    options?: {
      turnOrchestration?: TurnOrchestration;
      quotes?: readonly QuoteRef[];
      workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
      displayText?: string;
      onSessionResolved?: (sessionId: string) => void;
    },
  ): Promise<boolean>;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(response: UserQuestionResponse): Promise<void>;
  refreshMessages(sessionId: string, options?: RefreshMessagesOptions): Promise<boolean>;
  retryMessages(sessionId: string): Promise<void>;
}

export function toRendererIngestItems(
  pending: readonly PendingAttachment[],
): RendererIngestInput[] {
  return pending.map((p) =>
    p.source.type === 'approval'
      ? {
          approvalId: p.source.approvalId,
          name: p.source.name,
          ...(p.mimeType ? { mimeType: p.mimeType } : {}),
        }
      : { file: p.source.file },
  );
}

export function createAppShellChatActions(deps: {
  uiLocale: UiLocale;
  activeIdRef: RefBox<string | undefined>;
  addPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => boolean;
  captureComposerImportOwner: () => ComposerImportOwner;
  checkTaskSubmissionReadiness: () => Promise<boolean>;
  clearPendingSessionAction: (
    sessionId: string,
    pendingRef: RefBox<Set<string>>,
    setPendingBySession: BooleanRecordUpdater,
  ) => void;
  isNewChatSendSurfaceActive: (owner: ComposerImportOwner) => boolean;
  /** The shell's one answer to "is this owner still the surface the user is
   *  looking at". Both halves matter — the section AND the session id — which
   *  is why the send path asks it instead of comparing the id itself. */
  isShellSurfaceOwnerActive: (owner: ComposerImportOwner) => boolean;
  markSessionReadLocally: (sessionId: string, readMessages: readonly StoredMessage[]) => void;
  messageRetryPendingRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<SessionSummary[]>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessageLoadErrorBySession: MessageLoadErrorUpdater;
  setMessageRetryPendingBySession: BooleanRecordUpdater;
  setMessages: MessageListUpdater;
  setNavSelection: (selection: NavSelection) => void;
  /** #646: arm the "正在处理…" indicator locally at send() — the model-wait
   * window opens before any SessionEvent arrives (turn_started is not one). */
  setLiveTurnBySession: LiveTurnRecordUpdater;
  setInteractionBySession: InteractionQueueUpdater;
  onInteractionChanged?: (sessionId: string) => void;
  /** A boundary decision settled: the session's execution boundary may have moved. */
  onExecutionBoundaryChanged?: (sessionId: string) => void;
  showModelSetupToast: (description: string, reason?: string) => void;
  toastApi: ToastApi;
  upsertSessionSummary: (session: SessionSummary) => void;
  newChatModel: PendingNewChatModel;
  pendingNewChatThinkingLevel: PendingNewChatThinkingLevel;
  newChatCollaborationMode: CollaborationMode;
  newChatOrchestrationMode: OrchestrationMode;
  newChatProjectId: string | null | undefined;
}): AppShellChatActions {
  const {
    uiLocale,
    activeIdRef,
    addPendingSessionAction,
    captureComposerImportOwner,
    checkTaskSubmissionReadiness,
    clearPendingSessionAction,
    isNewChatSendSurfaceActive,
    isShellSurfaceOwnerActive,
    markSessionReadLocally,
    messageRetryPendingRef,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    setNavSelection,
    setLiveTurnBySession,
    setInteractionBySession,
    onInteractionChanged,
    onExecutionBoundaryChanged,
    showModelSetupToast,
    toastApi,
    upsertSessionSummary,
    newChatModel,
    pendingNewChatThinkingLevel,
    newChatCollaborationMode,
    newChatOrchestrationMode,
    newChatProjectId,
  } = deps;
  const copy = getShellCopy(uiLocale).chatActions;

  function optimisticUserMessage(
    turnId: string,
    text: string,
    attachments: readonly import('@maka/core/events').AttachmentRef[] = [],
    quotes: readonly QuoteRef[] = [],
    inlineReferences: readonly InlineReference[] = [],
  ): StoredMessage {
    return {
      type: 'user',
      id: `optimistic-user-${turnId}`,
      turnId,
      ts: Date.now(),
      text,
      ...(attachments.length > 0 ? { attachments: [...attachments] } : {}),
      ...(quotes.length > 0 ? { quotes: [...quotes] } : {}),
      inlineReferences: [...inlineReferences],
    };
  }

  function showOptimisticUserMessage(
    sessionId: string,
    turnId: string,
    text: string,
    attachments: readonly import('@maka/core/events').AttachmentRef[] = [],
    options: {
      replaceCurrentMessages?: boolean;
      quotes?: readonly QuoteRef[];
      inlineReferences?: readonly InlineReference[];
    } = {},
  ): void {
    if (activeIdRef.current !== sessionId) return;
    setMessageLoadErrorBySession((current) => {
      if (!current[sessionId]) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setMessages((current) => {
      if (current.some((message) => message.type === 'user' && message.turnId === turnId)) return current;
      const next = optimisticUserMessage(
        turnId,
        text,
        attachments,
        options.quotes,
        options.inlineReferences,
      );
      return options.replaceCurrentMessages ? [next] : [...current, next];
    });
  }

  function removeOptimisticUserMessage(sessionId: string, turnId: string): void {
    if (activeIdRef.current !== sessionId) return;
    setMessages((current) => current.filter((message) => message.id !== `optimistic-user-${turnId}`));
  }

  // #646: open the turn's model-wait window for a session. Armed the moment
  // send() commits (before the IPC round-trip) so the "正在处理…" indicator
  // covers the connect-to-first-token gap that has no SessionEvent of its own;
  // disarmed if the send never reaches the runtime (the catch below). Always
  // (re)set to `'waiting'`: a fresh send is a new first-token wait, so it must
  // overwrite any `'streamed'` left by a prior turn whose terminal event was
  // missed — otherwise the new turn's head would never show the indicator.
  //
  // The arm carries `unconfirmed` until the authority names this turn back. The
  // runtime writes `status: 'running'` only at the END of `AgentRun.begin`, so
  // every session list refreshed in between still reports the pre-send status —
  // which is the same status a finished turn leaves behind. Without that bit,
  // the stale value retires the arm the send just created
  // (settled-session-transients.ts).
  function armTurnActive(sessionId: string, turnId: string): void {
    setLiveTurnBySession((current) => {
      const active = current[sessionId];
      if (active?.turnId === turnId && active.phase === 'waiting') return current;
      return { ...current, [sessionId]: armLiveTurn(turnId) };
    });
  }

  function disarmTurnActive(sessionId: string, turnId: string): void {
    setLiveTurnBySession((current) => {
      if (current[sessionId]?.turnId !== turnId) return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }

  async function send(
    text: string,
    pending?: readonly PendingAttachment[],
    options: {
      turnOrchestration?: TurnOrchestration;
      quotes?: readonly QuoteRef[];
      workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
      displayText?: string;
      onSessionResolved?: (sessionId: string) => void;
    } = {},
  ): Promise<boolean> {
    const quotes = options.quotes;
    const initialSessionId = activeIdRef.current;
    const sendOwner = captureComposerImportOwner();
    const newChatOwner = initialSessionId ? null : sendOwner;
    if (!(await checkTaskSubmissionReadiness())) return false;
    if (
      (initialSessionId && !isShellSurfaceOwnerActive(sendOwner)) ||
      (newChatOwner && !isNewChatSendSurfaceActive(newChatOwner))
    ) {
      return false;
    }
    let optimisticSessionId: string | undefined;
    let optimisticTurnId: string | undefined;
    // #1433: the composer creates the session BEFORE it sends, so a first
    // send that never lands has to take the session with it. Set the moment
    // creation succeeds, cleared the moment the send does — while it holds a
    // value, the session exists but has nothing in it. `sessions:send` both
    // returns `{ ok: false }` (a blocked Skill) and throws (Skill discovery,
    // project-context resolution), so tracking it in one place is what keeps
    // the two exits from drifting apart; the deleted `quick-chat.ts` cleaned
    // up on throw and nothing replaced that half.
    let unsentSessionId: string | undefined;
    const discardUnsentSession = async () => {
      if (!unsentSessionId) return;
      const sessionId = unsentSessionId;
      unsentSessionId = undefined;
      try {
        await window.maka.sessions.remove(sessionId);
        await refreshSessions();
      } catch {
        // Best-effort: a failed cleanup must not replace the real error.
      }
    };
    try {
      const turnId = crypto.randomUUID();
      if (!initialSessionId) {
        if (pending && pending.length > 0) preflightAttachmentItems(pending, uiLocale);
        const session = await window.maka.sessions.create({
          // Omit permissionMode so main.ts's sessions:create resolves the
          // configured chatDefaults.permissionMode as the single authority.
          name: DEFAULT_SESSION_NAME,
          ...(newChatModel
            ? {
                llmConnectionSlug: newChatModel.llmConnectionSlug,
                model: newChatModel.model,
              }
            : {}),
          ...(pendingNewChatThinkingLevel ? { thinkingLevel: pendingNewChatThinkingLevel } : {}),
          collaborationMode: newChatCollaborationMode,
          orchestrationMode: newChatOrchestrationMode,
          ...(newChatProjectId !== undefined ? { projectId: newChatProjectId } : {}),
        });
        unsentSessionId = session.id;
        upsertSessionSummary(session);
        optimisticSessionId = session.id;
        optimisticTurnId = turnId;
        armTurnActive(session.id, turnId);
        const attachmentItems =
          pending && pending.length > 0
            ? toRendererIngestItems(pending)
            : undefined;
        const sendResult = await window.maka.sessions.send(session.id, {
          type: 'send',
          turnId,
          text,
          ...(options.displayText ? { displayText: options.displayText } : {}),
          ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
          ...(attachmentItems ? { attachmentItems } : {}),
          ...(quotes && quotes.length > 0 ? { quotes: [...quotes] } : {}),
          ...(options.workspaceFileReferences && options.workspaceFileReferences.length > 0
            ? { workspaceFileReferences: [...options.workspaceFileReferences] }
            : {}),
        });
        if (!sendResult.ok) {
          if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
            showSkillInvocationFeedback(uiLocale, toastApi, sendResult.skillInvocation);
          }
          disarmTurnActive(session.id, turnId);
          await discardUnsentSession();
          return false;
        }
        unsentSessionId = undefined;
        options.onSessionResolved?.(session.id);
        if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
          showSkillInvocationFeedback(uiLocale, toastApi, sendResult.skillInvocation);
        }
        if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
          setNavSelection({ section: 'sessions', filter: 'chats' });
          setActiveId(session.id);
          showOptimisticUserMessage(
            session.id,
            turnId,
            options.displayText ??
              skillInvocationDisplayText(text, sendResult.skillInvocation),
            sendResult.attachments,
            {
              replaceCurrentMessages: true,
              ...(quotes && quotes.length > 0 ? { quotes } : {}),
              inlineReferences: sendResult.inlineReferences ?? [],
            },
          );
        }
        if (activeIdRef.current === session.id) {
          await refreshMessagesUntilTurn(session.id, turnId);
        }
        await refreshSessions();
        return true;
      }
      const sessionId = initialSessionId;
      optimisticSessionId = sessionId;
      optimisticTurnId = turnId;
      armTurnActive(sessionId, turnId);
      const attachmentItems =
        pending && pending.length > 0
          ? toRendererIngestItems(pending)
          : undefined;
      const sendResult = await window.maka.sessions.send(sessionId, {
        type: 'send',
        turnId,
        text,
        ...(options.displayText ? { displayText: options.displayText } : {}),
        ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
        ...(attachmentItems ? { attachmentItems } : {}),
        ...(quotes && quotes.length > 0 ? { quotes: [...quotes] } : {}),
        ...(options.workspaceFileReferences && options.workspaceFileReferences.length > 0
          ? { workspaceFileReferences: [...options.workspaceFileReferences] }
          : {}),
      });
      if (!sendResult.ok) {
        if (activeIdRef.current === sessionId) {
          showSkillInvocationFeedback(uiLocale, toastApi, sendResult.skillInvocation);
        }
        disarmTurnActive(sessionId, turnId);
        return false;
      }
      options.onSessionResolved?.(sessionId);
      if (activeIdRef.current === sessionId) {
        showSkillInvocationFeedback(uiLocale, toastApi, sendResult.skillInvocation);
      }
      showOptimisticUserMessage(
        sessionId,
        turnId,
        options.displayText ??
          skillInvocationDisplayText(text, sendResult.skillInvocation),
        sendResult.attachments,
        {
          ...(quotes && quotes.length > 0 ? { quotes } : {}),
          inlineReferences: sendResult.inlineReferences ?? [],
        },
      );
      await refreshMessagesUntilTurn(sessionId, turnId);
      return true;
    } catch (error) {
      await discardUnsentSession();
      if (optimisticSessionId && optimisticTurnId) {
        removeOptimisticUserMessage(optimisticSessionId, optimisticTurnId);
      }
      // The turn never reached the runtime — close the model-wait window so the
      // "正在处理…" indicator doesn't hang after a failed send. Nothing else has
      // to be undone: the arm was the only claim the send made, and no
      // subscribeChanges event would reconcile a turn that never started.
      if (optimisticSessionId && optimisticTurnId) disarmTurnActive(optimisticSessionId, optimisticTurnId);
      // Which surface is allowed to hear about this failure. The id alone is
      // not it: `selectNavigation` never clears `activeId` (nav-selection.ts),
      // so a user who left for 扩展 → 技能 mid-flight still "is" session A by
      // that comparison — and the readiness branch below ends in
      // `openSettingsSection('models')` (app-shell.tsx), which NAVIGATES. That
      // is the same gap #1433 fixed one file over in the quick-entry path, and
      // it was reachable here because this line re-derived the rule from an id
      // instead of asking the shell. One owner for the question, one answer.
      //
      // The owner MOVES on an optimistic create: the send began on the new-chat
      // surface and the app is now on the session it just made, so the id is
      // taken from the flight and only the section comes from the capture.
      const feedbackSessionId = optimisticSessionId ?? initialSessionId;
      const sendStillOwnsCurrentSurface =
        (feedbackSessionId !== undefined &&
          isShellSurfaceOwnerActive({ ...sendOwner, sessionId: feedbackSessionId })) ||
        (newChatOwner !== null && isNewChatSendSurfaceActive(newChatOwner));
      if (!sendStillOwnsCurrentSurface) return false;
      if (isNoRealConnectionError(error)) {
        const reason = noRealConnectionReasonFromError(error);
        showModelSetupToast(noRealConnectionSetupDescription(reason, uiLocale), reason);
      } else if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(copy.sendFailedTitle, localizedShellErrorMessage(error, copy.sendFailedFallback, uiLocale));
      }
      return false;
    }
  }

  async function respondToSandboxBoundary(response: SandboxBoundaryResponse) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    try {
      await window.maka.sessions.respondToSandboxBoundary(sessionId, response);
      onInteractionChanged?.(sessionId);
      // #1611: the answer has been applied to the authoritative boundary, so
      // the permission label must stop describing the pre-decision one. The
      // ack event covers decisions settled on other surfaces; this covers the
      // one the user just made here, without waiting for the round trip.
      onExecutionBoundaryChanged?.(sessionId);
      setInteractionBySession((current) =>
        dequeueInteractionByRequestId(current, sessionId, response.requestId),
      );
    } catch (error) {
      // Same fire-and-forget call site as stop(), wrap so a failed
      // permission response (main process busy / session dropped)
      // surfaces instead of dying as UnhandledPromiseRejection.
      if (activeIdRef.current !== sessionId) return;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.responseFailedTitle,
          localizedShellErrorMessage(error, copy.responseFailedFallback, uiLocale),
        );
      }
    }
  }

  async function respondToUserQuestion(response: UserQuestionResponse) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    try {
      await window.maka.sessions.respondToUserQuestion(sessionId, response);
      onInteractionChanged?.(sessionId);
      setInteractionBySession((current) => dequeueInteractionByRequestId(current, sessionId, response.requestId));
    } catch (error) {
      if (activeIdRef.current !== sessionId) return;
      if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale);
      } else {
        toastApi.error(
          copy.responseFailedTitle,
          localizedShellErrorMessage(error, copy.responseFailedFallback, uiLocale),
        );
      }
    }
  }

  async function refreshMessages(sessionId: string, options: RefreshMessagesOptions = {}): Promise<boolean> {
    try {
      const result = await readSettledMessages(sessionId, options);
      const next = result.messages;
      if (activeIdRef.current === sessionId) {
        markSessionReadLocally(sessionId, next);
        setMessages(next);
        setMessageLoadErrorBySession((current) => {
          if (!current[sessionId]) return current;
          const updated = { ...current };
          delete updated[sessionId];
          return updated;
        });
      }
      return result.settled;
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const message = messageRefreshErrorMessage(error, uiLocale);
        setMessageLoadErrorBySession((current) => ({
          ...current,
          [sessionId]: message,
        }));
        toastApi.error(copy.refreshFailedTitle, message);
      }
      return false;
    }
  }
  async function retryMessages(sessionId: string) {
    if (!addPendingSessionAction(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession)) return;
    try {
      await refreshMessages(sessionId);
    } finally {
      clearPendingSessionAction(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession);
    }
  }

  async function refreshMessagesUntilTurn(sessionId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + USER_MESSAGE_VISIBLE_TIMEOUT_MS;
    while (Date.now() <= deadline) {
      // PR-FE-BUG-HUNT-4 (kenji bug-hunt 2026-06-24 LOW): bail if the
      // user navigated away from the session this poll was started for.
      // Previously the loop kept burning IPC bandwidth for the full
      // 1200ms after a session switch (the setState was gated, but the
      // readMessages call still fired every 40ms). Now we stop the
      // polling cycle itself.
      if (activeIdRef.current !== sessionId) return;
      try {
        const next = await window.maka.sessions.readMessages(sessionId);
        if (activeIdRef.current !== sessionId) return;
        const hasSentUserTurn = next.some((message) => message.type === 'user' && message.turnId === turnId);
        if (hasSentUserTurn) {
          markSessionReadLocally(sessionId, next);
          setMessages(next);
          return;
        }
      } catch {
        // Keep the current visible messages while the bounded retry loop
        // waits for the async send path to persist the first user message.
      }
      await new Promise((resolve) => window.setTimeout(resolve, USER_MESSAGE_VISIBLE_POLL_MS));
    }
    if (activeIdRef.current === sessionId) {
      await refreshMessages(sessionId);
    }
  }

  return {
    send,
    respondToSandboxBoundary,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  };
}
