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

import type { SessionCollaborationServices } from './ports.js';

export {
  groupPendingTurnRequests,
  describeOwnerTurnRequestIntent,
  describeTurnRequestIntent,
  samePendingTurnRequests,
  turnRequestPreview,
  unseenTurnRequests,
} from './model/turn-request-inbox.js';
export type { SessionCollaborationServices } from './ports.js';
export { SessionCollaborationServicesProvider } from './services-context.js';
export { SessionCollaborationJoinDialog } from './ui/session-collaboration-join-dialog.js';
export { SessionCollaborationNavigation } from './ui/session-collaboration-navigation.js';
export { SessionTurnRequestComposer } from './ui/session-turn-request-composer.js';
export { sessionCollaborationImportErrorMessage } from './ui/session-collaboration-join-dialog.js';
export { SessionCollaborationDialogRoot } from './ui/session-collaboration-dialog-root.js';
export type { SessionCollaborationDialogProjection } from './model/dialog-projection.js';
export type { PreparedSessionInvitation } from './ports.js';

export function createFakeSessionCollaborationServices(
  overrides: Partial<SessionCollaborationServices> = {},
): SessionCollaborationServices {
  return {
    isLocalRemoteAccessEnabled: async () => true,
    getAccess: async () => ({ principals: [], grants: [] }),
    prepareInvitation: async () => { throw new Error('Fake prepareInvitation is not configured'); },
    revokeGrant: async () => ({ revoked: true }),
    revokePrincipal: async () => ({ revoked: true }),
    writeInvitationClipboard: async () => undefined,
    importInvitation: async () => { throw new Error('Fake importInvitation is not configured'); },
    cancelImport: async () => 'cancelled',
    readInvitationClipboard: async () => '',
    listMounts: async () => [],
    subscribeMountChanges: () => () => undefined,
    removeMount: async () => undefined,
    retryMount: async () => undefined,
    renameMount: async () => undefined,
    renamePrincipal: async () => ({ renamed: true }),
    requestTurn: async () => { throw new Error('Fake requestTurn is not configured'); },
    getTurnRequests: async () => ({ canRequestTurns: false, requests: [] }),
    acknowledgeTurnRequest: async () => ({ acknowledged: false }),
    withdrawTurnRequest: async () => ({ withdrawn: false }),
    getPendingTurnRequests: async () => [],
    decideTurnRequest: async () => ({ kind: 'not_found' }),
    createOperationId: () => 'operation-1',
    ...overrides,
  };
}
