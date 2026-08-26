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
import { describe, test } from 'node:test';
import { client, methods, RequestError } from '@agentclientprotocol/sdk';
import { createMakaAcpAgent } from '../acp/maka-acp-agent.js';

describe('Maka ACP agent', () => {
  test('returns the Maka identity with no advertised capabilities or authentication', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0' }),
      async (agent) => {
        assert.deepEqual(await agent.request(methods.agent.initialize, { protocolVersion: 1 }), {
          protocolVersion: 1,
          agentCapabilities: {},
          authMethods: [],
          agentInfo: { name: 'maka', title: 'Maka', version: '0.2.0' },
        });
      },
    );
  });

  test('rejects unimplemented session requests with method details', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0' }),
      async (agent) => {
        await assert.rejects(
          agent.request('session/new', { cwd: '/workspace' }),
          (error: unknown) => {
            assert.ok(error instanceof RequestError);
            assert.equal(error.code, -32601);
            assert.deepEqual(error.data, { method: 'session/new' });
            return true;
          },
        );
      },
    );
  });

  test('selects v1 when the client requests an unsupported lower or higher version', async () => {
    for (const protocolVersion of [0, 2]) {
      await client({ name: 'test-client' }).connectWith(
        createMakaAcpAgent({ version: '0.2.0' }),
        async (agent) => {
          const response = await agent.request(methods.agent.initialize, { protocolVersion });
          assert.equal(response.protocolVersion, 1);
        },
      );
    }
  });
});
