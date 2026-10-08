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

import { createElement, useMemo, useSyncExternalStore, type ComponentType, type ComponentProps } from 'react';
import { ChatView, useUiLocale, type ComposerInteraction, type ComposerProps as UiComposerProps } from '@maka/ui';
import type { SessionStatus, StoredMessage } from '@maka/core/session';
import type { SessionUiReads } from '../model/session-ui-reads.js';
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import { transcriptRestoreTarget } from '../controller/transcript-reading-position.js';
import { useConversationOwner } from './conversation-context.js';
import { useConversationQueueCommands } from './conversation-provider.js';
import {
  useComposerSubmissionReader, useComposerTurnReader, type ComposerSubmissionReader,
} from './composer-submission-context.js';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';
import { chatTurnActivity } from '../../../application/contracts/session-execution.js';
import { useAppShellTurnPresentation } from '../../../application/contracts/turn-presentation.js';
import { getShellCopy } from '../../../locales/shell-copy.js';
import { composerTurnGates, desktopComposerSlashCommands } from '../model/composer-turn-gates.js';
import { executorComposerProps } from '../model/executor-composer.js';
import { liveTurnFlags } from '../model/live-turn-flags.js';

/** The displayed Session's Turn, read at chrome frequency. */
function useDisplayedTurn(reads: SessionUiReads, sessionId: string | undefined) {
  const summary = useSessionUiRead(reads, 'summary', sessionId);
  return { execution: summary.activeExecution, ...liveTurnFlags(summary.activeLiveTurnSnapshot, summary.activeExecution) };
}

type ChatProps = ComponentProps<typeof ChatView>;
type TranscriptProps = Pick<ChatProps,
  'onStreamingSettled' | 'messages' | 'transientMessages' | 'messageLoading' | 'messageLoadError' | 'messageLoadRetryPending' |
  'onRetryMessages' | 'hasEarlierHistory' | 'onLoadEarlierHistory' | 'transcriptTurnIndex' |
  'onLoadTranscriptTurn' | 'restoreTargetTurn' | 'onReadingAnchorChange' | 'viewportNavigation' |
  'deriveTurnPresentation' | 'safeResumeAction'
> & {
  activeSessionId: string | undefined; liveContentSeedGeneration: number; sessionUiReads: SessionUiReads;
  activeTurn: ReturnType<typeof chatTurnActivity>;
  sessionHealthModelPickerAvailable: boolean;
};
/** What the shell knows that the health notice's picker gate combines with the running Turn. */
type TranscriptGateInputs = {
  /** The owner Session's execution boundary admits local interaction. */
  localInteractionAvailable: boolean;
};

/** The actual transcript reader. Shell supplies presentation and navigation only. */
export function ConversationTranscriptRegion<P extends object>(
  props: { surface: ComponentType<P> } & TranscriptGateInputs & Omit<P, keyof TranscriptProps>,
) {
  const { surface, localInteractionAvailable, ...presentation } = props;
  const { workspace, commands, readingCommands } = useConversationOwner();
  // The narrow reader: a send or an edit draft does not repaint the transcript.
  const turnReader = useComposerTurnReader();
  // Pending Turn-footer marks come from the submission owner that sets them.
  const deriveTurnPresentation = useAppShellTurnPresentation({
    allowBranch: !turnReader.sharedSessionActive,
    activeId: turnReader.activeId,
    pendingTurnActions: turnReader.pendingTurnActions,
    uiLocale: useUiLocale(),
  });
  const turn = useDisplayedTurn(workspace.ui.reads, turnReader.activeId);
  const view = useSyncExternalStore(workspace.publication.subscribe, workspace.publication.getSnapshot);
  const load = useSessionUiRead(workspace.ui.reads, 'load', view.sessionId);
  const retryPending = useSessionUiRead(workspace.ui.reads, 'retry', view.sessionId);
  const sessionId = view.sessionId;
  const owned: TranscriptProps = {
    activeSessionId: sessionId,
    activeTurn: chatTurnActivity(turn.execution),
    onStreamingSettled: sessionId ? (messageId) => commands.settleAssistantStreaming(sessionId, messageId) : undefined,
    sessionUiReads: workspace.ui.reads,
    messages: view.messages, transientMessages: view.transientMessages,
    liveContentSeedGeneration: view.seedGeneration,
    messageLoading: Boolean(sessionId && view.loading),
    messageLoadError: load.messageLoadError,
    messageLoadRetryPending: retryPending,
    onRetryMessages: sessionId ? () => { void commands.retryMessages(sessionId); } : undefined,
    viewportNavigation: workspace.ui.transcriptViewportNavigation,
    hasEarlierHistory: view.range?.sessionId === sessionId ? view.range?.hasOlder : undefined,
    onLoadEarlierHistory: () => readingCommands.current?.loadEarlier(),
    transcriptTurnIndex: view.turnIndex?.sessionId === sessionId ? view.turnIndex?.turns : undefined,
    onLoadTranscriptTurn: (turn) => readingCommands.current?.loadEarlier(turn.sequence),
    restoreTargetTurn: transcriptRestoreTarget(sessionId ? workspace.ui.transcriptReadingAnchorBySessionRef.current[sessionId] : undefined, load.unavailableTranscriptRestore),
    onReadingAnchorChange: sessionId ? (turnId) => readingCommands.current?.captureAnchor(turnId) : undefined,
    deriveTurnPresentation,
    safeResumeAction: turnReader.safeResumeAction,
    // The notice's picker is held while a Turn runs, as the Composer's is;
    // `useShellChatModel` holds it for the Session's status.
    sessionHealthModelPickerAvailable: localInteractionAvailable && !turn.turnActive,
  };
  return createElement(surface, { ...presentation, ...owned } as unknown as P);
}

