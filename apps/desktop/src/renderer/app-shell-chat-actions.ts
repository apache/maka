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

import type { CollaborationMode } from '@maka/core/collaboration';
import type { DesktopNewTaskTarget } from '../preload/bridge-contract.js';
import type { InlineReference, QuoteRef } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { StoredMessage } from '@maka/core/session';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
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
import type { DesktopTranscriptRangeController } from './desktop-transcript-range-store.js';

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
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  setActiveId: (sessionId: string | undefined) => void;
  setMessageLoadErrorBySession: MessageLoadErrorUpdater;
  setMessageRetryPendingBySession: BooleanRecordUpdater;
  setMessages: MessageListUpdater;
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
  upsertSessionSummary: (session: DesktopSessionSummary) => void;
  newChatModel: PendingNewChatModel;
  pendingNewChatThinkingLevel: PendingNewChatThinkingLevel;
  newChatPermissionMode: ChatDefaultPermissionMode;
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
    markSessionReadLocally,
    messageRetryPendingRef,
    refreshSessions,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessageRetryPendingBySession,
    setMessages,
    transcriptRangeRef,
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
    newChatPermissionMode,
    newChatCollaborationMode,
    newChatOrchestrationMode,
    newTaskTarget,
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

  // Rename only the exact unconfirmed arm this send created. Host events can
  // beat the IPC response (main emits the sessions-changed nudge before it
  // returns), and an authoritative projection that already arrived for the
  // Host-chosen turn must not be replaced with a fresh waiting arm.
  function rebindTurnActive(sessionId: string, fromTurnId: string, toTurnId: string): void {
    setLiveTurnBySession((current) => {
      const active = current[sessionId];
      if (!active || active.turnId !== fromTurnId || !active.unconfirmed || active.phase !== 'waiting') {
        return current;
      }
      return { ...current, [sessionId]: armLiveTurn(toTurnId) };
    });
  }

  // One interpretation of a successful sessions:send for both the new-chat and
  // existing-session branches: a busy-raced send can come back `steered` (this
  // send owns no turn — the steering_message event renders the text) or under
  // a Host-chosen turnId. Returns the turn the send owns, if any.
  function settleSendBookkeeping(
    sessionId: string,
    requestedTurnId: string,
    sendResult: { steered?: true; turnId?: string },
  ): string | undefined {
    if (sendResult.steered) {
      disarmTurnActive(sessionId, requestedTurnId);
      return undefined;
    }
    const startedTurnId = sendResult.turnId ?? requestedTurnId;
    if (startedTurnId !== requestedTurnId) {
      rebindTurnActive(sessionId, requestedTurnId, startedTurnId);
    }
    return startedTurnId;
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
          permissionMode: newChatPermissionMode,
          collaborationMode: newChatCollaborationMode,
          orchestrationMode: newChatOrchestrationMode,
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
            showSkillInvocationFeedback(
              uiLocale,
              toastApi,
              sendResult.skillInvocation,
              session.id,
            );
          }
          disarmTurnActive(session.id, turnId);
          await discardUnsentSession();
          return false;
        }
        unsentSessionId = undefined;
        const settledTurnId = settleSendBookkeeping(session.id, turnId, sendResult);
        if (settledTurnId !== undefined) optimisticTurnId = settledTurnId;
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
          if (settledTurnId !== undefined) {
            showOptimisticUserMessage(
              session.id,
              settledTurnId,
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
          showSkillInvocationFeedback(
            uiLocale,
            toastApi,
            sendResult.skillInvocation,
            sessionId,
          );
        }
        disarmTurnActive(sessionId, turnId);
        return false;
      }
      const startedTurnId = settleSendBookkeeping(sessionId, turnId, sendResult);
      options.onSessionResolved?.(sessionId);
      if (startedTurnId === undefined) return true;
      optimisticTurnId = startedTurnId;
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
        startedTurnId,
        options.displayText ??
          skillInvocationDisplayText(text, sendResult.skillInvocation),
        sendResult.attachments,
        {
          ...(quotes && quotes.length > 0 ? { quotes } : {}),
          inlineReferences: sendResult.inlineReferences ?? [],
        },
      );
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
      markSessionReadLocally(sessionId, next);
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
    respondToSandboxBoundary,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  };
}
