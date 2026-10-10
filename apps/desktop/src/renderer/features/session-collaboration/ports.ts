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
  CollaborationAccessQueryResult,
  CollaborationInvitationPrepareResult,
  CollaborationGrantRevokeResult,
  CollaborationPrincipalRevokeResult,
  CollaborationTurnRequestAcknowledgeResult,
  CollaborationTurnRequestDecideResult,
  CollaborationTurnRequestQueryResult,
  CollaborationTurnRequestWithdrawResult,
  SessionTurnAccessRequest,
} from '@maka/runtime-host/protocol';

export type PreparedSessionInvitation = CollaborationInvitationPrepareResult & {
  readonly connectivity:
    | { readonly kind: 'peer'; readonly coordinationRelayCount: number }
    | { readonly kind: 'configured' };
};

export type {
  SessionCollaborationCancelResult,
  SessionCollaborationImportPhase,
  SessionCollaborationImportResult,
  SessionCollaborationMountSummary,
} from '../../../shared/session-collaboration.js';

export interface SessionCollaborationServices {
  isLocalRemoteAccessEnabled(): Promise<boolean>;
  getAccess(sessionId: string): Promise<CollaborationAccessQueryResult>;
  prepareInvitation(
    sessionId: string,
    preset: 'observe' | 'request_turn',
    allowInsecure: boolean,
  ): Promise<
    | { readonly kind: 'prepared'; readonly invitation: PreparedSessionInvitation }
    | { readonly kind: 'insecure_confirmation_required' }
  >;
  revokeGrant(sessionId: string, grantId: string): Promise<CollaborationGrantRevokeResult>;
  revokePrincipal(sessionId: string, principalId: string): Promise<CollaborationPrincipalRevokeResult>;
  writeInvitationClipboard(text: string): Promise<void>;
  importInvitation(input: {
    readonly code: string;
    readonly allowInsecure: boolean;
    readonly operationId: string;
  }, onProgress?: (phase: SessionCollaborationImportPhase) => void): Promise<SessionCollaborationImportResult>;
  cancelImport(operationId: string): Promise<SessionCollaborationCancelResult>;
  readInvitationClipboard(): Promise<string>;
  listMounts(): Promise<readonly SessionCollaborationMountSummary[]>;
  subscribeMountChanges(handler: () => void): () => void;
  removeMount(mountId: string): Promise<void>;
  retryMount(mountId: string): Promise<void>;
  renameMount(mountId: string, name: string): Promise<void>;
  renamePrincipal(sessionId: string, principalId: string, displayName: string): Promise<{ readonly renamed: boolean }>;
  requestTurn(
    sessionId: string,
    input: { readonly kind: 'start'; readonly turnId: string; readonly text: string },
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
