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
  clientCapabilityScopeIdentity,
  decodeClientCapabilityGrantTarget,
  decodeClientCapabilitySessionGrant,
} from '../client-capability-grant.js';
import {
  decodeInteractionRequest,
  projectInteractionClientCapabilityRequest,
} from '../interaction.js';

const target = {
  providerId: 'desktop-provider',
  contractId: 'history-contract',
  serverId: 'desktop_computer_history',
  toolName: 'ComputerHistorySearch',
  capability: 'computer_history',
  scope: { kind: 'capability' },
} as const;

test('History capability survives durable grant decoding and interaction projection', () => {
  const input = { version: 1, sessionId: 'session-1', ...target, grantedAt: 100 };
  const grant = decodeClientCapabilitySessionGrant(JSON.parse(JSON.stringify(input)));
  assert.deepEqual(grant, input);
  assert.equal(Object.isFrozen(grant), true);
  assert.equal(Object.isFrozen(grant.scope), true);
  assert.equal(clientCapabilityScopeIdentity(grant.scope), '*');
  const request = projectInteractionClientCapabilityRequest({
    toolUseId: 'tool-1',
    target: grant,
  });
  assert.deepEqual(decodeInteractionRequest(JSON.parse(JSON.stringify(request))), {
    kind: 'client_capability',
    toolUseId: 'tool-1',
    target,
  });
});

test('History grants accept only the exact capability scope', () => {
  for (const scope of [
    { kind: 'browser_origin', origin: 'https://example.com' },
    { kind: 'mcp_tool', serverId: target.serverId, toolName: target.toolName },
    { kind: 'capability', recording: true },
    { kind: 'capability', origin: 'https://example.com' },
  ]) {
    assert.throws(() => decodeClientCapabilityGrantTarget({ ...target, scope }));
  }
  assert.throws(() =>
    decodeClientCapabilityGrantTarget({ ...target, capability: 'computer_history_admin' }),
  );
  assert.throws(() =>
    decodeClientCapabilitySessionGrant({
      version: 1,
      sessionId: 'session-1',
      ...target,
      grantedAt: 100,
      recording: true,
    }),
  );
});

test('adding History does not widen Browser or MCP scopes or remove Computer Use support', () => {
  assert.equal(
    decodeClientCapabilityGrantTarget({ ...target, capability: 'computer_use' }).capability,
    'computer_use',
  );
  for (const capability of ['browser', 'desktop_mcp']) {
    assert.throws(
      () => decodeClientCapabilityGrantTarget({ ...target, capability }),
      /scope does not match capability/u,
    );
  }
});
