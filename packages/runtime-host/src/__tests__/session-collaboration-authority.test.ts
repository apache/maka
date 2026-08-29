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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { decodeCollaborationInvitationCode } from '../protocol/index.js';
import { openRuntimeHostAccessAuthority } from '../server/access-authority.js';

test('Session Guest invitation, grants, and revocation form one durable authority lifecycle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'maka-session-collaboration-'));
  const authority = await openRuntimeHostAccessAuthority(directory);
  try {
    const prepared = await authority.prepareCollaborationInvitation('root-1', {
      sessionId: 'session-1',
      grantKinds: ['session_observation', 'session_turn_request'],
    });
    const invitation = decodeCollaborationInvitationCode(prepared.invitationCode);

    assert.deepEqual(authority.authenticate(invitation.credential)?.operationGrants, [
      'host.status',
      'access.credential.finalize',
    ]);
    const credentialId = authority.authenticate(invitation.credential)?.credentialId;
    assert.ok(credentialId);
    await authority.finalize(credentialId, 'guest-client');
    assert.deepEqual(authority.authenticate(invitation.credential)?.operationGrants, [
      'host.status',
    ]);

    const observation = prepared.grants.find((grant) => grant.kind === 'session_observation')!;
    assert.equal(
      authority.activeSessionGrant(prepared.principalId, 'session-1', 'session_observation')
        ?.grantId,
      observation.grantId,
    );
    assert.equal(
      (await authority.revokeCollaborationGrant({ grantId: observation.grantId })).revoked,
      true,
    );
    assert.equal(
      authority.activeSessionGrant(prepared.principalId, 'session-1', 'session_observation'),
      undefined,
    );

    assert.deepEqual(await authority.revokeCollaborationPrincipal(prepared.principalId), {
      revoked: true,
    });
    assert.equal(authority.authenticate(invitation.credential), undefined);
    assert.equal(authority.queryCollaborationAccess({ sessionId: 'session-1' }).grants.length, 0);
  } finally {
    await authority.close();
    await rm(directory, { recursive: true, force: true });
  }
});
