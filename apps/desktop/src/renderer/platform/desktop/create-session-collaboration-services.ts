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

import type { MakaBridge } from '../../../preload/bridge-contract.js';
import type { SessionCollaborationServices } from '../../features/session-collaboration';

export type DesktopSessionCollaborationBridge = Pick<MakaBridge, 'sessionCollaboration'>;

export function createDesktopSessionCollaborationServices(
  bridge: DesktopSessionCollaborationBridge = window.maka,
): SessionCollaborationServices {
  return {
    importInvitation: (input, onProgress) =>
      bridge.sessionCollaboration.importInvitation(input, onProgress),
    cancelImport: (operationId) => bridge.sessionCollaboration.cancelImport(operationId),
    readInvitationClipboard: () => bridge.sessionCollaboration.readInvitationClipboard(),
    listMounts: () => bridge.sessionCollaboration.listMounts(),
    removeMount: (mountId) => bridge.sessionCollaboration.removeMount(mountId),
    requestTurn: (sessionId, input) =>
      bridge.sessionCollaboration.requestTurn(sessionId, input),
    getTurnRequests: (sessionId) =>
      bridge.sessionCollaboration.getTurnRequests(sessionId),
    acknowledgeTurnRequest: (sessionId, requestId) =>
      bridge.sessionCollaboration.acknowledgeTurnRequest(sessionId, requestId),
    withdrawTurnRequest: (sessionId, requestId) =>
      bridge.sessionCollaboration.withdrawTurnRequest(sessionId, requestId),
    getPendingTurnRequests: () => bridge.sessionCollaboration.getPendingTurnRequests(),
    decideTurnRequest: (sessionId, requestId, decision) =>
      bridge.sessionCollaboration.decideTurnRequest(sessionId, requestId, decision),
    createOperationId: () => crypto.randomUUID(),
  };
}
