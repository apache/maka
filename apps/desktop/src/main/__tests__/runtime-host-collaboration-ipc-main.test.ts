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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeCollaborationInvitationCode,
  encodeCollaborationInvitationCode,
} from '@maka/runtime-host/protocol';
import type { IpcHandler, ReconnectableReadIpcMain } from '../ipc-reconnect-policy.js';
import { decodeDesktopCollaborationInvitation } from '../runtime-host-collaboration-invitation.js';
import { registerRuntimeHostCollaborationIpc } from '../runtime-host-collaboration-ipc-main.js';

const ROOT_ID = 'a'.repeat(64);

test('requires Owner confirmation before issuing a plaintext collaboration invitation', async () => {
  const handlers = new Map<string, IpcHandler>();
  const ipcMain: ReconnectableReadIpcMain = {
    handle(channel, listener) {
      handlers.set(channel, listener);
    },
  };
  let prepareCalls = 0;
  const client = {
    async prepareCollaborationInvitation(sessionId: string, grantKinds: readonly string[]) {
      prepareCalls += 1;
      assert.equal(sessionId, 'session-1');
      assert.deepEqual(grantKinds, ['session_observation']);
      return {
        invitationCode: encodeCollaborationInvitationCode({
          schemaVersion: 1,
          rootId: ROOT_ID,
          credential: 'guest-token',
        }),
        principalId: 'guest-1',
        expiresAt: '2026-08-31T00:00:00.000Z',
        grants: [],
      };
    },
    async queryCollaborationAccess() {
      return { principals: [], grants: [] };
    },
    async revokeCollaborationPrincipal() {
      return { revoked: false };
    },
  };
  registerRuntimeHostCollaborationIpc(
    client as unknown as Parameters<typeof registerRuntimeHostCollaborationIpc>[0],
    ipcMain,
    async () => ({
      name: 'Lab',
      transport: {
        kind: 'plaintext',
        url: 'ws://runtime.example.com',
        acknowledgement: 'plaintext-bearer-v1',
      },
    }),
  );
  const prepare = handlers.get('session-collaboration:prepare');
  assert.ok(prepare);

  assert.deepEqual(
    await prepare({} as Parameters<IpcHandler>[0], 'session-1', 'observe', false),
    {
      kind: 'insecure_confirmation_required',
    },
  );
  assert.equal(prepareCalls, 0);

  const result = await prepare(
    {} as Parameters<IpcHandler>[0],
    'session-1',
    'observe',
    true,
  );
  assert.equal(prepareCalls, 1);
  assert.equal((result as { kind?: unknown }).kind, 'prepared');
  const invitation = (result as {
    invitation: { invitationCode: string };
  }).invitation;
  const bundle = decodeDesktopCollaborationInvitation(invitation.invitationCode);
  assert.equal(decodeCollaborationInvitationCode(bundle.invitationCode).rootId, ROOT_ID);
  assert.equal(bundle.target.transport.kind, 'plaintext');
});
