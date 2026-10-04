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

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InlineReference } from '@maka/core/events';
import { useToast, useUiLocale } from '@maka/ui';
import { NEW_TASK_PENDING_KEY } from '@maka/ui/pending-items';
import { activeHostTurn } from '../../../application/contracts/session-execution.js';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import { parseDesktopSlashCommand } from '../../../application/contracts/desktop-slash-command.js';
import { catalogWatchedRowsUsable } from '../../../application/contracts/session-catalog/catalog-row-watch.js';
import { useSessionCatalogController } from '../../../application/contracts/session-catalog/session-catalog-state.js';
import { useStableActions } from '../../../application/contracts/use-stable-actions.js';
import { getShellCopy, localizedShellErrorMessage } from '../../../locales/shell-copy.js';
import type {
  ComposerNewTaskSubmission,
  ComposerSubmissionCommands,
  ComposerSubmissionShell,
  ComposerSurfaceOwner,
} from '../model/composer-submission-contract.js';
import type { ComposerStagingCommands } from '../model/composer-staging-contract.js';
import { mergeWorkspaceReferences, rebaseWorkspaceFileReferences } from '../model/follow-up-submit-routing.js';
import { useComposerSubmissionServices } from '../submission-services.js';
import { useConversationOwner } from '../ui/conversation-context.js';
import { useConversationQueueCommands } from '../ui/conversation-provider.js';
import { createChatActions } from './chat-actions.js';
import { createRevisionAwareOnSend, createStagedFollowUp } from './composer-submit.js';
import { createStopAction, type StopOutcome } from './stop-action.js';
import { createTurnActions } from './turn-actions.js';
import { useTurnActionRegistry } from './use-turn-action-registry.js';
import { useShellResume } from './use-shell-resume.js';
import {
  abandonTurnRevisionCopyAttempt,
  completeTurnRevisionCopyAttempt,
  createRevisionActions,
  type TurnRevisionDraft,
} from './revision-actions.js';

/**
 * Called only by `ComposerSubmissionProvider`. Owns the send-pending flag, the
 * edit-and-resend draft and the Composer's submit, Stop, Turn-branch and
 * interaction-answer paths; the shell supplies navigation and other features'
 * commands, and reads none of this state.
 */
