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
  AgentInteractionResult,
  ClientOperation,
} from '../../../../packages/plugin-sdk/src/generated/runtime';
import type { Host } from './host';
import type { ComputerPermissionClient } from './computerPermissionSetupState';
import { settingsValue } from './settingsOperations';
import { UiError } from './text';

/** Retains the bound application's Host; IDs never select a different deployment. */
export function computerPermissionClient(
  host: Host,
  sessionId: string,
  requestId: string,
): ComputerPermissionClient {
  return {
    status: () => host.systemPermissionStatus(sessionId, requestId),
    actions: () => host.systemPermissionActions(sessionId, requestId),
    request: (grant) => host.requestSystemPermission(sessionId, requestId, grant),
    action: (action) => host.systemPermissionAction(sessionId, requestId, action),
    async cancel() {
      const matches = (operation: ClientOperation) =>
        operation.method === 'respond' &&
        operation.sessionId === sessionId &&
        operation.correlation !== null &&
        typeof operation.correlation === 'object' &&
        'requestId' in operation.correlation &&
        operation.correlation.requestId === requestId;
      const originals = (await host.pendingControls()).filter(matches);
      for (const original of originals) await host.recoverControl(original.id);
      if ((await host.systemPermissionStatus(sessionId, requestId)).outcome) return;
      if ((await host.pendingControls()).some(matches)) throw new UiError('Syncing changes…');
      const result = settingsValue(
        (
          await host.control('respond', {
            sessionId,
            requestId,
            answer: { kind: 'system_permission_cancel' },
          })
        ).reply,
      ) as AgentInteractionResult;
      if (result.kind !== 'recorded') throw new UiError('This action could not be completed.');
    },
  };
}