type SubmissionProps = Pick<ComposerSubmissionReader,
  | 'onSend' | 'newTaskSendPending' | 'stop'
  | 'respondToSandboxBoundary' | 'respondToUserQuestion' | 'respondToUserForm'
> & {
  onStop: ComposerSubmissionReader['stop'];
  resumeAction: ComposerSubmissionReader['composerResumeAction'];
  stopPending: boolean;
  revisionNotice?: { title: string; detail: string; cancelLabel: string; onCancel(): void };
};
type TurnGatedProps = ReturnType<typeof composerTurnGates> & ReturnType<typeof executorComposerProps> & {
  slashCommands: UiComposerProps['slashCommands'];
};
type ComposerProps = SubmissionProps & TurnGatedProps & {
  /** The owner's editor handle; regions outside Conversation get named edits instead. */
  composerRef: ReturnType<typeof useConversationQueueCommands>['composer'];
  processing: boolean; pendingMessages: ChatProps['transientMessages']; latestRequestUsageTokens?: number;
  /** The owner Session's open interaction; the Composer slot answers it. */
  activeInteraction: ComposerInteraction | undefined;
  queuedMessages: UiComposerProps['queuedMessages'];
  queuedMessageRevision: UiComposerProps['queuedMessageRevision'];
};
/** What the shell knows that the Turn gates combine with; the region reads the Turn itself. */
type ComposerGateInputs = {
  /** The displayed Session's catalog row: whether it has arrived, and its status. */
  sessionState: { loaded: boolean; status: SessionStatus | undefined };
  executorComposer: Omit<Parameters<typeof executorComposerProps>[1], 'activeId' | 'turnActive' | 'sendPending'> & {
    selection: Parameters<typeof executorComposerProps>[0];
  };
};
/** The shell's picker gates; an edit-and-resend draft narrows them here. */
type ComposerPickGates = { contextPickEnabled?: boolean; directoryPickerEnabled?: boolean };
/**
 * Lives in the persistent composer slot, outside the conditional transcript.
 * Submission state (send pending, Stop pending, the edit-and-resend draft) and
 * the submit, Stop and interaction-answer callbacks come from the Composer
 * submission owner. The displayed Session's Turn, its queue and the owner
 * Session's interaction are read here, so the controls a running Turn holds
 * repaint without the shell.
 */
