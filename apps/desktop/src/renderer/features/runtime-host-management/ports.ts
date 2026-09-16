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

import type { RuntimeHostPeerMeshManagementAction } from '@maka/runtime-host/operator';
import type { RuntimeHostWebRtcStunPolicy } from '@maka/runtime-host/operator';
import type {
  HostResourcesResult,
  PeerMeshInvitationResult,
  PeerMeshQueryResult,
} from '@maka/runtime-host/protocol';

export type PeerMeshTarget =
  | { readonly kind: 'desktop' }
  | { readonly kind: 'local_host' }
  | { readonly kind: 'managed_host'; readonly profileId: string };

export interface PeerMeshOperationInput {
  readonly meshId?: string | null;
  readonly peerId?: string;
  readonly invitation?: string;
  readonly displayName?: string | null;
  readonly operationId: string;
}

export interface PeerMeshDirectPeerSnapshot {
  readonly state: 'unsupported' | 'not_configured' | 'disabled' | 'enabled';
  readonly peerId?: string;
  readonly routeHints: readonly string[];
  readonly coordinationRelays: readonly string[];
  readonly automaticRelayDiscovery: boolean;
  readonly webRtcStunPolicy?: RuntimeHostWebRtcStunPolicy;
  readonly profilePresent: boolean;
  readonly profileEnabled: boolean;
  readonly clientAvailable: boolean;
  readonly managementAvailable: boolean;
}

export class PeerMeshOperationOutcomeUnknownError extends Error {
  constructor(readonly action: RuntimeHostPeerMeshManagementAction) {
    super('Peer Mesh operation outcome is unknown');
    this.name = 'PeerMeshOperationOutcomeUnknownError';
  }
}

export interface PeerMeshServices {
  getConnectivityPolicy(): Promise<RuntimeHostWebRtcStunPolicy>;
  setConnectivityPolicy(policy: RuntimeHostWebRtcStunPolicy): Promise<RuntimeHostWebRtcStunPolicy>;
  execute(
    target: PeerMeshTarget,
    action: RuntimeHostPeerMeshManagementAction,
    input: PeerMeshOperationInput,
  ): Promise<PeerMeshQueryResult | PeerMeshInvitationResult>;
  cancel(operationId: string): Promise<void>;
  getDirectPeer(profileId: string): Promise<PeerMeshDirectPeerSnapshot>;
  configureDirectPeer(
    profileId: string,
    enabled: boolean,
    coordinationRelays: readonly string[],
    automaticRelayDiscovery: boolean,
    webRtcStunPolicy?: RuntimeHostWebRtcStunPolicy,
  ): Promise<PeerMeshDirectPeerSnapshot>;
  copyText(value: string): Promise<void>;
  createOperationId(): string;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface RuntimeHostProfilePairingServices {
  retry(profileId?: string): Promise<void>;
  discard(profileId: string): Promise<void>;
}

export type RuntimeHostConnectionCodeImportResult =
  | { readonly kind: 'connected'; readonly profileId: string }
  | {
      readonly kind: 'error';
      readonly reason:
        | 'invalid_code'
        | 'code_unavailable'
        | 'host_unreachable'
        | 'host_mismatch'
        | 'unknown';
    };

export interface RuntimeHostConnectionCodeServices {
  create(profileId: string): Promise<string>;
  importCode(code: string): Promise<RuntimeHostConnectionCodeImportResult>;
  readClipboardText(): Promise<string>;
  writeClipboardText(value: string): Promise<void>;
}

export interface RuntimeHostResourceServices {
  query(profileId: string): Promise<HostResourcesResult | undefined>;
  schedule(callback: () => void, delayMs: number): () => void;
}

export interface RuntimeHostManagementServices {
  readonly peerMesh: PeerMeshServices;
  readonly profilePairing: RuntimeHostProfilePairingServices;
  readonly connectionCodes: RuntimeHostConnectionCodeServices;
  readonly resources: RuntimeHostResourceServices;
  readonly supportsWsl: boolean;
}
