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

import type { SessionNavigationServices } from './ports.js';

export type {
  SessionNavigationServices,
  SessionNavigationSession,
  SessionNavigationSessionService,
} from './ports.js';

export { SessionNavigationServicesProvider } from './services-context.js';
export {
  createSessionNavigationRowActions,
} from './controller/session-row-actions.js';
export { createSessionOpenCommand } from './controller/session-open-command.js';
export {
  useSessionNavigationController,
  type SessionNavigationController,
  type SessionNavigationPorts,
  type UseSessionNavigationControllerInput,
} from './controller/use-session-navigation-controller.js';
export { useSessionSelection } from './controller/use-session-selection.js';
export type { SessionNavigationRowActions } from './controller/session-row-actions.js';
export { useSessionNavigationReads } from './controller/use-session-navigation-reads.js';
export { sessionMatchesRail } from './model/session-nav-filter.js';
export { deriveBranchBanner } from './model/branch-banner.js';
export { deriveSessionRail } from './model/session-rail.js';
export { deriveSessionRevisionNavigation } from './model/session-revisions.js';
export {
  EMPTY_SESSION_SELECTION,
  enterSessionSelection,
  exitSessionSelection,
  pruneSessionSelection,
  sessionSelectionMasterState,
  setAllSessionsSelected,
  type SessionSelection,
} from './model/session-selection.js';
export {
  readSessionListViewMode,
  SESSION_LIST_EXPANDED_MAX_WIDTH,
  SESSION_LIST_EXPANDED_MIN_WIDTH,
  writeSessionListViewMode,
} from './model/session-list-layout.js';
export { createSessionRailLayoutStore } from './model/session-rail-layout-store.js';

export function createFakeSessionNavigationServices(
  overrides: Partial<SessionNavigationServices> = {},
): SessionNavigationServices {
  return {
    sessions: {
      list: async () => [],
      setFlagged: async () => undefined,
      archive: async () => undefined,
      unarchive: async () => undefined,
      rename: async () => undefined,
      remove: async () => ({ disposition: 'removed', archivedSubtaskCount: 0 }),
      previewRemoval: async () => 0,
    },
    ...overrides,
  };
}