export function ConversationComposerRegion<P extends object>(
  props: { surface: ComponentType<P>; usageModel?: string; usageRoute?: { llmConnectionId?: string } }
    & ComposerGateInputs & Omit<P, keyof ComposerProps>,
) {
  const { surface, usageModel, usageRoute, sessionState, executorComposer, ...presentation } = props;
  const { workspace } = useConversationOwner();
  const submission = useComposerSubmissionReader();
  const { ownerSessionId } = useComposerTurnReader();
  const composerRef = useConversationQueueCommands().composer;
  const uiLocale = useUiLocale();
  const actionCopy = getDesktopConversationCopy(uiLocale).actions;
  const shellCopy = getShellCopy(uiLocale).app;
  const activeId = useSyncExternalStore(workspace.target.subscribe, workspace.target.getSnapshot);
  const turn = useDisplayedTurn(workspace.ui.reads, activeId);
  const interaction = useSessionUiRead(workspace.ui.reads, 'interaction', ownerSessionId);
  const queue = useSessionUiRead(workspace.ui.reads, 'queue', activeId);
  const slashCommands = useMemo(
    () => desktopComposerSlashCommands(Boolean(activeId), turn.turnActive, shellCopy.slashCommands),
    [activeId, turn.turnActive, shellCopy.slashCommands],
  );
  const { selection: executor, ...executorInput } = executorComposer;
  const view = useSyncExternalStore(workspace.composer.subscribe, workspace.composer.getSnapshot);
  const usage = useMemo(() => workspace.usage(usageModel, usageRoute?.llmConnectionId), [workspace, usageModel, usageRoute?.llmConnectionId]);
  const latestRequestUsageTokens = useSyncExternalStore(usage.subscribe, usage.getSnapshot);
  const stopPending = useSessionUiRead(workspace.ui.reads, 'stop', activeId);
  const draft = submission.revisionDraft;
  const editing = draft !== null && activeId === draft.draftSessionId;
  const gates = presentation as ComposerPickGates;
  const owned: ComposerProps & ComposerPickGates = {
    composerRef,
    activeInteraction: interaction,
    queuedMessages: queue?.entries,
    queuedMessageRevision: queue?.queueRevision,
    slashCommands,
    ...composerTurnGates({
      activeId,
      sessionLoaded: sessionState.loaded,
      sessionStatus: sessionState.status,
      turnActive: turn.turnActive,
      streamingLive: turn.streamingLive,
      copy: shellCopy,
    }),
    // Executor changes and sends stay locked until the pending send's Host admission settles.
    ...executorComposerProps(executor, {
      ...executorInput, activeId, turnActive: turn.turnActive, sendPending: submission.newTaskSendPending,
    }),
    onSend: submission.onSend,
    newTaskSendPending: submission.newTaskSendPending,
    resumeAction: submission.composerResumeAction,
    onStop: submission.stop,
    stop: submission.stop,
    stopPending,
    respondToSandboxBoundary: submission.respondToSandboxBoundary,
    respondToUserQuestion: submission.respondToUserQuestion,
    respondToUserForm: submission.respondToUserForm,
    revisionNotice: editing
      ? {
          title: actionCopy.revisionBannerTitle,
          detail: actionCopy.revisionBannerDetail,
          cancelLabel: actionCopy.revisionCancelLabel,
          onCancel: submission.cancelRevisionDraft,
        }
      : undefined,
    ...(gates.contextPickEnabled !== undefined ? { contextPickEnabled: gates.contextPickEnabled && !editing } : {}),
    ...(gates.directoryPickerEnabled !== undefined
      ? { directoryPickerEnabled: gates.directoryPickerEnabled && draft === null }
      : {}),
    processing: view.transientMessages.length > 0,
    pendingMessages: view.transientMessages,
    latestRequestUsageTokens,
  };
  return createElement(surface, { ...presentation, ...owned } as unknown as P);
}

export function ConversationMessageConsumer<P extends { messages: readonly StoredMessage[] }>(
  props: { surface: ComponentType<P> } & Omit<P, 'messages'>,
) {
  const { surface, ...presentation } = props;
  const { workspace } = useConversationOwner();
  const messages = useSyncExternalStore(workspace.messages.subscribe, workspace.messages.getSnapshot);
  return createElement(surface, { ...presentation, messages } as unknown as P);
}

/** What the displayed Session is doing, for chrome outside the transcript and Composer. */
export interface ConversationActivity {
  /** A Host Turn runs and its execution is observable. */
  turnRunning: boolean;
  /** The owner Session waits on an interaction answer. */
  awaitingInteraction: boolean;
}

export function ConversationActivityConsumer<P extends { activity: ConversationActivity }>(
  props: { surface: ComponentType<P> } & Omit<P, 'activity'>,
) {
  const { surface, ...presentation } = props;
  const { workspace } = useConversationOwner();
  const { activeId, ownerSessionId } = useComposerTurnReader();
  const turn = useDisplayedTurn(workspace.ui.reads, activeId);
  const interaction = useSessionUiRead(workspace.ui.reads, 'interaction', ownerSessionId);
  const turnRunning = turn.executionAvailable && turn.turnActive;
  const awaitingInteraction = interaction !== undefined;
  const activity = useMemo(() => ({ turnRunning, awaitingInteraction }), [turnRunning, awaitingInteraction]);
  return createElement(surface, { ...presentation, activity } as unknown as P);
}

/**
 * The column a Session's transcript and Composer share. It is the home surface
 * while the shell's empty-transcript condition holds and the displayed Session
 * has neither live Turn content nor a failed load.
 */
export function ConversationHomeSurface(props: { eligible: boolean } & ComponentProps<'div'>) {
  const { eligible, ...column } = props;
  const { workspace } = useConversationOwner();
  const activeId = useSyncExternalStore(workspace.target.subscribe, workspace.target.getSnapshot);
  const turn = useDisplayedTurn(workspace.ui.reads, activeId);
  const { messageLoadError } = useSessionUiRead(workspace.ui.reads, 'load', activeId);
  const home = eligible && !turn.hasLiveContent && !messageLoadError;
  return createElement('div', { ...column, 'data-home-surface': home ? 'true' : undefined });
}
