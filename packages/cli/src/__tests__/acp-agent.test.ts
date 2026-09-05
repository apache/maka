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
  test('returns the Maka identity and advertises only Session listing', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        assert.deepEqual(await agent.request(methods.agent.initialize, { protocolVersion: 1 }), {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { list: {} } },
          authMethods: [],
          agentInfo: { name: 'maka', title: 'Maka', version: '0.2.0' },
        });
      },
    );
  });

  test('routes official SDK new and list requests through the Session registry', async () => {
    const creates: unknown[] = [];
    const lists: unknown[] = [];
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({
        version: '0.2.0',
        sessionRegistry: fakeSessionRegistry({ creates, lists }),
      }),
      async (agent) => {
        assert.deepEqual(
          await agent.request(methods.agent.session.new, {
            cwd: '/workspace',
            mcpServers: [],
            _meta: { ignored: true },
          }),
          { sessionId: 'session-1' },
        );
        assert.deepEqual(await agent.request(methods.agent.session.list, { cwd: '/workspace' }), {
          sessions: [
            {
              sessionId: 'session-1',
              cwd: '/workspace',
              title: 'Session',
              updatedAt: '2026-08-24T00:00:00.000Z',
            },
          ],
        });
      },
    );
    assert.deepEqual(creates, [{ cwd: '/workspace', mcpServers: [], _meta: { ignored: true } }]);
    assert.deepEqual(lists, [{ cwd: '/workspace' }]);
  });

  test('routes official SDK set-config requests through the Session registry', async () => {
    const configurationRequests: unknown[] = [];
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({
        version: '0.2.0',
        sessionRegistry: fakeSessionRegistry({ configurationRequests }),
      }),
      async (agent) => {
        assert.deepEqual(
          await agent.request(methods.agent.session.setConfigOption, {
            sessionId: 'session-1',
            configId: 'collaboration_mode',
            value: 'plan',
          }),
          {
            configOptions: [
              {
                type: 'select',
                id: 'collaboration_mode',
                name: 'Collaboration mode',
                category: 'mode',
                currentValue: 'plan',
                options: [
                  { value: 'agent', name: 'Agent' },
                  { value: 'plan', name: 'Plan' },
                ],
              },
            ],
          },
        );
      },
    );
    assert.deepEqual(configurationRequests, [
      { sessionId: 'session-1', configId: 'collaboration_mode', value: 'plan' },
    ]);
  });

  test('does not implement or advertise session/close', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        await assert.rejects(
          agent.request(methods.agent.session.close, { sessionId: 'session-1' }),
          (error: unknown) => {
            assert.ok(error instanceof RequestError);
            assert.equal(error.code, -32601);
            assert.deepEqual(error.data, { method: 'session/close' });
            return true;
          },
        );
      },
    );
  });

  test('does not implement session/set_mode', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        await assert.rejects(
          agent.request(methods.agent.session.setMode, {
            sessionId: 'session-1',
            modeId: 'plan',
          }),
          (error: unknown) => {
            assert.ok(error instanceof RequestError);
            assert.equal(error.code, -32601);
            assert.deepEqual(error.data, { method: 'session/set_mode' });
            return true;
          },
        );
      },
    );
  });

  test('selects v1 when the client requests an unsupported lower or higher version', async () => {
    for (const protocolVersion of [0, 2]) {
      await client({ name: 'test-client' }).connectWith(
        createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
        async (agent) => {
          const response = await agent.request(methods.agent.initialize, { protocolVersion });
          assert.equal(response.protocolVersion, 1);
        },
      );
    }
  });
});

function fakeSessionRegistry(
  observations: { creates?: unknown[]; lists?: unknown[]; configurationRequests?: unknown[] } = {},
) {
  return {
    create: async (params: unknown) => {
      observations.creates?.push(params);
      return { sessionId: 'session-1' };
    },
    list: async (params: unknown) => {
      observations.lists?.push(params);
      return {
        sessions: [
          {
            sessionId: 'session-1',
            cwd: '/workspace',
            title: 'Session',
            updatedAt: '2026-08-24T00:00:00.000Z',
          },
        ],
      };
    },
    setConfigOption: async (params: unknown) => {
      observations.configurationRequests?.push(params);
      return {
        configOptions: [
          {
            type: 'select' as const,
            id: 'collaboration_mode',
            name: 'Collaboration mode',
            category: 'mode',
            currentValue: 'plan',
            options: [
              { value: 'agent', name: 'Agent' },
              { value: 'plan', name: 'Plan' },
            ],
          },
        ],
      };
    },
  };
}
