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
import { test } from 'node:test';
import {
  createDesktopSessionCollaborationServices,
  type DesktopSessionCollaborationBridge,
} from '../../renderer/platform/desktop/create-session-collaboration-services.js';

test('preserves sharing bridge arguments and adapts remote access and clipboard capabilities', async () => {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const result = { marker: 'bridge-result' };
  let state = 'off';
  const sessionCollaboration = new Proxy({}, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ name: String(property), args });
      return Promise.resolve(result);
    },
  });
  const services = createDesktopSessionCollaborationServices({
    sessionCollaboration,
    localRuntimeHostRemoteAccess: { getSnapshot: async () => ({ state }) },
  } as unknown as DesktopSessionCollaborationBridge, {
    writeText: async (text) => { calls.push({ name: 'clipboard', args: [text] }); },
  });
  assert.equal(await services.isLocalRemoteAccessEnabled(), false);
  state = 'on';
  assert.equal(await services.isLocalRemoteAccessEnabled(), true);
  assert.equal(await services.getAccess('session-a'), result);
  assert.equal(await services.prepareInvitation('session-a', 'request_turn', false), result);
  assert.equal(await services.prepareInvitation('session-a', 'request_turn', true), result);
  assert.equal(await services.revokeGrant('session-a', 'grant-a'), result);
  assert.equal(await services.revokePrincipal('session-a', 'principal-a'), result);
  assert.equal(await services.decideTurnRequest('session-a', 'request-a', 'approve'), result);
  await services.writeInvitationClipboard('invitation-code');
  assert.deepEqual(calls, [
    { name: 'getAccess', args: ['session-a'] },
    { name: 'prepareInvitation', args: ['session-a', 'request_turn', false] },
    { name: 'prepareInvitation', args: ['session-a', 'request_turn', true] },
    { name: 'revokeGrant', args: ['session-a', 'grant-a'] },
    { name: 'revokePrincipal', args: ['session-a', 'principal-a'] },
    { name: 'decideTurnRequest', args: ['session-a', 'request-a', 'approve'] },
    { name: 'clipboard', args: ['invitation-code'] },
  ]);
});