export function useComposerSubmission<Owner extends ComposerSurfaceOwner>(input: {
  readonly staging: ComposerStagingCommands;
  readonly shell: ComposerSubmissionShell<Owner>;
  readonly newTask: ComposerNewTaskSubmission;
  readonly sharedSessionActive: boolean;
  /** The readable, non-shared Host Session; the resume offer is read for it. */
  readonly ownerSessionId: string | undefined;
}) {
  const { staging, shell, newTask, sharedSessionActive, ownerSessionId } = input;
  const services = useComposerSubmissionServices();
  const { workspace, commands } = useConversationOwner();
  const sessionCatalog = useSessionCatalogController();
  const queue = useConversationQueueCommands();
  const composerRef = queue.composer;
  const uiLocale = useUiLocale();
  const toastApi = useToast();
  const activeIdRef = workspace.publishedSession;
  const activeId = useSyncExternalStore(workspace.target.subscribe, workspace.target.getSnapshot);
  // Pending Turn-footer marks: the actions below set them, the transcript reads them.
  const turnActionRegistry = useTurnActionRegistry();
  // One instance behind both the banner and the send slot, so the two can never
  // race a second resume request past the first.
  const resume = useShellResume({
    activeId,
    ownerActiveId: ownerSessionId,
    sharedSessionActive,
    toastApi,
    shellCopy: getShellCopy(uiLocale).app,
    uiLocale,
  });
  // A withdrawn send — an edited queue entry or a cancelled local message —
  // hands its staged context back under the key of the Session it left, so the
  // restore lands there even after navigation; the text goes through the
  // editor's keyed draft beside it.
  useLayoutEffect(() => {
    const slot = queue.draftContextRestorer;
    const restore: NonNullable<typeof slot.current> = (sessionId, draft) => staging.restoreContext(sessionId, draft);
    slot.current = restore;
    return () => { if (slot.current === restore) slot.current = undefined; };
  }, [queue, staging]);

  // Held for the whole of a send; see ChatComposerRegion.
  const [newTaskSendPending, setNewTaskSendPending] = useState(false);
  const [revisionDraft, setRevisionDraft] = useState<TurnRevisionDraft | null>(null);
  const revisionDraftRef = useRef<TurnRevisionDraft | null>(null);
  const retractedWorkspaceReferencesRef = useRef<Record<string, InlineReference[]>>({});
  const commitRevisionDraft = useCallback((draft: TurnRevisionDraft | null) => {
    revisionDraftRef.current = draft;
    setRevisionDraft(draft);
  }, []);

  const chat = useStableActions(createChatActions<Owner>, {
    services,
    uiLocale,
    getRunningTurnId: (sessionId) => {
      if (sessionId !== activeIdRef.current) return undefined;
      return activeHostTurn(workspace.ui.reads.summary(sessionId).getSnapshot().activeExecution)?.turnId;
    },
    activeIdRef,
    captureComposerImportOwner: shell.captureOwner,
    captureSelection: commands.captureSelection,
    checkTaskSubmissionReadiness: async () =>
      !sharedSessionActive && (!!activeIdRef.current || !!newTask.target),
    isNewChatSendSurfaceActive: shell.isNewChatOwnerActive,
    isShellSurfaceOwnerActive: shell.isOwnerActive,
    refreshSessions: shell.refreshSessions,
    activateSessionForFirstSend: shell.activateFirstSendSession,
    retireSession: shell.retireSession,
    clearMessageLoadError: commands.clearMessageLoadError,
    addTransientMessage: commands.addTransientMessage,
    updateTransientMessage: commands.updateTransientMessage,
    removeTransientMessage: commands.removeTransientMessage,
    onFollowLatest: commands.prepareSend,
    settleInteraction: commands.settleInteraction,
    onInteractionChanged: commands.markInteractionChanged,
    onExecutionBoundaryChanged: shell.reloadExecutionBoundary,
    respondToUserForm: shell.respondToUserForm,
    showModelSetupToast: shell.showModelSetupToast,
    toastApi,
    newChatModel: newTask.model,
    pendingNewChatThinkingLevel: newTask.thinkingLevel,
    executorSelection: newTask.executorSelection,
    executorEntry: newTask.executorEntry,
    newChatPermissionChoice: newTask.permissionChoice,
    clearNewChatPermissionChoice: newTask.clearPermissionChoice,
    newChatCollaborationMode: newTask.collaborationMode,
    newChatOrchestrationMode: newTask.orchestrationMode,
    newTaskTarget: newTask.target,
  });

  const revision = useStableActions(createRevisionActions, {
    services,
    uiLocale,
    activeIdRef,
    captureSelection: commands.captureSelection,
    composerRef,
    readMessages: commands.readMessages,
    hasPendingAttachments: () => staging.captureSubmission().hasPendingContext,
    openSessionInChat: shell.openSession,
    refreshSessions: shell.refreshSessions,
    commitRevisionDraft,
    revisionDraftRef,
    toastApi,
  });

  // The Composer's Stop button, Escape and a question prompt's Stop all land
  // here; the send slot may then offer Resume for the stopped Turn (#5923).
  // Built before onSend so plain-Enter interrupt can pin the same stop path.
  const [inFlightStops] = useState(() => new Map<string, Promise<StopOutcome>>());
  const { stopSession } = useStableActions((deps: Parameters<typeof createStopAction>[0]) => ({
    stopSession: createStopAction(deps),
  }), {
    services,
    uiLocale,
    activeIdRef,
    stopPending: workspace.ui.stopPending,
    removeTransientMessage: commands.removeTransientMessage,
    toastApi,
    inFlight: inFlightStops,
  });
  const stop = useCallback(() => {
    void stopSession();
  }, [stopSession]);

  // The Composer's submit callback, built by the shared factory its tests drive.
  const { onSend } = useStableActions((ports: Parameters<typeof createRevisionAwareOnSend<TurnRevisionDraft>>[0]) => ({
    onSend: createRevisionAwareOnSend(ports),
  }), {
    shellCopy: getShellCopy(uiLocale).app,
    toastApi,
    activeIdRef,
    revisionDraftRef,
    composerRef,
    retractedWorkspaceReferencesRef,
    captureStaging: staging.captureSubmission,
    prepareRevisionSend: revision.prepareRevisionSend,
    send: chat.send,
    completeRevisionCopyAttempt: completeTurnRevisionCopyAttempt,
    parseSlashCommand: parseDesktopSlashCommand,
    mergeWorkspaceReferences,
    rebaseWorkspaceFileReferences,
    revisionUnavailableCopy: getDesktopConversationCopy(uiLocale).actions,
    compactSession: commands.compactSession,
    enqueueFollowUp: createStagedFollowUp({
      captureStaging: staging.captureSubmission,
      enqueueMessage: chat.enqueueMessage,
      onError(sessionId, error) {
        if (activeIdRef.current !== sessionId) return;
        const copy = getDesktopConversationCopy(uiLocale).actions;
        toastApi.error(
          copy.operationFailedTitle,
          localizedShellErrorMessage(error, copy.operationFailedFallback, uiLocale),
          undefined,
          { sessionId },
        );
      },
    }),
    settleNewTaskImageNoticeOwner: (sourceSessionId) => {
      const createdSessionId = activeIdRef.current;
      if (!sourceSessionId && createdSessionId) {
        staging.transferImageNotice(NEW_TASK_PENDING_KEY, createdSessionId);
      }
    },
    commitRevisionDraft,
    resolveNewTaskSessionHandler: () => shell.bindNewTaskSessionResolver(commands.readSelectionRevision()),
    openSideChat: shell.openSideChat,
    getActiveOrchestrationMode: shell.orchestrationMode,
    setOrchestrationModeActive: shell.setOrchestrationModeActive,
    setNewTaskSendPending,
    // #4083: plain Enter interrupts the live turn before a new root send.
    interrupt: {
      stop: stopSession,
      liveTurns: (id) => workspace.ui.reads.liveTurns(id).getSnapshot(),
      runningTurnIds: (id) =>
        sessionCatalog.getState().sessions.find((session) => session.id === id)?.runningTurnIds,
      activeSessionId: () => activeIdRef.current,
      toastApi,
      uiLocale,
    },
  });

  const turn = useStableActions(createTurnActions, {
    services,
    uiLocale,
    activeIdRef,
    captureSelection: commands.captureSelection,
    turnActionRegistry,
    openSessionInChat: shell.openSession,
    refreshSessions: shell.refreshSessions,
    toastApi,
  });

  // The draft survives on exactly two catalog rows; their departure retires it.
  const retireRevisionDraftIfRowsLeave = useCallback(
    (rows: Parameters<typeof catalogWatchedRowsUsable>[0]) => {
      const draft = revisionDraftRef.current;
      if (!draft) return;
      // A watched row that is merely pending — never observed, never reported
      // removed — is admission lag, not a departure.
      if (catalogWatchedRowsUsable(rows)) return;
      composerRef.current?.clearDraft(draft.draftSessionId);
      if (draft.sourceSessionId !== draft.draftSessionId) composerRef.current?.clearDraft(draft.sourceSessionId);
      if (draft.copyPhase === 'reserved') completeTurnRevisionCopyAttempt(draft);
      else void abandonTurnRevisionCopyAttempt(services, draft);
      commitRevisionDraft(null);
    },
    [commitRevisionDraft, composerRef, services],
  );

  const shellCommands = useMemo<ComposerSubmissionCommands>(() => ({
    beginEditUserMessage: (turnId) => revision.beginEditUserMessage(turnId),
    handleTurnFooterAction: (turnId, actionId) => turn.handleTurnFooterAction(turnId, actionId),
    clearPendingTurnActions: (sessionId) => turnActionRegistry.clearForSession(sessionId),
  }), [revision, turn, turnActionRegistry.clearForSession]);
  const reader = useMemo(() => ({
    onSend,
    newTaskSendPending,
    revisionDraft,
    cancelRevisionDraft: () => { void revision.cancelRevisionDraft(); },
    respondToSandboxBoundary: chat.respondToSandboxBoundary,
    respondToUserQuestion: chat.respondToUserQuestion,
    respondToUserForm: chat.respondToUserForm,
    stop,
    composerResumeAction: resume.composerResumeAction,
  }), [chat, newTaskSendPending, onSend, resume.composerResumeAction, revision, revisionDraft, stop]);
  // What the transcript and the chrome readers take, apart from the Composer's
  // submission state, so a send or an edit draft does not repaint the transcript.
  const turnReader = useMemo(() => ({
    activeId,
    ownerSessionId,
    sharedSessionActive,
    pendingTurnActions: turnActionRegistry.keys,
    safeResumeAction: resume.safeResumeAction,
  }), [activeId, ownerSessionId, resume.safeResumeAction, sharedSessionActive, turnActionRegistry.keys]);
  return {
    shellCommands,
    reader,
    turnReader,
    // Local delivery recovery publishes into, and restores drafts for, the
    // Session the Composer shows.
    localMessages: {
      publish: commands.addTransientMessage,
      retire: commands.removeTransientMessage,
      reportError: toastApi.error,
      restoreDraft: queue.restoreDraft,
    },
    revisionWatch: {
      sessionIds: [revisionDraft?.sourceSessionId, revisionDraft?.draftSessionId] as const,
      onRows: retireRevisionDraftIfRowsLeave,
    },
  };
}
