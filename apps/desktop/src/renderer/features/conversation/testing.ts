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

import type { ConversationServices } from './ports.js';
import { createSessionUiState, type AppShellSessionUiState } from './model/session-ui-state.js';

export {
  createAppShellSessionUiStateController as createProductionSessionUiStateController,
  clearAppShellSessionUiStateForSession,
  createInitialAppShellSessionUiState,
  type AppShellSessionUiState,
} from './model/session-ui-state.js';

/** Production controller with inspection available only to tests. */
export function createAppShellSessionUiStateController(initialState?: AppShellSessionUiState) {
  const { controller, getState } = createSessionUiState(initialState);
  return { ...controller, getState };
}

export {
  createTranscriptRestoreLifecycle,
  prepareTranscriptForSend,
  restoreSessionTranscriptRange,
} from './controller/transcript-reading-position.js';
export { shellSessionRowEqual } from './model/conversation-catalog-row.js';
export {
  type ActiveExecutionBoundarySnapshot,
  activeExecutionBoundaryOf,
  activeExecutionBoundaryUnreadable,
  startActiveExecutionBoundaryRead,
} from './controller/use-active-execution-boundary.js';
export { useSessionMessageQueue } from './controller/use-session-message-queue.js';

/** Inert conversation services; a test overrides only the calls it observes. */
export function stubConversationServices(
  overrides: Partial<Omit<ConversationServices, 'sessions'>> & {
    readonly sessions?: Partial<ConversationServices['sessions']>;
  } = {},
): ConversationServices {
  const { sessions, ...rest } = overrides;
  return {
    observation: { openTranscript() { throw new Error('Transcript observation not configured'); }, subscribeEvents: () => () => {}, listActiveInteractions: async () => [], subscribeActiveInteractions: () => () => {}, shellRuns: { list: async () => [], subscribeUpdates: () => () => {}, subscribeResync: () => () => {} }, subscribeVisible: () => () => {}, queryCancelledMessages: async () => ({ cancelledMessageIds: [] }) },
    listMessages: async () => [],
    cancelMessage: async () => undefined,
    reconcileMessage: async () => undefined,
    subscribeChanges: () => () => undefined,
    skills: { listInvocable: async () => [] },
    runtimeHosts: { subscribeChanges: () => () => undefined },
    resume: {
      queryPlan: async () => {
        throw new Error('Resume plan query is not stubbed');
      },
      start: async () => {
        throw new Error('Resume start is not stubbed');
      },
      subscribeChanges: () => () => undefined,
    },
    workspace: { searchFiles: async () => ({ ok: false, reason: 'no_project' }) },
    newTasks: {
      subscribeChanges: () => () => undefined,
      listInvocableSkills: async () => [],
      searchFiles: async () => ({ ok: false, reason: 'no_project' }),
    },
    mcp: { subscribeChanges: () => () => undefined },
    ...rest,
    sessions: {
      readSnapshot: async () => {
        throw new Error('Session snapshot is not stubbed');
      },
      readExecutionBoundary: async () => {
        throw new Error('Execution boundary is not stubbed');
      },
      promoteQueueEntry: async () => undefined,
      retractQueueEntry: async () => undefined,
      updateQueueEntry: async () => undefined,
      reorderQueueEntries: async () => undefined,
      compact: async () => {
        throw new Error('Context compaction is not stubbed');
      },
      ...sessions,
    },
  };
}

export { usePlanModeState } from './controller/use-plan-mode-state.js';
export type { PlanModeState } from './model/plan-state.js';
export { PlanExecutionPanel } from './ui/plan-panels.js';

export { createSessionWorkspaceActions } from './model/session-workspace-actions.js';

export { createAppShellSessionDisplayBatch, createAppShellSessionEventHandlers } from './model/session-events.js';
export { createConversationWorkspace } from './model/conversation-workspace.js';
export { useConversationOwner } from './ui/conversation-context.js';

export { createTranscriptCommands } from './model/transcript-commands.js';
export {
  contextCompactionNotice,
  createContextCompactionCommands,
  createContextCompactionPresentation,
  presentContextCompactionResult,
} from './model/context-compaction.js';
export { useConversationQueue } from './ui/conversation-provider.js';

export { LiveTurnReconciler } from './controller/live-turn-reconciler.js';
export { TranscriptReadingPositionController, type TranscriptReadingPositionCommands } from './controller/transcript-reading-position-controller.js';
export { useComposerAttachments } from './controller/use-composer-attachments.js';
export { useComposerQuotes } from './controller/use-composer-quotes.js';
export { useComposerStaging } from './ui/composer-staging-context.js';
