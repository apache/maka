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
import { ChatView } from '@maka/ui';
import type { StoredMessage } from '@maka/core/session';
import type { SessionUiReads } from '../model/session-ui-reads.js';
import { useSessionUiRead } from '../controller/use-session-ui-read.js';
import { transcriptRestoreTarget } from '../controller/transcript-reading-position.js';
import { useConversationOwner } from './conversation-context.js';

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

type ComposerProps = { processing: boolean; pendingMessages: ChatProps['transientMessages']; latestRequestUsageTokens?: number };
/** Lives in the persistent composer slot, outside the conditional transcript. */
export function ConversationComposerRegion<P extends object>(
  props: { surface: ComponentType<P>; usageModel?: string; usageRoute?: { llmConnectionId?: string } } & Omit<P, keyof ComposerProps>,
) {
  const { surface, usageModel, usageRoute, ...presentation } = props;
  const { workspace } = useConversationOwner();
  const view = useSyncExternalStore(workspace.composer.subscribe, workspace.composer.getSnapshot);
  const usage = useMemo(() => workspace.usage(usageModel, usageRoute?.llmConnectionId), [workspace, usageModel, usageRoute?.llmConnectionId]);
  const latestRequestUsageTokens = useSyncExternalStore(usage.subscribe, usage.getSnapshot);
  return createElement(surface, {
    ...presentation,
    processing: view.transientMessages.length > 0,
    pendingMessages: view.transientMessages,
    latestRequestUsageTokens,
  } as unknown as P);
}

/** A cross-feature leaf can read published messages without routing them through Shell. */
export function ConversationMessageConsumer<P extends { messages: readonly StoredMessage[] }>(
  props: { surface: ComponentType<P> } & Omit<P, 'messages'>,
) {
  const { surface, ...presentation } = props;
  const { workspace } = useConversationOwner();
  const messages = useSyncExternalStore(workspace.messages.subscribe, workspace.messages.getSnapshot);
  return createElement(surface, { ...presentation, messages } as unknown as P);
}
