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
import type { SkillInvocationResult } from '@maka/runtime/skill-invocation';
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
  type TransientUserMessageProjection,
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
import type { SessionPendingClaim } from './app-shell-session-ui-state.js';
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
import type { MessageListUpdater } from './session-workspace-actions.js';

export type { RefreshMessagesOptions };

type ComposerImportOwner = {
  sessionId: string | undefined;
  navSection: NavSelection['section'];
  newTaskDraftKey?: string;
};

type RefBox<T> = { current: T };
type LiveTurnRecordUpdater = (
  updater: (current: Record<string, LiveTurnProjection>) => Record<string, LiveTurnProjection>,
) => void;
type MessageLoadErrorUpdater = (updater: (current: Record<string, string>) => Record<string, string>) => void;
type InteractionQueueUpdater = (updater: (current: InteractionQueues) => InteractionQueues) => void;

type PendingNewChatModel = {
  llmConnectionId: string;
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

type DirectoryReferences = NonNullable<TransientUserMessageProjection['directoryReferences']>;
type MessageContextOptions = {
  directoryReferences?: DirectoryReferences;
  quotes?: readonly QuoteRef[];
  workspaceFileReferences?: readonly WorkspaceFileReferencePosition[];
};
type SendOptions = MessageContextOptions & {
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
  refreshMessages(sessionId: string, options?: RefreshMessagesOptions): Promise<boolean>;
  retryMessages(sessionId: string): Promise<void>;
}

export function createAppShellChatActions(deps: {
  uiLocale: UiLocale;
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
  setActiveId: (sessionId: string | undefined) => void;
  setMessageLoadErrorBySession: MessageLoadErrorUpdater;
  setMessages: MessageListUpdater;
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
    captureComposerImportOwner,
    checkTaskSubmissionReadiness,
    isNewChatSendSurfaceActive,
    isShellSurfaceOwnerActive,
    messageRetryPending,
    refreshSessions,
    activateSessionForFirstSend,
    setActiveId,
    setMessageLoadErrorBySession,
    setMessages,
    addTransientMessage,
    updateTransientMessage,
    removeTransientMessage,
    transcriptRangeRef,
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

  function showTransientUserMessage(
    sessionId: string,
    messageId: string,
    text: string,
    attachments: readonly import('@maka/core/events').AttachmentRef[] = [],
    options: {
      placement?: TransientUserMessageProjection['transientPlacement'];
      hostTurnId?: string;
      updateOnly?: boolean;
      directoryReferences?: DirectoryReferences;
      quotes?: readonly QuoteRef[];
      inlineReferences?: readonly InlineReference[];
    } = {},
  ): void {
    const directoryReferences = options.directoryReferences;
    const quotes = options.quotes ?? [];
    const next: TransientUserMessageProjection = {
      id: messageId,
      ts: Date.now(),
      text,
      ...copiedArray('attachments', attachments),
      ...copiedArray('directoryReferences', directoryReferences),
      ...copiedArray('quotes', quotes),
      inlineReferences: [...(options.inlineReferences ?? [])],
      transientPlacement: options.placement ?? 'current_turn',
      ...(options.hostTurnId ? { hostTurnId: options.hostTurnId } : {}),
    };
    if (options.updateOnly) updateTransientMessage(sessionId, next);
    else addTransientMessage(sessionId, next);
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

  /**
   * The arm was placed under the client's Message identity because that is all
   * the client had; Runtime Host answers with the Turn identity every later
   * event will carry. Adopt it, but only while the arm is still the one this
   * send placed and still waiting — once the authority has said anything about
   * a Turn here, that Turn is the one on screen and renaming it would retire
   * the wrong claim.
   */
  function rebindTurnActive(sessionId: string, fromTurnId: string, toTurnId: string): void {
    if (fromTurnId === toTurnId) return;
    setLiveTurnBySession((current) => {
      const active = current[sessionId];
      if (active?.turnId !== fromTurnId || !active.unconfirmed) return current;
      return { ...current, [sessionId]: { ...active, turnId: toTurnId } };
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
    exactTurn?: boolean;
    /** Whether this Session's surface is on screen to receive Skill feedback. */
    isSurfaceVisible?: () => boolean;
  }): Promise<SubmittedMessage> {
    const { sessionId, messageId, placement } = input;
    const directoryReferences = input.command.directoryReferences;
    const quotes = input.quotes ?? [];
    const result = await window.maka.sessions.submitMessage(sessionId, placement, {
      ...input.command,
      messageId,
    });
    const surfaceVisible = input.isSurfaceVisible?.() ?? true;
    if (!result.ok) {
      if (result.reason === 'outcome_unknown') {
        // The Message may well have been admitted, so its row stays for
        // canonical transcript to settle. The Turn arm is a different claim:
        // nothing proves a Turn opened under this identity, and no event
        // carrying it will ever arrive to retire it.
        if (input.exactTurn) disarmTurnActive(sessionId, messageId);
        return { kind: 'unreconciled' };
      }
      removeOptimisticUserMessage(sessionId, messageId);
      if (input.exactTurn) disarmTurnActive(sessionId, messageId);
      if (surfaceVisible) {
        showSkillInvocationFeedback(uiLocale, toastApi, result.skillInvocation, sessionId);
      }
      return { kind: 'refused', skillInvocation: result.skillInvocation };
    }
    if (input.exactTurn) {
      if (result.disposition === 'turn_started' && result.turnId) {
        rebindTurnActive(sessionId, messageId, result.turnId);
      } else {
        // Host admitted the Message into a Turn this send did not open, so the
        // arm placed for an exact Turn describes nothing.
        disarmTurnActive(sessionId, messageId);
      }
    }
    if (surfaceVisible) {
      showSkillInvocationFeedback(uiLocale, toastApi, result.skillInvocation, sessionId);
    }
    // The row is updated whether or not the surface is on screen: attachments,
    // inline references and the Host Turn grouping are what the user finds when
    // they come back to it.
    showTransientUserMessage(
      sessionId,
      messageId,
      input.displayText ??
        skillInvocationDisplayText(input.command.text, result.skillInvocation),
      result.attachments,
      {
        updateOnly: true,
        placement,
        ...(result.turnId ? { hostTurnId: result.turnId } : {}),
        ...copiedArray('directoryReferences', directoryReferences),
        ...copiedArray('quotes', quotes),
        inlineReferences: result.inlineReferences ?? [],
      },
    );
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
        if (activeIdRef.current === sessionId) setActiveId(undefined);
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
        showTransientUserMessage(
          session.id,
          messageId,
          options.displayText ?? text,
          [],
          {
            ...copiedArray('directoryReferences', directoryReferences),
            ...copiedArray('quotes', quotes),
            inlineReferences: [],
          },
        );
        // Consumed: the choice is now the created Session's, not the next
        // draft's. A failed create leaves it in place so a retry keeps it.
        if (newChatPermissionChoice) clearNewChatPermissionChoice();
        // Active-stream snapshots can only restore assistant segments that
        // are still streaming. Wait until the observer is ready before the
        // first admission so a completed segment in a still-running Turn
        // cannot become durable text without live identity.
        await activateSessionForFirstSend(session.id);
        if (activeIdRef.current !== session.id) {
          removeOptimisticUserMessage(session.id, messageId);
          await discardUnsentSession();
          return false;
        }
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
          text,
          ...(options.displayText ? { displayText: options.displayText } : {}),
          ...copiedArray('attachmentItems', attachmentItems),
          ...(retainedAttachments && retainedAttachments.length > 0
            ? { retainedAttachments }
            : {}),
          ...copiedArray('directoryReferences', directoryReferences),
          ...copiedArray('quotes', quotes),
          ...copiedArray('workspaceFileReferences', options.workspaceFileReferences),
        };
        const submitted = await submitAndProject({
          sessionId: session.id,
          messageId,
          placement: 'current_turn',
          command: {
            ...sendCommand,
            ...(options.turnOrchestration
              ? { turnOrchestration: options.turnOrchestration }
              : {}),
          },
          ...(options.displayText ? { displayText: options.displayText } : {}),
          ...copiedArray('quotes', quotes),
          exactTurn,
          isSurfaceVisible: () => activeIdRef.current === session.id,
        });
        if (submitted.kind === 'refused') {
          await discardUnsentSession();
          return false;
        }
        unsentSessionId = undefined;
        options.onSessionResolved?.(session.id);
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
      showTransientUserMessage(
        sessionId,
        messageId,
        options.displayText ?? text,
        [],
        {
          ...copiedArray('directoryReferences', directoryReferences),
          ...copiedArray('quotes', quotes),
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
        text,
        ...(options.displayText ? { displayText: options.displayText } : {}),
        ...copiedArray('attachmentItems', attachmentItems),
        ...(retainedAttachments && retainedAttachments.length > 0
          ? { retainedAttachments }
          : {}),
        ...copiedArray('directoryReferences', directoryReferences),
        ...copiedArray('quotes', quotes),
        ...copiedArray('workspaceFileReferences', options.workspaceFileReferences),
      };
      const submitted = await submitAndProject({
        sessionId,
        messageId,
        placement: 'current_turn',
        command: {
          ...sendCommand,
          ...(options.turnOrchestration ? { turnOrchestration: options.turnOrchestration } : {}),
        },
        ...(options.displayText ? { displayText: options.displayText } : {}),
        ...copiedArray('quotes', quotes),
        exactTurn,
        isSurfaceVisible: () => activeIdRef.current === sessionId,
      });
      if (submitted.kind === 'refused') return false;
      if (submitted.kind === 'unreconciled') return true;
      options.onSessionResolved?.(sessionId);
      return true;
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
    const directoryReferences = options.directoryReferences;
    const quotes = options.quotes ?? [];
    showTransientUserMessage(sessionId, messageId, text, retainedAttachmentRefs(pending ?? []), {
      placement,
      ...copiedArray('directoryReferences', directoryReferences),
      ...copiedArray('quotes', quotes),
      inlineReferences: [],
    });
    try {
      const attachmentItems = pending?.length ? toComposerIngestItems(pending) : [];
      const retainedAttachments = pending?.length ? retainedAttachmentRefs(pending) : [];
      const submitted = await submitAndProject({
        sessionId,
        messageId,
        placement,
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

  return {
    send,
    enqueueMessage,
    respondToSandboxBoundary,
    respondToUserQuestion,
    refreshMessages,
    retryMessages,
  };
}
