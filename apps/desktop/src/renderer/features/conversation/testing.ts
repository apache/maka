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
export { shellSessionRowEqual } from './controller/use-app-shell-session-ui-state.js';
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
    listMessages: async () => [],
    cancelMessage: async () => undefined,
    reconcileMessage: async () => undefined,
    subscribeChanges: () => () => undefined,
    skills: { listInvocable: async () => [] },
    runtimeHosts: { subscribeChanges: () => () => undefined },
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
      ...sessions,
    },
  };
}

export { usePlanModeState } from './controller/use-plan-mode-state.js';
export type { PlanModeState } from './model/plan-state.js';
export { PlanExecutionPanel } from './ui/plan-panels.js';
