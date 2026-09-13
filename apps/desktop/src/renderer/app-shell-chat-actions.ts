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
import type { StoredMessage } from '@maka/core/session';
import type { CollaborationMode } from '@maka/core/collaboration';
import type * as DesktopBridge from '../preload/bridge-contract.js';
import type { QuoteRef } from '@maka/core/events';
import type { OrchestrationMode } from '@maka/core/orchestration';
import type { SandboxBoundaryResponse } from '@maka/core/sandbox-boundary';
import type { SkillInvocationResult } from '@maka/runtime/skill-invocation';
import type { ThinkingLevel } from '@maka/core/model-thinking';
import type { TurnOrchestration } from '@maka/core/runtime-inputs';
import type { UiLocale } from '@maka/core/ui-locale';
import type { UserQuestionResponse } from '@maka/core/user-question';
import { DEFAULT_SESSION_NAME } from '@maka/core/session-name';
import {
  dequeueInteractionByRequestId,
  type InteractionQueues,
  type NavSelection,
  type TransientUserMessageProjection,
} from '@maka/ui';
import { messageRefreshErrorMessage } from './app-shell-copy.js';
import { getShellCopy, localizedShellErrorMessage } from './locales/shell-copy.js';
import { preflightAttachmentItems } from './attachment-preflight.js';
import {
  isSessionWorkspaceUnavailableError,
  showSessionWorkspaceUnavailableToast,
} from './session-workspace-errors.js';
import * as skillFeedback from './skill-invocation-feedback.js';
import type { DesktopTranscriptRangeController } from './platform/desktop/desktop-transcript-range-store.js';
import type { SessionPendingClaim } from './app-shell-session-ui-state.js';
import * as Conversation from './features/conversation/index.js';
import type { PendingAttachment } from './composer-attachments.js';

export interface WorkspaceFileReferencePosition {
  value: string;
  start: number;
}
import {
  isNoRealConnectionError,
  noRealConnectionReasonFromError,
  noRealConnectionSetupDescription,
} from './model-connection-errors.js';
import type { RefreshMessagesOptions } from './platform/desktop/session-message-settlement.js';

export type { RefreshMessagesOptions };

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
};

type RefBox<T> = { current: T };
type MessageLoadErrorUpdater = (updater: (current: Record<string, string>) => Record<string, string>) => void;
type InteractionQueueUpdater = (updater: (current: InteractionQueues) => InteractionQueues) => void;

type PendingNewChatModel = {
  llmConnectionId: string;
  llmConnectionSlug: string;
  model: string;
} | null;

type PendingNewChatThinkingLevel = ThinkingLevel | null;
type DesktopNewTaskTarget = DesktopBridge.DesktopNewTaskTarget;
type DesktopSessionSummary = DesktopBridge.DesktopSessionSummary;
type InteractionFormResponse = Parameters<
  DesktopBridge.MakaBridge['sessions']['respondToUserForm']
>[1];

type ToastApi = {
  error(
    title: string,
    description?: string,
    diagnosticDetails?: string,
    diagnosticTarget?: { sessionId: string } | { profileId: string },
  ): void;
  info(title: string, description?: string): void;
};

type DirectoryReferences = NonNullable<TransientUserMessageProjection['directoryReferences']>;
type MessageContextOptions = {
  directoryReferences?: DirectoryReferences;
  quotes?: readonly QuoteRef[];
  workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
};
type SendOptions = MessageContextOptions & {
  waitForHostAdmission?: boolean;
  turnOrchestration?: TurnOrchestration;
  displayText?: string;
  onSessionResolved?: (sessionId: string) => void;
};

function copiedArray<K extends string, T>(
  key: K,
  values: readonly T[] | undefined,
): Partial<Record<K, T[]>> {
  return values?.length ? { [key]: [...values] } as Record<K, T[]> : {};
}

