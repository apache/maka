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

export type SessionCollaborationImportResult =
  | { readonly kind: 'connected'; readonly mountId: string }
  | { readonly kind: 'recovering'; readonly mountId: string }
  | {
      readonly kind: 'error';
      readonly reason:
        | 'invalid_code'
        | 'insecure_confirmation_required'
        | 'peer_path_unavailable'
        | 'connection_failed';
      readonly message?: string;
    };

export type SessionCollaborationImportPhase =
  | 'validating_invitation'
  | 'discovering_host'
  | 'preparing_route'
  | 'connecting'
  | 'authenticating'
  | 'finalizing_access'
  | 'loading_session';

export type SessionCollaborationCancelResult = 'cancelled' | 'settling';

export interface SessionCollaborationMountSummary {
  readonly mountId: string;
  readonly name: string;
}
