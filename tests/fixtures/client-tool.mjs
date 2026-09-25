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
import { createModelConnection } from './client-model-connection.mjs';
import { readPage } from '../../packages/runtime/src/read-page.ts';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';
import { verifyWorkspace, persistWorkspace } from './client-workspace.mjs';

const sessionId = 'read-session';
const content = 'workspace secret 😀\nsecond line\n';
const rawId = 'provider:read/reused';

async function fixture(workspace) {
  const requests = [];
  let failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer dummy-read-fixture');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert(Buffer.byteLength(body) < 128 * 1024);
      }
      const input = JSON.parse(body);
      requests.push(input);
      assert(input.tools.some((tool) => tool.function.name === 'Read'));
      assert(!input.tools.some((tool) => tool.function.name === 'Write'));
      const index = requests.length;
      assert(index <= 4, 'exactly two model steps per turn');
      const denied = index > 2;
      const path = denied
        ? join(workspace, '..', 'root', 'test-private', 'outside.txt')
        : 'inside.txt';
      if (index % 2 === 0) {
        const result = input.messages.at(-1);
        assert.equal(result.role, 'tool');
        assert.equal(result.tool_call_id, rawId, 'provider history preserves raw identity');
        if (denied) assert(!result.content.includes('OUTSIDE_SECRET'));
        else assert.deepEqual(JSON.parse(result.content), readPage(content, { path }));
      }
      const delta =
        index % 2
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: rawId,
                  type: 'function',
                  function: { name: 'Read', arguments: JSON.stringify({ path }) },
                },
              ],
            }
          : { content: denied ? 'read denied' : 'read complete' };
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const frame = (delta, finish_reason) =>
        'data: ' +
        JSON.stringify({
          id: 'read-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n';
      response.end(
        frame(delta, null) + frame({}, index % 2 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
      );
    } catch (error) {
      failure = error;
      response.destroy(error);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    verify() {
      if (failure) throw failure;
      assert.equal(requests.length, 4);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function rows(connection) {
  const observer = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
  try {
    return await observer.subscription.loadTranscript(decodeStoredMessage);
  } finally {
    await observer.close();
  }
}

export async function verifyReadWorkflow(connection, workspace, reopened) {
  const snapshot = join(workspace, 'read-rows.json');
  if (reopened) {
    await persistWorkspace(connection, sessionId, workspace, true);
    assert.equal(
      JSON.stringify(await rows(connection)),
      await readFile(snapshot, 'utf8'),
      'reopen preserves exact decoded rows, timestamps, identities and content',
    );
    console.log(JSON.stringify({ check: 'original-client-read-reopened', result: 'passed' }));
    return;
  }
  await writeFile(join(workspace, 'inside.txt'), 'OLD_WORKSPACE_SENTINEL');
  await mkdir(join(workspace, '..', 'root', 'test-private'), { recursive: true });
  await writeFile(join(workspace, '..', 'root', 'test-private', 'outside.txt'), 'OUTSIDE_SECRET');
  const model = await fixture(workspace);
  const request = (operation, input) => connection.request(operation, input, 3000);
  try {
    const created = await createModelConnection(request, {
      providerName: 'openai-compatible',
      slug: 'read-fixture',
      name: 'Read fixture',
      baseUrl: model.baseUrl,
      apiKey: 'dummy-read-fixture',
      enabledModelIds: ['fixture-model'],
      modelOverrides: { 'fixture-model': { contextWindow: 200000 } },
    });
    const basis = created.connection;
    await request('connection.catalog.set-default-target', {
      expectedCatalogRevision: created.catalogRevision,
      target: { connectionId: basis.connectionId, modelId: 'fixture-model' },
    });
    await request('session.create', {
      sessionId,
      workspace: { kind: 'host_path', path: workspace },
      modelTarget: { kind: 'default' },
      mode: 'bot',
      sandboxMode: 'read-only',
    });
    const relocated = await verifyWorkspace(connection, sessionId, workspace);
    await writeFile(join(relocated, 'inside.txt'), content);
    const live = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
    try {
      for (const turnId of ['read-allowed', 'read-denied']) {
        await request('turn.start', { sessionId, turnId, content: { text: turnId }, maxSteps: 3 });
        await live.waitFor(
          (frame) =>
            frame.kind === 'subscription.session_projection' &&
            frame.snapshot.rootTurn?.turnId === turnId &&
            ['completed', 'failed', 'cancelled'].includes(frame.snapshot.rootTurn.status),
        );
        assert.equal((await request('turn.query', { sessionId, turnId })).status, 'completed');
      }
      model.verify();
      const stored = await rows(connection);
      const calls = stored.filter((row) => row.type === 'tool_call');
      const results = stored.filter((row) => row.type === 'tool_result');
      assert.equal(calls.length, 2);
      assert.equal(results.length, 2);
      assert.notEqual(calls[0].id, calls[1].id, 'reused raw IDs cannot collide across invocations');
      assert.equal(new Set(stored.map((row) => row.id)).size, stored.length);
      const events = live.frames
        .filter((frame) => frame.kind === 'subscription.session_event')
        .map((frame) => frame.event)
        .filter((event) => ['tool_start', 'tool_result'].includes(event.type));
      assert.equal(events.length, 4);
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index],
          result = results[index];
        assert.match(call.id, /^tool_[a-f0-9]{64}$/);
        assert.equal(call.toolName, 'Read');
        assert.equal(call.origin, 'provider');
        assert.equal(call.modelVisibility, 'visible');
        assert.equal(result.toolUseId, call.id);
        assert.equal(result.isError, index === 1);
        const start = events.find(
          (event) => event.type === 'tool_start' && event.toolUseId === call.id,
        );
        const end = events.find(
          (event) => event.type === 'tool_result' && event.toolUseId === call.id,
        );
        assert(start && end);
        assert.equal(start.id, call.id);
        // Call acceptance and dispatch are distinct facts; Rust checks the live T1 timestamp.
        assert.equal(end.id, result.id);
        assert.equal(end.ts, result.ts);
        assert.equal(end.status, index ? 'errored' : 'completed');
      }
      assert.deepEqual(results[0].content, {
        kind: 'json',
        value: readPage(content, { path: 'inside.txt' }),
      });
      assert(!JSON.stringify(stored).includes('OUTSIDE_SECRET'));
      for (const event of events)
        for (const key of [
          'origin',
          'modelVisibility',
          'parentToolCallId',
          'parentOperationId',
          'args',
          'content',
        ])
          assert(!Object.hasOwn(event, key), 'forbidden live field: ' + key);
      const fences = live.frames
        .filter((frame) => frame.kind === 'subscription.transcript_advanced')
        .map((frame) => frame.throughSequence);
      assert(fences.length > 1);
      assert(fences.every((fence, index) => index === 0 || fence > fences[index - 1]));
      await writeFile(snapshot, JSON.stringify(stored));
      await writeFile(join(workspace, 'read-live.json'), JSON.stringify(events));
      await persistWorkspace(connection, sessionId, workspace, false);
      console.log(JSON.stringify({ check: 'original-client-read', result: 'passed' }));
    } finally {
      await live.close();
    }
  } finally {
    await model.close();
  }
}
