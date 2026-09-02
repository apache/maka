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

import type { ClientCapabilityConnectionIdentity } from '../../server/client-capability-service.js';
import type { HostClientCapabilityCoordinatorOptions } from '../../server/client-capability-coordinator.js';

export function clientCapabilityConnectionIdentity(
  connectionId: string,
  clientInstanceId = connectionId,
  principalId = 'test-principal',
  principalKind: ClientCapabilityConnectionIdentity['principalKind'] = 'local_owner',
  capabilityOwner?: ClientCapabilityConnectionIdentity['capabilityOwner'],
  credentialBound = principalKind === 'remote_owner',
): ClientCapabilityConnectionIdentity {
  return {
    connectionId,
    principalId,
    clientInstanceId,
    ...(credentialBound ? { credentialBoundClientInstanceId: clientInstanceId } : {}),
    principalKind,
    ...(capabilityOwner ? { capabilityOwner } : {}),
  };
}

export function clientCapabilityCoordinatorTestAdmission(): Pick<
  HostClientCapabilityCoordinatorOptions,
  'interactions' | 'grants'
> {
  return {
    interactions: {
      requestClientCapabilityApproval: async () => {
        throw new Error('Unexpected Client Capability approval request');
      },
    },
    grants: {
      readClientCapabilitySessionGrant: async (key) => ({
        version: 1,
        ...key,
        grantedAt: 0,
      }),
    },
  };
}
