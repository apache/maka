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

import type { RuntimeHostManagedUpdatePolicy } from '@maka/runtime-host/operator';
import type {
  DesktopRuntimeHostAccessSnapshot,
  DesktopRuntimeHostDirectPeerSnapshot,
  DesktopRuntimeHostManagementAction,
  DesktopRuntimeHostManagementResponse,
  DesktopRuntimeHostUpdatePolicySnapshot,
  DesktopRuntimeHostUpdateReconciliationResponse,
} from '../preload/bridge-contract.js';

export interface DesktopRuntimeHostManagementProvider {
  readonly profileId: string;
  run(
    action: DesktopRuntimeHostManagementAction,
    allowInterruptActiveTasks?: boolean,
  ): Promise<DesktopRuntimeHostManagementResponse>;
  update(allowInterruptActiveTasks: boolean): Promise<DesktopRuntimeHostManagementResponse>;
  configureProjectDirectories(
    roots: readonly { readonly label: string; readonly path: string }[],
    expectedConfigFingerprint: string,
    allowInterruptActiveTasks: boolean,
  ): Promise<DesktopRuntimeHostManagementResponse>;
  getUpdatePolicy(): Promise<DesktopRuntimeHostUpdatePolicySnapshot>;
  setUpdatePolicy(policy: RuntimeHostManagedUpdatePolicy): Promise<DesktopRuntimeHostUpdatePolicySnapshot>;
  reconcileUpdate(): Promise<DesktopRuntimeHostUpdateReconciliationResponse>;
  readonly directPeer?: {
    get(): Promise<DesktopRuntimeHostDirectPeerSnapshot>;
    configure(
      enabled: boolean,
      coordinationRelays: readonly string[],
      automaticRelayDiscovery: boolean,
    ): Promise<DesktopRuntimeHostDirectPeerSnapshot>;
  };
  readonly access?: {
    list(): Promise<DesktopRuntimeHostAccessSnapshot>;
    rotate(): Promise<DesktopRuntimeHostAccessSnapshot>;
    revoke(credentialId: string): Promise<DesktopRuntimeHostAccessSnapshot>;
  };
}
