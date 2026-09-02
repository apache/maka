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
import {
  PeerMeshOperationOutcomeUnknownError,
  type RuntimeHostManagementServices,
} from '../../features/runtime-host-management';

export type DesktopRuntimeHostManagementBridge = Pick<
  MakaBridge,
  'runtimeHostManagement' | 'runtimeHostPeerMesh' | 'runtimeHostProfiles'
>;

export function createDesktopRuntimeHostManagementServices(
  bridge: DesktopRuntimeHostManagementBridge = window.maka,
): RuntimeHostManagementServices {
  return {
    supportsWsl: navigator.userAgent.includes('Windows'),
    connectionCodes: {
      create: (profileId) => bridge.runtimeHostManagement.createConnectionCode(profileId),
      importCode: (code) => bridge.runtimeHostProfiles.importConnectionCode(code),
      readClipboardText: () => navigator.clipboard.readText(),
      writeClipboardText: (value) => navigator.clipboard.writeText(value),
    },
    peerMesh: {
      getConnectivityPolicy: () => bridge.runtimeHostPeerMesh.getConnectivityPolicy(),
      setConnectivityPolicy: (policy) => bridge.runtimeHostPeerMesh.setConnectivityPolicy(policy),
      execute: async (target, action, input) => {
        const outcome = await bridge.runtimeHostPeerMesh.execute(target, action, input);
        if (outcome.kind === 'outcome_unknown') {
          throw new PeerMeshOperationOutcomeUnknownError(action);
        }
        return outcome.result;
      },
      cancel: (operationId) => bridge.runtimeHostPeerMesh.cancel(operationId),
      getDirectPeer: (profileId) => bridge.runtimeHostManagement.getDirectPeer(profileId),
      configureDirectPeer: (profileId, enabled, relays, automaticDiscovery, webRtcStunPolicy) =>
        bridge.runtimeHostManagement.configureDirectPeer(
          profileId,
          enabled,
          relays,
          automaticDiscovery,
          webRtcStunPolicy,
        ),
      copyText: (value) => navigator.clipboard.writeText(value),
      createOperationId: () => crypto.randomUUID(),
      schedule: (callback, delayMs) => {
        const timer = window.setTimeout(callback, delayMs);
        return () => window.clearTimeout(timer);
      },
    },
    profilePairing: {
      retry: (profileId) =>
        bridge.runtimeHostProfiles.resolvePairingRecovery(profileId).then(() => undefined),
      discard: (profileId) =>
        bridge.runtimeHostProfiles.discardPairing(profileId).then(() => undefined),
    },
  };
}
