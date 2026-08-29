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

import type { DesktopRuntimeHostClient } from './runtime-host-client.js';
import {
  encodeDesktopCollaborationInvitation,
  type DesktopCollaborationConnectionTarget,
} from './runtime-host-collaboration-invitation.js';
import {
  handleReconnectableRead,
  type ReconnectableReadIpcMain,
} from './ipc-reconnect-policy.js';

export function registerRuntimeHostCollaborationIpc(
  client: Pick<
    DesktopRuntimeHostClient,
    | 'prepareCollaborationInvitation'
    | 'queryCollaborationAccess'
    | 'revokeCollaborationPrincipal'
  >,
  ipcMain: ReconnectableReadIpcMain,
  resolveConnectionTarget: () =>
    | DesktopCollaborationConnectionTarget
    | Promise<DesktopCollaborationConnectionTarget>,
): void {
  ipcMain.handle(
    'session-collaboration:prepare',
    async (_event, sessionId: unknown, allowInsecure: unknown) => {
      const target = await resolveConnectionTarget();
      if (target.transport.kind === 'plaintext' && allowInsecure !== true) {
        return { kind: 'insecure_confirmation_required' } as const;
      }
      const prepared = await client.prepareCollaborationInvitation(
        requiredId(sessionId, 'Session'),
        ['session_observation'],
      );
      return {
        kind: 'prepared',
        invitation: {
          ...prepared,
          invitationCode: encodeDesktopCollaborationInvitation({
            invitationCode: prepared.invitationCode,
            target,
          }),
        },
      };
    },
  );
  handleReconnectableRead(
    ipcMain,
    'session-collaboration:getAccess',
    (_event, sessionId: unknown) =>
      client.queryCollaborationAccess(requiredId(sessionId, 'Session')),
  );
  ipcMain.handle(
    'session-collaboration:revokePrincipal',
    (_event, principalId: unknown) =>
      client.revokeCollaborationPrincipal(requiredId(principalId, 'Principal')),
  );
}

function requiredId(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`Invalid ${label} identity`);
  }
  return value;
}
