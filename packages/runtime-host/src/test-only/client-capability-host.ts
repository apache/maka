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

export {
  HostClientCapabilityCoordinator,
  type ClientCapabilitySnapshot,
} from '../server/client-capability-coordinator.js';
export { RuntimePolicyActivationGate } from '../server/runtime-policy-activation-gate.js';

export function clientCapabilityCoordinatorTestAdmission() {
  return {
    interactions: {
      requestClientCapabilityApproval: async () => {
        throw new Error('Unexpected Client Capability approval request');
      },
    },
    grants: {
      readClientCapabilitySessionGrant: async (key: {
        sessionId: string;
        providerId: string;
        contractId: string;
        serverId: string;
        toolName: string;
        capability: 'browser' | 'computer_use' | 'desktop_mcp';
        scope:
          | { kind: 'browser_origin'; origin: string }
          | { kind: 'macos_bundle_id'; bundleId: string }
          | { kind: 'app_catalog' }
          | { kind: 'mcp_tool'; serverId: string; toolName: string };
      }) => ({ version: 1 as const, ...key, grantedAt: 0 }),
    },
  };
}
