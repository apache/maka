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

import type {
  SessionCollaborationCancelResult,
  SessionCollaborationImportPhase,
  SessionCollaborationImportResult,
  SessionCollaborationMountSummary,
} from '../../../shared/session-collaboration.js';
import type {
  CollaborationTurnRequestAcknowledgeResult,
  CollaborationTurnRequestDecideResult,
  CollaborationTurnRequestQueryResult,
  CollaborationTurnRequestWithdrawResult,
  SessionTurnAccessRequest,
} from '@maka/runtime-host/protocol';

export type {
  SessionCollaborationCancelResult,
  SessionCollaborationImportPhase,
  SessionCollaborationImportResult,
  SessionCollaborationMountSummary,
} from '../../../shared/session-collaboration.js';

export interface SessionCollaborationServices {
  importInvitation(input: {
    readonly code: string;
    readonly allowInsecure: boolean;
    readonly operationId: string;
  }, onProgress?: (phase: SessionCollaborationImportPhase) => void): Promise<SessionCollaborationImportResult>;
  cancelImport(operationId: string): Promise<SessionCollaborationCancelResult>;
  readInvitationClipboard(): Promise<string>;
  listMounts(): Promise<readonly SessionCollaborationMountSummary[]>;
  removeMount(mountId: string): Promise<void>;
  requestTurn(
    sessionId: string,
    input:
      | { readonly kind: 'start'; readonly turnId: string; readonly text: string }
      | {
          readonly kind: 'regenerate';
          readonly turnId: string;
          readonly sourceTurnId: string;
        },
  ): Promise<SessionTurnAccessRequest>;
  getTurnRequests(sessionId: string): Promise<CollaborationTurnRequestQueryResult>;
  acknowledgeTurnRequest(
    sessionId: string,
    requestId: string,
  ): Promise<CollaborationTurnRequestAcknowledgeResult>;
  withdrawTurnRequest(
    sessionId: string,
    requestId: string,
  ): Promise<CollaborationTurnRequestWithdrawResult>;
  getPendingTurnRequests(): Promise<readonly SessionTurnAccessRequest[]>;
  decideTurnRequest(
    sessionId: string,
    requestId: string,
    decision: 'approve' | 'reject',
  ): Promise<CollaborationTurnRequestDecideResult>;
  createOperationId(): string;
}
