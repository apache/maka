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
  test('returns the Maka identity and advertises Session listing and close', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        assert.deepEqual(await agent.request(methods.agent.initialize, { protocolVersion: 1 }), {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
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

  test('routes the concrete Turn resume extension through the SDK', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        assert.deepEqual(
          await agent.request('_maka/turn/resume', {
            sessionId: 'session-1',
          }),
          {
            kind: 'parked',
            plan: {
              sessionId: 'session-1',
              disposition: 'parked',
              reason: 'resume_candidate_missing',
            },
          },
        );
        await assert.rejects(
          agent.request('_maka/turn/resume', { sessionId: '' }),
          (error: unknown) => error instanceof RequestError && error.code === -32602,
        );
      },
    );
  });

  test('routes bounded copy-source queries and rejects invalid input through the SDK', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        const query = {
          sessionId: 'session-1',
          throughSequence: null,
          position: 0,
          maxContributions: 1,
        };
        assert.deepEqual(await agent.request('_maka/session/copy-source/query', query), {
          sessionId: 'session-1',
          expectedSourceRevision: 1,
          throughSequence: 8,
          contributions: [],
          nextPosition: null,
        });
        for (const invalid of [
          { ...query, sessionId: '' },
          { ...query, maxContributions: 129 },
          { ...query, position: -1 },
        ]) {
          await assert.rejects(
            agent.request('_maka/session/copy-source/query', invalid),
            (error: unknown) => error instanceof RequestError && error.code === -32602,
          );
        }
      },
    );
  });

  test('routes branch, revision, and abandon extensions through the SDK', async () => {
    await client({ name: 'test-client' }).connectWith(
      createMakaAcpAgent({ version: '0.2.0', sessionRegistry: fakeSessionRegistry() }),
      async (agent) => {
        const copy = {
          sourceSessionId: 'session-1',
          targetSessionId: 'session-2',
          sourceTurnId: 'turn-1',
          expectedSourceRevision: 1,
        };
        assert.deepEqual(await agent.request('_maka/session/branch/create', copy), {
          kind: 'source_revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        });
        assert.deepEqual(await agent.request('_maka/session/revision/create', copy), {
          kind: 'source_revision_conflict',
          expectedRevision: 1,
          actualRevision: 2,
        });
        assert.deepEqual(
          await agent.request('_maka/session/revision/abandon', {
            targetSessionId: 'session-1',
          }),
          { kind: 'retained', sessionId: 'session-1' },
        );
      },
    );
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

  test('routes prompt, cancel, and close through the Session registry', async () => {
    const prompts: unknown[] = [];
    const cancellations: unknown[] = [];
    const closes: unknown[] = [];
    const updates: unknown[] = [];
    const testClient = client({ name: 'test-client' }).onNotification(
      methods.client.session.update,
      ({ params }) => void updates.push(params),
    );
    await testClient.connectWith(
      createMakaAcpAgent({
        version: '0.2.0',
        sessionRegistry: fakeSessionRegistry({ prompts, cancellations, closes }),
      }),
      async (agent) => {
        assert.deepEqual(
          await agent.request(methods.agent.session.prompt, {
            sessionId: 'session-1',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
          { stopReason: 'end_turn' },
        );
        await agent.notify(methods.agent.session.cancel, { sessionId: 'session-1' });
        assert.deepEqual(
          await agent.request(methods.agent.session.close, { sessionId: 'session-1' }),
          {},
        );
      },
    );
    assert.deepEqual(prompts, [
      { sessionId: 'session-1', prompt: [{ type: 'text', text: 'hello' }] },
    ]);
    assert.deepEqual(cancellations, [{ sessionId: 'session-1' }]);
    assert.deepEqual(closes, [{ sessionId: 'session-1' }]);
    assert.deepEqual(updates, [
      {
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
          messageId: 'message-1',
        },
      },
    ]);
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
  observations: {
    creates?: unknown[];
    lists?: unknown[];
    configurationRequests?: unknown[];
    prompts?: unknown[];
    cancellations?: unknown[];
    closes?: unknown[];
  } = {},
) {
  return {
    create: async (params: unknown) => {
      observations.creates?.push(params);
      return { sessionId: 'session-1' };
    },
    load: async () => ({}),
    resume: async () => ({}),
    resumeTurn: async () => ({
      kind: 'parked' as const,
      plan: {
        sessionId: 'session-1',
        disposition: 'parked' as const,
        reason: 'resume_candidate_missing' as const,
      },
    }),
    queryCopySource: async () => ({
      sessionId: 'session-1',
      expectedSourceRevision: 1,
      throughSequence: 8,
      contributions: [],
      nextPosition: null,
    }),
    branch: async () => ({
      kind: 'source_revision_conflict' as const,
      expectedRevision: 1,
      actualRevision: 2,
    }),
    createRevision: async () => ({
      kind: 'source_revision_conflict' as const,
      expectedRevision: 1,
      actualRevision: 2,
    }),
    abandonRevision: async () => ({ kind: 'retained' as const, sessionId: 'session-1' }),
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
    prompt: async (params: unknown, context: { notify(notification: unknown): Promise<void> }) => {
      observations.prompts?.push(params);
      await context.notify({
        sessionId: 'session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
          messageId: 'message-1',
        },
      });
      return { stopReason: 'end_turn' as const };
    },
    cancel: async (params: unknown) => void observations.cancellations?.push(params),
    close: async (params: unknown) => {
      observations.closes?.push(params);
      return {};
    },
    artifactQuery: async () => {
      throw new Error('Unexpected Artifact query');
    },
    artifactIngest: async () => {
      throw new Error('Unexpected Artifact ingest');
    },
    artifactDelete: async () => {
      throw new Error('Unexpected Artifact delete');
    },
    memoryQuery: async () => {
      throw new Error('Unexpected Memory query');
    },
    memoryMutate: async () => {
      throw new Error('Unexpected Memory mutation');
    },
  };
}
