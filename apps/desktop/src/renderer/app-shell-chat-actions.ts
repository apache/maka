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

import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import type { CollaborationMode } from '@maka/core/collaboration';
import type { DesktopNewTaskTarget } from '../preload/bridge-contract.js';
import type { InlineReference, QuoteRef } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { StoredMessage } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import type { UiLocale } from '@maka/core/ui-locale';
import type { DesktopSessionSummary } from '../preload/bridge-contract.js';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';
import {
  armLiveTurn,
  dequeueInteractionByRequestId,
  type InteractionQueues,
  type LiveTurnProjection,
  type NavSelection,
} from '@maka/ui';
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
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';
import {
  retainedAttachmentRefs,
  toComposerIngestItems,
  type PendingAttachment,
} from './composer-attachments.js';

export interface WorkspaceFileReferencePosition {
  value: string;
  start: number;
}
import {
  isNoRealConnectionError,
  noRealConnectionReasonFromError,
  noRealConnectionSetupDescription,
} from './model-connection-errors.js';
import type { RefreshMessagesOptions } from './session-message-settlement.js';

export type { RefreshMessagesOptions };

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
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
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
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
  enqueueMessage(
    sessionId: string,
    text: string,
    placement: 'current_turn' | 'next_turn',
    pending?: readonly PendingAttachment[],
    options?: {
      quotes?: readonly QuoteRef[];
      workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
    },
  ): Promise<void>;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(response: UserQuestionResponse): Promise<void>;
  refreshMessages(sessionId: string, options?: RefreshMessagesOptions): Promise<boolean>;
  retryMessages(sessionId: string): Promise<void>;
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
  messageRetryPendingRef: RefBox<Set<string>>;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessageLoadErrorBySession: MessageLoadErrorUpdater;
  setMessageRetryPendingBySession: BooleanRecordUpdater;
  setMessages: MessageListUpdater;
  addTransientMessage: (
    sessionId: string,
    message: Extract<StoredMessage, { type: 'user' }>,
  ) => void;
  updateTransientMessage?: (
    sessionId: string,
    message: Extract<StoredMessage, { type: 'user' }>,
  ) => void;
  removeTransientMessage: (sessionId: string, messageId: string) => void;
  transcriptRangeRef: RefBox<DesktopTranscriptRangeController | undefined>;
  setNavSelection: (selection: NavSelection) => void;
  /** #646: arm the "正在处理…" indicator locally at send() — the model-wait
   * window opens before any SessionEvent arrives (turn_started is not one). */
  setLiveTurnBySession: LiveTurnRecordUpdater;
  setInteractionBySession: InteractionQueueUpdater;
  onInteractionChanged?: (sessionId: string) => void;
  /** A boundary decision settled: the session's execution boundary may have moved. */
  onExecutionBoundaryChanged?: (sessionId: string) => void;
  showModelSetupToast: (
    description: string,
    reason?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ) => void;
  toastApi: ToastApi;
  newChatModel: PendingNewChatModel;
  pendingNewChatThinkingLevel: PendingNewChatThinkingLevel;
  /**
   * The user's explicit choice for this draft, or undefined when they made
   * none. Undefined omits the field on create so the Host applies its own
   * `chatDefaults`; a value is a real per-Session override and is sent once.
   */
  newChatPermissionChoice: ChatDefaultPermissionMode | undefined;
  /**
   * Drops the draft's permission choice once it has reached a created Session.
   * The choice is keyed by Host/project target rather than by draft, so
   * without this the next task on the same target would silently re-send it.
   */
  clearNewChatPermissionChoice: () => void;
  newChatCollaborationMode: CollaborationMode;
  newChatOrchestrationMode: OrchestrationMode;
  newTaskTarget: DesktopNewTaskTarget | undefined;
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
    messageRetryPendingRef,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    addTransientMessage,
    updateTransientMessage,
    removeTransientMessage,
    transcriptRangeRef,
    setNavSelection,
    setLiveTurnBySession,
    setInteractionBySession,
    onInteractionChanged,
    onExecutionBoundaryChanged,
    showModelSetupToast,
    toastApi,
    newChatModel,
    pendingNewChatThinkingLevel,
    newChatPermissionChoice,
    clearNewChatPermissionChoice,
    newChatCollaborationMode,
    newChatOrchestrationMode,
    newTaskTarget,
  } = deps;
  const copy = getShellCopy(uiLocale).chatActions;

  function optimisticUserMessage(
    messageId: string,
    turnId: string,
    text: string,
    attachments: readonly import('@maka/core/events').AttachmentRef[] = [],
    quotes: readonly QuoteRef[] = [],
    inlineReferences: readonly InlineReference[] = [],
  ): Extract<StoredMessage, { type: 'user' }> {
    return {
      type: 'user',
      id: messageId,
      // StoredMessage requires a grouping key, but transient messages are
      // rendered beside the Turn projection. Canonical transcript data later
      // supplies the Host-owned grouping for this same message id.
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
    messageId: string,
    text: string,
    attachments: readonly import('@maka/core/events').AttachmentRef[] = [],
    options: {
      turnId?: string;
      updateOnly?: boolean;
      quotes?: readonly QuoteRef[];
      inlineReferences?: readonly InlineReference[];
    } = {},
  ): void {
    const next = optimisticUserMessage(
      messageId,
      options.turnId ?? messageId,
      text,
      attachments,
      options.quotes,
      options.inlineReferences,
    );
    if (options.updateOnly) {
      (updateTransientMessage ?? addTransientMessage)(sessionId, next);
    } else {
      addTransientMessage(sessionId, next);
    }
    if (activeIdRef.current !== sessionId) return;
    setMessageLoadErrorBySession((current) => {
      if (!current[sessionId]) return current;
      const cleared = { ...current };
      delete cleared[sessionId];
      return cleared;
    });
  }

  function removeOptimisticUserMessage(sessionId: string, turnId: string): void {
    removeTransientMessage(sessionId, turnId);
  }

  // Explicit orchestration reserves an exact Turn identity before IPC, so its
  // renderer command surface keeps the existing first-token wait. Ordinary
  // messages never call this path: LocalIntent presents the message and the
  // Host subscription alone introduces the actual Turn.
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
    const exactTurn = options.turnOrchestration !== undefined;
    const initialSessionId = activeIdRef.current;
    const initialNewTaskTarget = initialSessionId ? undefined : newTaskTarget;
    const sendOwner = captureComposerImportOwner();
    const newChatOwner = initialSessionId ? null : sendOwner;
    if (!initialSessionId && !initialNewTaskTarget) return false;
    if (!(await checkTaskSubmissionReadiness())) return false;
    if (
      (initialSessionId && !isShellSurfaceOwnerActive(sendOwner)) ||
      (newChatOwner && !isNewChatSendSurfaceActive(newChatOwner))
    ) {
      return false;
    }
    let optimisticSessionId: string | undefined;
    let optimisticMessageId: string | undefined;
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
      const messageId = crypto.randomUUID();
      if (!initialSessionId) {
        if (!initialNewTaskTarget) return false;
        if (pending && pending.length > 0) preflightAttachmentItems(pending, uiLocale);
        const session = await window.maka.newTasks.create(initialNewTaskTarget, {
          name: DEFAULT_SESSION_NAME,
          ...(newChatModel
            ? {
                llmConnectionSlug: newChatModel.llmConnectionSlug,
                model: newChatModel.model,
              }
            : {}),
          ...(pendingNewChatThinkingLevel ? { thinkingLevel: pendingNewChatThinkingLevel } : {}),
          ...(newChatPermissionChoice ? { permissionMode: newChatPermissionChoice } : {}),
          collaborationMode: newChatCollaborationMode,
          orchestrationMode: newChatOrchestrationMode,
        });
        unsentSessionId = session.id;
        // Consumed: the choice is now the created Session's, not the next
        // draft's. A failed create leaves it in place so a retry keeps it.
        if (newChatPermissionChoice) clearNewChatPermissionChoice();
        optimisticSessionId = session.id;
        optimisticMessageId = messageId;
        showOptimisticUserMessage(
          session.id,
          messageId,
          options.displayText ?? text,
          [],
          {
            ...(quotes && quotes.length > 0 ? { quotes } : {}),
            inlineReferences: [],
          },
        );
        if (exactTurn) armTurnActive(session.id, messageId);
        const attachmentItems =
          pending && pending.length > 0
            ? toComposerIngestItems(pending)
            : undefined;
        const retainedAttachments =
          pending && pending.length > 0
            ? retainedAttachmentRefs(pending)
            : undefined;
        const sendCommand = {
          type: 'send' as const,
          text,
          ...(options.displayText ? { displayText: options.displayText } : {}),
          ...(attachmentItems && attachmentItems.length > 0 ? { attachmentItems } : {}),
          ...(retainedAttachments && retainedAttachments.length > 0
            ? { retainedAttachments }
            : {}),
          ...(quotes && quotes.length > 0 ? { quotes: [...quotes] } : {}),
          ...(options.workspaceFileReferences && options.workspaceFileReferences.length > 0
            ? { workspaceFileReferences: [...options.workspaceFileReferences] }
            : {}),
        };
        const sendResult = options.turnOrchestration
          ? await window.maka.sessions.send(session.id, {
              ...sendCommand,
              turnId: messageId,
              turnOrchestration: options.turnOrchestration,
            })
          : await window.maka.sessions.submitMessage(session.id, {
              ...sendCommand,
              messageId,
            });
        if (!sendResult.ok) {
          if (sendResult.reason === 'outcome_unknown') {
            unsentSessionId = undefined;
            options.onSessionResolved?.(session.id);
            if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
              setNavSelection({ section: 'sessions' });
              setActiveId(session.id);
            }
            await refreshSessions();
            return true;
          }
          removeOptimisticUserMessage(session.id, messageId);
          if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
            showSkillInvocationFeedback(
              uiLocale,
              toastApi,
              sendResult.skillInvocation,
              session.id,
            );
          }
          if (exactTurn) disarmTurnActive(session.id, messageId);
          await discardUnsentSession();
          return false;
        }
        unsentSessionId = undefined;
        options.onSessionResolved?.(session.id);
        if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
          showSkillInvocationFeedback(
            uiLocale,
            toastApi,
            sendResult.skillInvocation,
            session.id,
          );
        }
        if (newChatOwner && isNewChatSendSurfaceActive(newChatOwner)) {
          setNavSelection({ section: 'sessions' });
          setActiveId(session.id);
          showOptimisticUserMessage(
            session.id,
            messageId,
            options.displayText ??
              skillInvocationDisplayText(text, sendResult.skillInvocation),
            sendResult.attachments,
            {
              turnId: sendResult.turnId ?? messageId,
              updateOnly: true,
              ...(quotes && quotes.length > 0 ? { quotes } : {}),
              inlineReferences: sendResult.inlineReferences ?? [],
            },
          );
        }
        await refreshSessions();
        return true;
      }
      const sessionId = initialSessionId;
      const transcript = transcriptRangeRef.current;
      if (transcript) {
        let hasNewer = false;
        try {
          const range = transcript.store.range();
          hasNewer = range.sessionId === sessionId && range.hasNewer;
        } catch {
          // An unopened transcript is not a sparse historical view.
        }
        if (hasNewer) {
          await transcript.loadLatest();
          if (activeIdRef.current !== sessionId || transcriptRangeRef.current !== transcript) {
            return false;
          }
          setMessages([...transcript.store.snapshot().messages]);
        }
      }
      optimisticSessionId = sessionId;
      optimisticMessageId = messageId;
      showOptimisticUserMessage(
        sessionId,
        messageId,
        options.displayText ?? text,
        [],
        {
          ...(quotes && quotes.length > 0 ? { quotes } : {}),
          inlineReferences: [],
        },
      );
      if (exactTurn) armTurnActive(sessionId, messageId);
      const attachmentItems =
        pending && pending.length > 0
          ? toComposerIngestItems(pending)
          : undefined;
      const retainedAttachments =
        pending && pending.length > 0
          ? retainedAttachmentRefs(pending)
          : undefined;
      const sendCommand = {
        type: 'send' as const,
        text,
        ...(options.displayText ? { displayText: options.displayText } : {}),
        ...(attachmentItems && attachmentItems.length > 0 ? { attachmentItems } : {}),
        ...(retainedAttachments && retainedAttachments.length > 0
          ? { retainedAttachments }
          : {}),
        ...(quotes && quotes.length > 0 ? { quotes: [...quotes] } : {}),
        ...(options.workspaceFileReferences && options.workspaceFileReferences.length > 0
          ? { workspaceFileReferences: [...options.workspaceFileReferences] }
          : {}),
      };
      const sendResult = options.turnOrchestration
        ? await window.maka.sessions.send(sessionId, {
            ...sendCommand,
            turnId: messageId,
            turnOrchestration: options.turnOrchestration,
          })
        : await window.maka.sessions.submitMessage(sessionId, {
            ...sendCommand,
            messageId,
          });
      if (!sendResult.ok) {
        if (sendResult.reason === 'outcome_unknown') return true;
        removeOptimisticUserMessage(sessionId, messageId);
        if (activeIdRef.current === sessionId) {
          showSkillInvocationFeedback(
            uiLocale,
            toastApi,
            sendResult.skillInvocation,
            sessionId,
          );
        }
        if (exactTurn) disarmTurnActive(sessionId, messageId);
        return false;
      }
      options.onSessionResolved?.(sessionId);
      if (activeIdRef.current === sessionId) {
        showSkillInvocationFeedback(
          uiLocale,
          toastApi,
          sendResult.skillInvocation,
          sessionId,
        );
      }
      showOptimisticUserMessage(
        sessionId,
        messageId,
        options.displayText ??
          skillInvocationDisplayText(text, sendResult.skillInvocation),
        sendResult.attachments,
        {
          turnId: sendResult.turnId ?? messageId,
          updateOnly: true,
          ...(quotes && quotes.length > 0 ? { quotes } : {}),
          inlineReferences: sendResult.inlineReferences ?? [],
        },
      );
      return true;
    } catch (error) {
      await discardUnsentSession();
      if (optimisticSessionId && optimisticMessageId) {
        removeOptimisticUserMessage(optimisticSessionId, optimisticMessageId);
      }
      // The turn never reached the runtime — close the model-wait window so the
      // "正在处理…" indicator doesn't hang after a failed send. Nothing else has
      // to be undone: the arm was the only claim the send made, and no
      // subscribeChanges event would reconcile a turn that never started.
      if (exactTurn && optimisticSessionId && optimisticMessageId) {
        disarmTurnActive(optimisticSessionId, optimisticMessageId);
      }
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
      const diagnosticTarget = feedbackSessionId
        ? { sessionId: feedbackSessionId }
        : initialNewTaskTarget
          ? { profileId: initialNewTaskTarget.profileId }
          : undefined;
      const sendStillOwnsCurrentSurface =
        (feedbackSessionId !== undefined &&
          isShellSurfaceOwnerActive({
            ...sendOwner,
            sessionId: feedbackSessionId,
          })) ||
        (newChatOwner !== null && isNewChatSendSurfaceActive(newChatOwner));
      if (!sendStillOwnsCurrentSurface) return false;
      if (isNoRealConnectionError(error)) {
        const reason = noRealConnectionReasonFromError(error);
        showModelSetupToast(
          noRealConnectionSetupDescription(reason, uiLocale),
          reason,
          diagnosticTarget,
        );
      } else if (isSessionWorkspaceUnavailableError(error)) {
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale, diagnosticTarget);
      } else {
        toastApi.error(
          copy.sendFailedTitle,
          localizedShellErrorMessage(error, copy.sendFailedFallback, uiLocale),
          undefined,
          diagnosticTarget,
        );
      }
      return false;
    }
  }

  async function enqueueMessage(
    sessionId: string,
    text: string,
    placement: 'current_turn' | 'next_turn',
    pending?: readonly PendingAttachment[],
    options: {
      quotes?: readonly QuoteRef[];
      workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
    } = {},
  ): Promise<void> {
    const messageId = crypto.randomUUID();
    const quotes = options.quotes ?? [];
    showOptimisticUserMessage(sessionId, messageId, text, retainedAttachmentRefs(pending ?? []), {
      ...(quotes.length > 0 ? { quotes } : {}),
      inlineReferences: [],
    });
    try {
      const attachmentItems = pending?.length ? toComposerIngestItems(pending) : [];
      const retainedAttachments = pending?.length ? retainedAttachmentRefs(pending) : [];
      const result = await window.maka.sessions.enqueue(sessionId, placement, {
        messageId,
        text,
        ...(attachmentItems.length > 0 ? { attachmentItems } : {}),
        ...(retainedAttachments.length > 0 ? { retainedAttachments } : {}),
        ...(quotes.length > 0 ? { quotes: [...quotes] } : {}),
        ...(options.workspaceFileReferences?.length
          ? { workspaceFileReferences: [...options.workspaceFileReferences] }
          : {}),
      });
      if (result.kind === 'outcome_unknown') return;
      showOptimisticUserMessage(sessionId, messageId, text, result.attachments, {
        updateOnly: true,
        ...(quotes.length > 0 ? { quotes } : {}),
        inlineReferences: result.inlineReferences,
      });
    } catch (error) {
      removeOptimisticUserMessage(sessionId, messageId);
      throw error;
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
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale, { sessionId });
      } else {
        toastApi.error(
          copy.responseFailedTitle,
          localizedShellErrorMessage(error, copy.responseFailedFallback, uiLocale),
          undefined,
          { sessionId },
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
        showSessionWorkspaceUnavailableToast(toastApi, uiLocale, { sessionId });
      } else {
        toastApi.error(
          copy.responseFailedTitle,
          localizedShellErrorMessage(error, copy.responseFailedFallback, uiLocale),
          undefined,
          { sessionId },
        );
      }
    }
  }

  async function refreshMessages(sessionId: string, options: RefreshMessagesOptions = {}): Promise<boolean> {
    try {
      if (activeIdRef.current !== sessionId) return false;
      const controller = transcriptRangeRef.current;
      if (!controller) return false;
      await controller.ready();
      if (activeIdRef.current !== sessionId || transcriptRangeRef.current !== controller) return false;
      const requiredMessageId = options.requiredAssistantMessageId;
      if (
        requiredMessageId !== undefined &&
        !controller.store.hasDurableMessage(requiredMessageId) &&
        !(await controller.waitForDurableMessage(requiredMessageId, 480))
      ) {
        return false;
      }
      if (activeIdRef.current !== sessionId || transcriptRangeRef.current !== controller) {
        return false;
      }
      const range = controller.store;
      const snapshot = range.snapshot();
      if (snapshot.sessionId !== sessionId) return false;
      const next = [...snapshot.messages];
      setMessages(next);
      setMessageLoadErrorBySession((current) => {
        if (!current[sessionId]) return current;
        const updated = { ...current };
        delete updated[sessionId];
        return updated;
      });
      return requiredMessageId === undefined || range.hasDurableMessage(requiredMessageId);
    } catch (error) {
      if (activeIdRef.current === sessionId) {
        const message = messageRefreshErrorMessage(error, uiLocale);
        setMessageLoadErrorBySession((current) => ({
          ...current,
          [sessionId]: message,
        }));
        toastApi.error(copy.refreshFailedTitle, message, undefined, { sessionId });
      }
      return false;
    }
  }
  async function retryMessages(sessionId: string) {
    if (!addPendingSessionAction(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession)) return;
    try {
      if (activeIdRef.current !== sessionId) return;
      await transcriptRangeRef.current?.reload();
    } catch (error) {
      if (activeIdRef.current !== sessionId) return;
      const message = messageRefreshErrorMessage(error, uiLocale);
      setMessageLoadErrorBySession((current) => ({
        ...current,
        [sessionId]: message,
      }));
      toastApi.error(copy.refreshFailedTitle, message, undefined, { sessionId });
    } finally {
      clearPendingSessionAction(sessionId, messageRetryPendingRef, setMessageRetryPendingBySession);
    }
  }

  return {
    send,
    enqueueMessage,
    respondToSandboxBoundary,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  };
}
