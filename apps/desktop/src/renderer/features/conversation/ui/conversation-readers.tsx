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
import { ChatView, useUiLocale, type ComposerProps as UiComposerProps } from '@maka/ui';
import type { StoredMessage } from '@maka/core/session';
import type { SessionUiReads } from '../model/session-ui-reads.js';
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import { transcriptRestoreTarget } from '../controller/transcript-reading-position.js';
import { useConversationOwner } from './conversation-context.js';
import { useComposerSubmissionReader, type ComposerSubmissionReader } from './composer-submission-context.js';
import { getDesktopConversationCopy } from '../../../application/contracts/conversation-copy.js';

type ChatProps = ComponentProps<typeof ChatView>;
type TranscriptProps = Pick<ChatProps,
  'onStreamingSettled' | 'messages' | 'transientMessages' | 'messageLoading' | 'messageLoadError' | 'messageLoadRetryPending' |
  'onRetryMessages' | 'hasEarlierHistory' | 'onLoadEarlierHistory' | 'transcriptTurnIndex' |
  'onLoadTranscriptTurn' | 'restoreTargetTurn' | 'onReadingAnchorChange' | 'viewportNavigation'
> & { activeSessionId: string | undefined; liveContentSeedGeneration: number; sessionUiReads: SessionUiReads };

/** The actual transcript reader. Shell supplies presentation and navigation only. */
export function ConversationTranscriptRegion<P extends object>(
  props: { surface: ComponentType<P> } & Omit<P, keyof TranscriptProps>,
) {
  const { surface, ...presentation } = props;
  const { workspace, commands, readingCommands } = useConversationOwner();
  const view = useSyncExternalStore(workspace.publication.subscribe, workspace.publication.getSnapshot);
  const load = useSessionUiRead(workspace.ui.reads, 'load', view.sessionId);
  const retryPending = useSessionUiRead(workspace.ui.reads, 'retry', view.sessionId);
  const sessionId = view.sessionId;
  const owned: TranscriptProps = {
    activeSessionId: sessionId,
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
  };
  return createElement(surface, { ...presentation, ...owned } as unknown as P);
}

type SubmissionProps = Pick<ComposerSubmissionReader,
  | 'onSend' | 'newTaskSendPending' | 'stop'
  | 'respondToSandboxBoundary' | 'respondToUserQuestion' | 'respondToUserForm'
> & {
  onStop: ComposerSubmissionReader['stop'];
  stopPending: boolean;
  revisionNotice?: { title: string; detail: string; cancelLabel: string; onCancel(): void };
};
type ComposerProps = SubmissionProps & {
  processing: boolean; pendingMessages: ChatProps['transientMessages']; latestRequestUsageTokens?: number;
};
/** The shell's picker gates; an edit-and-resend draft narrows them here. */
type ComposerPickGates = { contextPickEnabled?: boolean; directoryPickerEnabled?: boolean } &
  Pick<UiComposerProps, 'executorPicker' | 'sendBlocked'>;
/**
 * Lives in the persistent composer slot, outside the conditional transcript.
 * Submission state (send pending, Stop pending, the edit-and-resend draft) and
 * the submit, Stop and interaction-answer callbacks come from the Composer
 * submission owner.
 */
export function ConversationComposerRegion<P extends object>(
  props: { surface: ComponentType<P>; usageModel?: string; usageRoute?: { llmConnectionId?: string } } & Omit<P, keyof ComposerProps>,
) {
  const { surface, usageModel, usageRoute, ...presentation } = props;
  const { workspace } = useConversationOwner();
  const submission = useComposerSubmissionReader();
  const actionCopy = getDesktopConversationCopy(useUiLocale()).actions;
  const activeId = useSyncExternalStore(workspace.target.subscribe, workspace.target.getSnapshot);
  const view = useSyncExternalStore(workspace.composer.subscribe, workspace.composer.getSnapshot);
  const usage = useMemo(() => workspace.usage(usageModel, usageRoute?.llmConnectionId), [workspace, usageModel, usageRoute?.llmConnectionId]);
  const latestRequestUsageTokens = useSyncExternalStore(usage.subscribe, usage.getSnapshot);
  const stopPending = useSessionUiRead(workspace.ui.reads, 'stop', activeId);
  const draft = submission.revisionDraft;
  const editing = draft !== null && activeId === draft.draftSessionId;
  const gates = presentation as ComposerPickGates;
  const owned: ComposerProps & ComposerPickGates = {
    onSend: submission.onSend,
    newTaskSendPending: submission.newTaskSendPending,
    sendBlocked: gates.sendBlocked || submission.newTaskSendPending,
    ...(gates.executorPicker ? {
      executorPicker: { ...gates.executorPicker, disabled: gates.executorPicker.disabled || submission.newTaskSendPending },
    } : {}),
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
