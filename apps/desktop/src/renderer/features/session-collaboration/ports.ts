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
  SessionCollaborationImportResult,
  SessionCollaborationMountSummary,
} from '../../../shared/session-collaboration.js';

export type {
  SessionCollaborationImportResult,
  SessionCollaborationMountSummary,
} from '../../../shared/session-collaboration.js';

export type SessionCollaborationImportPhase =
  | 'validating_invitation'
  | 'discovering_host'
  | 'preparing_route'
  | 'connecting'
  | 'authenticating'
  | 'finalizing_access'
  | 'loading_session';

export type SessionCollaborationCancelResult = 'cancelled' | 'settling' | 'idle';

export interface SessionCollaborationServices {
  importInvitation(input: {
    readonly code: string;
    readonly allowInsecure: boolean;
    readonly operationId: string;
  }, onProgress?: (phase: SessionCollaborationImportPhase) => void): Promise<SessionCollaborationImportResult>;
  cancelImport(operationId: string): Promise<SessionCollaborationCancelResult>;
  listMounts(): Promise<readonly SessionCollaborationMountSummary[]>;
  removeMount(mountId: string): Promise<void>;
  createOperationId(): string;
}
