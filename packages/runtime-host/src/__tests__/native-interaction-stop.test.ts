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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { waitFor } from '@maka/core/test-only/async-primitives';
import { resolveStorageRoot, tryAcquireInteractiveRootOwner } from '@maka/storage/root-authority';
import { openInteractiveRuntimePolicyStoresForWrite } from '@maka/storage/runtime-policy-stores';
import { connectRuntimeHost, type RuntimeHostConnection } from '../client/index.js';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '../protocol/index.js';
import { createExecutionRuntimeHostComposition } from '../server/execution-composition.js';
import { startExecutionRuntimeHostService } from '../server/execution-service.js';

test('stopping a native AskUser settles the tool before the terminal and leaves other Turns running', {
  timeout: 60_000,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'maka-native-question-stop-'));
  let host: Awaited<ReturnType<typeof startExecutionRuntimeHostService>> | undefined;
  let connection: RuntimeHostConnection | undefined;
  const provider = createServer((request, response) => {
    void (async () => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const finish = input.messages.some(
        (message: { role: string; content: unknown }) =>
          message.role === 'tool' || JSON.stringify(message.content).includes('after-stop'),
      );
      response.setHeader('content-type', 'text/event-stream');
      const chunk = (delta: object, finishReason: string | null) =>
        `data: ${JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion.chunk',
          created: 1,
          model: 'native-stop-model',
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })}\n\n`;
      response.write(chunk({ role: 'assistant' }, null));
      response.write(
        chunk(
          finish
            ? { content: 'Native task completed' }
            : {
                tool_calls: [
                  {
                    index: 0,
                    id: randomUUID(),
                    type: 'function',
                    function: {
                      name: 'AskUserQuestion',
                      arguments: JSON.stringify({
                        questions: [
                          {
                            question: 'Continue?',
                            options: [{ label: 'Yes' }, { label: 'No' }],
                          },
                        ],
                      }),
                    },
                  },
                ],
              },
          null,
        ),
      );
      response.write(chunk({}, finish ? 'stop' : 'tool_calls'));
      response.end('data: [DONE]\n\n');
    })().catch((error) => response.destroy(error as Error));
  });
  t.after(async () => {
    await connection?.close();
    provider.closeAllConnections();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    try {
      await host?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  assert.ok(address && typeof address === 'object');
  const owner = await tryAcquireInteractiveRootOwner(
    await resolveStorageRoot({ path: root, kind: 'interactive' }),
  );
  assert.ok(owner);
  let connectionId: string;
  try {
    const policy = await openInteractiveRuntimePolicyStoresForWrite(owner.lease);
    const created = await policy.connectionCatalog.create({
      expectedCatalogRevision: 0,
      connection: {
        slug: 'local',
        name: 'Local native fixture',
        providerType: 'ollama',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        enabled: true,
        enabledModelIds: ['native-stop-model'],
      },
    });
    assert.equal(created.kind, 'committed');
    if (created.kind !== 'committed') throw new Error('Fixture connection failed');
    connectionId = created.snapshot.connections[0]!.connectionId;
    const fetch = await policy.operations.beginModelFetch(connectionId);
    assert.equal(fetch.kind, 'ready');
    if (fetch.kind !== 'ready') throw new Error('Fixture discovery failed');
    assert.equal(
      (
        await policy.operations.completeModelFetch(fetch.ticket, {
          models: [{ id: 'native-stop-model' }],
          source: 'fetched',
          fetchedAt: Date.now(),
        })
      ).kind,
      'committed',
    );
  } finally {
    await owner.close();
  }
  host = await startExecutionRuntimeHostService(
    { rootPath: root },
    {
      createComposition: (context, options) =>
        createExecutionRuntimeHostComposition(
          context,
          { ...options, bootstrapRuntimePolicy: false },
          { generateSessionTitle: async () => undefined },
        ),
    },
  );
  const connected = await connectRuntimeHost({
    rootPath: root,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  });
  assert.equal(connected.kind, 'connected');
  if (connected.kind !== 'connected') throw new Error('Host did not connect');
  const client = connected.connection;
  connection = client;
  const read = async (sessionId: string) => {
    const sub = await client.openSessionSubscription({ sessionId, transcript: { kind: 'none' } });
    try {
      await sub.ready();
      return sub.snapshot;
    } finally {
      await sub.close();
    }
  };
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const sessionId = randomUUID();
    ids.push(sessionId);
    await client.request('session.create', {
      sessionId,
      workspace: { kind: 'host_path', path: root },
      modelTarget: {
        kind: 'explicit',
        connectionId,
        connectionSlug: 'local',
        model: 'native-stop-model',
      },
    });
    await client.request('turn.start', {
      sessionId,
      turnId: randomUUID(),
      content: { text: 'Ask a question' },
    });
    await waitFor(
      async () =>
        (await read(sessionId)).interactions.pending.some((p) => p.request.kind === 'question'),
      { timeoutMs: 10_000 },
    );
  }
  const [targetId, siblingId] = ids as [string, string];
  const target = (await read(targetId)).rootTurn!;
  const sibling = await read(siblingId);
  const before = await client.request('host.diagnostics.query', {});
  const stopped = await client.request('turn.stop', {
    sessionId: targetId,
    turnId: target.turnId,
    runId: target.runId,
  });
  assert.equal(stopped.status, 'cancelled');
  const again = await client.request('turn.stop', {
    sessionId: targetId,
    turnId: target.turnId,
    runId: target.runId,
  });
  assert.deepEqual(again, stopped);
  assert.equal((await read(targetId)).interactions.pending.length, 0);
  const untouched = await read(siblingId);
  assert.equal(untouched.rootTurn?.runId, sibling.rootTurn?.runId);
  assert.equal(
    untouched.interactions.pending[0]?.interactionId,
    sibling.interactions.pending[0]?.interactionId,
  );
  const after = await client.request('host.diagnostics.query', {});
  assert.equal(after.hostEpoch, before.hostEpoch);
  assert.equal(after.state, 'ready');
  await client.request('interaction.answer', {
    sessionId: siblingId,
    interactionId: untouched.interactions.pending[0]!.interactionId,
    answer: { kind: 'question', answers: ['Yes'] },
  });
  await waitFor(async () => (await read(siblingId)).rootTurn?.status === 'completed', {
    timeoutMs: 10_000,
  });
  await client.request('turn.start', {
    sessionId: targetId,
    turnId: randomUUID(),
    content: { text: 'after-stop' },
  });
  await waitFor(async () => (await read(targetId)).rootTurn?.status === 'completed', {
    timeoutMs: 10_000,
  });
});
