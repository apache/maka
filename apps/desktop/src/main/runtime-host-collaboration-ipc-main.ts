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

import { RuntimeHostOperationError } from '@maka/runtime-host/client';
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
    | 'acknowledgeCollaborationTurnRequest'
    | 'createCollaborationTurnRequest'
    | 'decideCollaborationTurnRequest'
    | 'queryCollaborationTurnRequests'
    | 'queryCollaborationAccess'
    | 'revokeCollaborationGrant'
    | 'revokeCollaborationPrincipal'
  >,
  ipcMain: ReconnectableReadIpcMain,
  resolveConnectionTarget: () =>
    | DesktopCollaborationConnectionTarget
    | Promise<DesktopCollaborationConnectionTarget>,
): void {
  ipcMain.handle(
    'session-collaboration:prepare',
    async (
      _event,
      sessionId: unknown,
      preset: unknown,
      allowInsecure: unknown,
    ) => {
      const target = await resolveConnectionTarget();
      if (target.transport.kind === 'plaintext' && allowInsecure !== true) {
        return { kind: 'insecure_confirmation_required' } as const;
      }
      const prepared = await client.prepareCollaborationInvitation(
        requiredId(sessionId, 'Session'),
        requiredPreset(preset) === 'request_turn'
          ? ['session_observation', 'session_turn_request']
          : ['session_observation'],
      );
      return {
        kind: 'prepared',
        invitation: {
          ...prepared,
          invitationCode: encodeDesktopCollaborationInvitation({
            invitationCode: prepared.invitationCode,
            target,
          }),
          connectivity:
            target.transport.kind === 'libp2p-direct'
              ? {
                  kind: 'peer' as const,
                  coordinationRelayCount:
                    target.transport.reachability.lease.coordinationRoutes.length,
                }
              : { kind: 'configured' as const },
        },
      };
    },
  );
  ipcMain.handle(
    'session-collaboration:turn-request:create',
    (_event, intent: unknown) =>
      client.createCollaborationTurnRequest(intent as Parameters<
        DesktopRuntimeHostClient['createCollaborationTurnRequest']
      >[0]),
  );
  handleReconnectableRead(
    ipcMain,
    'session-collaboration:turn-request:query',
    async (_event, sessionId: unknown) => {
      const requestedSessionId =
        sessionId === undefined ? undefined : requiredId(sessionId, 'Session');
      try {
        return await client.queryCollaborationTurnRequests(requestedSessionId);
      } catch (error) {
        if (requestedSessionId === undefined && isCollaborationInboxUnavailable(error)) {
          return { canRequestTurns: false, requests: [] };
        }
        throw error;
      }
    },
  );
  ipcMain.handle(
    'session-collaboration:turn-request:acknowledge',
    (_event, requestId: unknown) =>
      client.acknowledgeCollaborationTurnRequest(requiredId(requestId, 'Turn request')),
  );
  ipcMain.handle(
    'session-collaboration:turn-request:decide',
    (_event, requestId: unknown, decision: unknown) =>
      client.decideCollaborationTurnRequest(
        requiredId(requestId, 'Turn request'),
        requiredDecision(decision),
      ),
  );
  handleReconnectableRead(
    ipcMain,
    'session-collaboration:getAccess',
    (_event, sessionId: unknown) =>
      client.queryCollaborationAccess(requiredId(sessionId, 'Session')),
  );
  ipcMain.handle(
    'session-collaboration:revokeGrant',
    (_event, grantId: unknown) =>
      client.revokeCollaborationGrant(requiredId(grantId, 'Grant')),
  );
  ipcMain.handle(
    'session-collaboration:revokePrincipal',
    (_event, principalId: unknown) =>
      client.revokeCollaborationPrincipal(requiredId(principalId, 'Principal')),
  );
}

function isCollaborationInboxUnavailable(error: unknown): boolean {
  return (
    error instanceof RuntimeHostOperationError &&
    error.operation === 'collaboration.turn-request.query' &&
    error.code === 'operation_unavailable'
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

function requiredPreset(value: unknown): 'observe' | 'request_turn' {
  if (value !== 'observe' && value !== 'request_turn') {
    throw new Error('Invalid collaboration invitation preset');
  }
  return value;
}

function requiredDecision(value: unknown): 'approve' | 'reject' {
  if (value !== 'approve' && value !== 'reject') {
    throw new Error('Invalid collaboration Turn request decision');
  }
  return value;
}