export interface AppShellChatActions {
  send(
    text: string,
    pending?: readonly PendingAttachment[],
    options?: SendOptions,
  ): Promise<boolean>;
  /**
   * Resolves with whether the Message was sent. An unproven outcome counts as
   * sent — Runtime Host may well have it — so the caller does not offer the
   * same text twice; only a refusal is `false`.
   */
  enqueueMessage(
    sessionId: string,
    text: string,
    placement: 'current_turn' | 'next_turn',
    pending?: readonly PendingAttachment[],
    options?: MessageContextOptions,
  ): Promise<boolean>;
  respondToSandboxBoundary(response: SandboxBoundaryResponse): Promise<void>;
  respondToUserQuestion(response: UserQuestionResponse): Promise<void>;
  respondToUserForm(response: InteractionFormResponse): Promise<void>;
  refreshMessages(sessionId: string, options?: RefreshMessagesOptions): Promise<boolean>;
  retryMessages(sessionId: string): Promise<void>;
}

export function createAppShellChatActions(deps: {
  uiLocale: UiLocale;
  getRunningTurnId?: (sessionId: string) => string | undefined;
  activeIdRef: RefBox<string | undefined>;
  captureComposerImportOwner: () => ComposerImportOwner;
  checkTaskSubmissionReadiness: () => Promise<boolean>;
  isNewChatSendSurfaceActive: (owner: ComposerImportOwner) => boolean;
  /** The shell's one answer to "is this owner still the surface the user is
   *  looking at". Both halves matter — the section AND the session id — which
   *  is why the send path asks it instead of comparing the id itself. */
  isShellSurfaceOwnerActive: (owner: ComposerImportOwner) => boolean;
  messageRetryPending: SessionPendingClaim;
  refreshSessions: () => Promise<DesktopSessionSummary[]>;
  activateSessionForFirstSend: (sessionId: string) => Promise<void>;
  retireSession: (sessionId: string) => void;
  setMessageLoadErrorBySession: MessageLoadErrorUpdater;
  addTransientMessage: (
    sessionId: string,
    message: TransientUserMessageProjection,
  ) => void;
  updateTransientMessage: (
    sessionId: string,
    message: TransientUserMessageProjection,
  ) => void;
  removeTransientMessage: (sessionId: string, messageId: string) => void;
  transcriptRangeRef: RefBox<DesktopTranscriptRangeController | undefined>;
  isMessagePublished: (message: StoredMessage) => boolean;
  onFollowLatest: (sessionId: string) => Promise<boolean>;
  /** #646: arm the "正在处理…" indicator locally at send() — the model-wait
   * window opens before any SessionEvent arrives (turn_started is not one). */
  setInteractionBySession: InteractionQueueUpdater;
  onInteractionChanged?: (sessionId: string) => void;
  /** A boundary decision settled: the session's execution boundary may have moved. */
  onExecutionBoundaryChanged?: (sessionId: string) => void;
  respondToUserForm: DesktopBridge.MakaBridge['sessions']['respondToUserForm'];
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
    captureComposerImportOwner,
    checkTaskSubmissionReadiness,
    isNewChatSendSurfaceActive,
    isShellSurfaceOwnerActive,
    messageRetryPending,
    refreshSessions,
    activateSessionForFirstSend,
    retireSession,
    setMessageLoadErrorBySession,
    removeTransientMessage,
    transcriptRangeRef,
    onFollowLatest,
    setInteractionBySession,
    onInteractionChanged,
    onExecutionBoundaryChanged,
    respondToUserForm: submitUserForm,
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

  function removeOptimisticUserMessage(sessionId: string, turnId: string): void {
    removeTransientMessage(sessionId, turnId);
  }

  /**
   * What a submitted Message became, as far as this client can tell.
   *
   * `unreconciled` is the only outcome that leaves the transient row in place:
   * the answer was lost, so Runtime Host may well have acted on the Message and
   * canonical transcript is what settles it. A `refused` Message opened no Turn
   * and will never be replaced by a canonical one, so its row is already gone.
   */
  type SubmittedMessage =
    | { kind: 'projected'; skillInvocation: SkillInvocationResult; turnId?: string }
    | { kind: 'unreconciled' }
    | { kind: 'refused'; skillInvocation: SkillInvocationResult };

  /**
   * The one place a submitted Message's outcome becomes UI. Every submission —
   * first send, send into an existing Session, Follow Up — projects its row the
   * same way, so the rules for retiring and updating it cannot drift apart.
   */
  async function submitAndProject(input: {
    sessionId: string;
    messageId: string;
    placement: 'current_turn' | 'next_turn';
    command: Omit<
      Parameters<typeof window.maka.sessions.submitMessage>[2],
      'messageId'
    >;
    displayText?: string;
    quotes?: readonly QuoteRef[];
    pendingSteering?: boolean;
    waitForHostAdmission?: boolean;
    /** Whether this Session's surface is on screen to receive Skill feedback. */
    isSurfaceVisible?: () => boolean;
  }): Promise<SubmittedMessage> {
    const { sessionId, messageId, placement } = input;
    const directoryReferences = input.command.directoryReferences;
    const quotes = input.quotes ?? [];
    const result = await window.maka.sessions.submitMessage(sessionId, placement, {
      ...input.command,
      messageId,
    }, { waitForHostAdmission: input.waitForHostAdmission });
    const surfaceVisible = input.isSurfaceVisible?.() ?? true;
    if (!result.ok) {
      if (result.reason === 'outcome_unknown') {
        // The Message may well have been admitted, so its row stays for
        // canonical transcript to settle.
        return { kind: 'unreconciled' };
      }
      removeOptimisticUserMessage(sessionId, messageId);
      if (surfaceVisible) {
        skillFeedback.showSkillInvocationFeedback(uiLocale, toastApi, result.skillInvocation, sessionId);
      }
      return { kind: 'refused', skillInvocation: result.skillInvocation };
    }
    if (result.disposition === 'locally_saved') {
      return { kind: 'projected', skillInvocation: result.skillInvocation };
    }
    if (surfaceVisible) {
      skillFeedback.showSkillInvocationFeedback(uiLocale, toastApi, result.skillInvocation, sessionId);
    }
    // The row is updated whether or not the surface is on screen: attachments,
    // inline references and the Host Turn grouping are what the user finds when
    // they come back to it.
    publishTransientUserMessage(sessionId, {
      id: messageId,
      text: input.displayText ?? skillFeedback.skillInvocationDisplayText(input.command.text, result.skillInvocation),
      attachments: [...result.attachments],
      transientPlacement: placement,
      pendingSteering: result.disposition === 'turn_started' ? false : input.pendingSteering,
      ...(result.turnId ? { hostTurnId: result.turnId } : {}),
      ...copiedArray('directoryReferences', directoryReferences),
      ...copiedArray('quotes', quotes),
      inlineReferences: [...(result.inlineReferences ?? [])],
    }, true);
    return {
      kind: 'projected',
      skillInvocation: result.skillInvocation,
      ...(result.turnId ? { turnId: result.turnId } : {}),
    };
  }

  async function send(
    text: string,
    pending?: readonly PendingAttachment[],
    options: SendOptions = {},
  ): Promise<boolean> {
    const directoryReferences = options.directoryReferences;
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
        retireSession(sessionId);
        await refreshSessions();
      } catch {
        // Best-effort: a failed cleanup must not replace the real error.
      }
    };
    try {
      const messageId = crypto.randomUUID();
      async function submitIntoSession(sessionId: string, messageId: string) {
        const attachmentItems =
          pending?.length
            ? Conversation.toComposerIngestItems(pending)
            : undefined;
        const retainedAttachments =
          pending?.length
            ? Conversation.retainedAttachmentRefs(pending)
            : undefined;
        const sendCommand = {
          text,
          ...(options.displayText ? { displayText: options.displayText } : {}),
          ...copiedArray('attachmentItems', attachmentItems),
          ...copiedArray('retainedAttachments', retainedAttachments),
          ...copiedArray('directoryReferences', directoryReferences),
          ...copiedArray('quotes', quotes),
          ...copiedArray('workspaceFileReferences', options.workspaceFileReferences),
        };
        return submitAndProject({
          sessionId,
          messageId,
          placement: exactTurn ? 'current_turn' : 'next_turn',
          command: {
            ...sendCommand,
            ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
          },
          ...(options.displayText ? { displayText: options.displayText } : {}),
          ...copiedArray('quotes', quotes),
          pendingSteering: false,
          waitForHostAdmission: options.waitForHostAdmission,
          isSurfaceVisible: () => activeIdRef.current === sessionId,
        });
      }
      if (!initialSessionId) {
        if (!initialNewTaskTarget) return false;
        if (pending?.length) preflightAttachmentItems(pending);
        const session = await window.maka.newTasks.create(initialNewTaskTarget, {
          name: DEFAULT_SESSION_NAME,
          ...(newChatModel
            ? {
                llmConnectionId: newChatModel.llmConnectionId,
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
        optimisticSessionId = session.id;
        optimisticMessageId = messageId;
        // Stage the first row before activation. `setActiveId` projects this
        // session-owned transient in the same state transition that replaces
        // the new-chat surface, so the empty-session Maka hero cannot paint
        // between observation settling and the submitted content appearing.
        publishTransientUserMessage(session.id, {
          id: messageId, text: options.displayText ?? text, transientPlacement: 'current_turn',
          ...copiedArray('directoryReferences', directoryReferences),
          ...copiedArray('quotes', quotes),
          inlineReferences: [],
        });
        // Consumed: the choice is now the created Session's, not the next
        // draft's. A failed create leaves it in place so a retry keeps it.
        if (newChatPermissionChoice) clearNewChatPermissionChoice();
        // Main owns observation-before-dispatch. This only selects the local
        // surface; saving a draft never waits for the Host's event stream.
        await activateSessionForFirstSend(session.id);
        if (activeIdRef.current !== session.id) {
          removeOptimisticUserMessage(session.id, messageId);
          await discardUnsentSession();
          return false;
        }
        const submitted = await submitIntoSession(session.id, messageId);
        if (submitted.kind === 'refused') {
          await discardUnsentSession();
          return false;
        }
        unsentSessionId = undefined;
        // The callback fires only when this send's first message projected;
        // an unreconciled first message stays unreported.
        if (submitted.kind === 'projected') options.onSessionResolved?.(session.id);
        void refreshSessions().catch(() => undefined);
        return true;
      }
      const sessionId = initialSessionId;
      if (!await onFollowLatest(sessionId)) return false;
      optimisticSessionId = sessionId;
      optimisticMessageId = messageId;
      publishTransientUserMessage(sessionId, {
        id: messageId, text: options.displayText ?? text, transientPlacement: 'current_turn',
        ...copiedArray('directoryReferences', directoryReferences),
        ...copiedArray('quotes', quotes),
        inlineReferences: [],
      });
      const submitted = await submitIntoSession(sessionId, messageId);
      // An existing-Session send never reports a resolved Session.
      return submitted.kind !== 'refused';
    } catch (error) {
      // Capture ownership before cleanup clears the optimistic Session. A
      // barrier timeout belongs to the surface that was waiting for it, while
      // navigation away still suppresses feedback.
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
      await discardUnsentSession();
      if (optimisticSessionId && optimisticMessageId) {
        removeOptimisticUserMessage(optimisticSessionId, optimisticMessageId);
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
    options: MessageContextOptions = {},
  ): Promise<boolean> {
    const messageId = crypto.randomUUID();
    const steeringTurnId = placement === 'current_turn' ? deps.getRunningTurnId?.(sessionId) : undefined;
    const directoryReferences = options.directoryReferences;
    const quotes = options.quotes ?? [];
    publishTransientUserMessage(sessionId, {
      id: messageId, text, attachments: Conversation.retainedAttachmentRefs(pending ?? []),
      pendingSteering: placement === 'current_turn',
      ...(steeringTurnId ? { hostTurnId: steeringTurnId } : {}),
      transientPlacement: placement,
      ...copiedArray('directoryReferences', directoryReferences),
      ...copiedArray('quotes', quotes),
      inlineReferences: [],
    });
    try {
      const attachmentItems = pending?.length ? Conversation.toComposerIngestItems(pending) : [];
      const retainedAttachments = pending?.length ? Conversation.retainedAttachmentRefs(pending) : [];
      const submitted = await submitAndProject({
        sessionId,
        messageId,
        placement,
        pendingSteering: placement === 'current_turn',
        command: {
          text,
          ...copiedArray('attachmentItems', attachmentItems),
          ...copiedArray('retainedAttachments', retainedAttachments),
          ...copiedArray('directoryReferences', directoryReferences),
          ...copiedArray('quotes', quotes),
          ...copiedArray('workspaceFileReferences', options.workspaceFileReferences),
        },
        ...copiedArray('quotes', quotes),
        isSurfaceVisible: () => activeIdRef.current === sessionId,
      });
      // A refused Message opened nothing and left no row. Reporting it as sent
      // would clear the composer draft the user has to retry from.
      return submitted.kind !== 'refused';
    } catch (error) {
      removeOptimisticUserMessage(sessionId, messageId);
      throw error;
    }
  }

  async function respondToInteraction<Response extends { requestId: string }>(
    response: Response,
    submit: (sessionId: string, response: Response) => Promise<void>,
    onApplied?: (sessionId: string) => void,
  ) {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    try {
      await submit(sessionId, response);
      onInteractionChanged?.(sessionId);
      onApplied?.(sessionId);
      setInteractionBySession((current) =>
        dequeueInteractionByRequestId(current, sessionId, response.requestId),
      );
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
      const snapshot = controller.store.snapshot();
      if (snapshot.sessionId !== sessionId) return false;
      // Store changes already publish through its active subscription. A
      // refresh checks readiness; it must not bypass input-held publication.
      setMessageLoadErrorBySession((current) => {
        if (!current[sessionId]) return current;
        const updated = { ...current };
        delete updated[sessionId];
        return updated;
      });
      // The live answer stays visible until the durable answer reaches the
      // published view. Its existing publication effect retries this handoff.
      return requiredMessageId === undefined || snapshot.messages.some(
        (message) => message.id === requiredMessageId && deps.isMessagePublished(message),
      );
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
    if (!messageRetryPending.claim(sessionId)) return;
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
      messageRetryPending.release(sessionId);
    }
  }

  function publishTransientUserMessage(
    sessionId: string,
    message: Omit<TransientUserMessageProjection, 'ts'>,
    updateOnly = false,
  ): void {
    (updateOnly ? deps.updateTransientMessage : deps.addTransientMessage)(sessionId, { ...message, ts: Date.now() });
    if (activeIdRef.current !== sessionId) return;
    setMessageLoadErrorBySession((current) => {
      if (!current[sessionId]) return current;
      const cleared = { ...current };
      delete cleared[sessionId];
      return cleared;
    });
  }

  return {
    send,
    enqueueMessage,
    respondToSandboxBoundary: (response) =>
      respondToInteraction(
        response,
        window.maka.sessions.respondToSandboxBoundary,
        onExecutionBoundaryChanged,
      ),
    respondToUserQuestion: (response) =>
      respondToInteraction(response, window.maka.sessions.respondToUserQuestion),
    respondToUserForm: (response) => respondToInteraction(response, submitUserForm),
    refreshMessages,
    retryMessages,
  };
}
