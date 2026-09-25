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
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';

const sessionId = 'patch-ask';
const content = 'first\nupdated $& 😀\n';
const completed = { status: 'completed' };
const patch = (operation) => ({
  name: 'apply_patch',
  args: { callId: 'opaque:not-authority', operation },
});

async function fixture(workspace) {
  const target = join(workspace, 'patched.txt');
  let identity;
  const script = [
    patch({ type: 'create_file', path: 'patched.txt', diff: '+first\n+' }),
    {
      ...patch({ type: 'update_file', path: 'patched.txt', diff: '@@\n first\n+updated $& 😀' }),
      expected: completed,
    },
    { name: 'Read', args: { path: 'patched.txt' }, expected: completed },
    { answer: 'patch verified', expected: readPage(content, { path: 'patched.txt' }) },
    patch({ type: 'delete_file', path: 'patched.txt' }),
    { answer: 'delete verified', expected: completed },
  ];
  let count = 0,
    failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer dummy-patch-fixture');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert(Buffer.byteLength(body) < 128 * 1024);
      }
      const input = JSON.parse(body);
      const index = ++count;
      assert(index <= script.length);
      const action = script[index - 1];
      if (index === 2) {
        assert.equal(await readFile(target, 'utf8'), 'first\n');
        identity = await stat(target);
      }
      if (index === 3) {
        assert.equal(await readFile(target, 'utf8'), content);
        const after = await stat(target);
        assert.equal(after.ino, identity.ino);
        assert.equal(after.dev, identity.dev);
      }
      if (index === 6) await assert.rejects(stat(target), { code: 'ENOENT' });
      assert(input.tools.some((tool) => tool.function.name === 'apply_patch'));
      if (Object.hasOwn(action, 'expected')) {
        const result = input.messages.at(-1);
        assert.equal(result.role, 'tool');
        assert.equal(result.tool_call_id, 'provider:reused');
        assert.deepEqual(
          typeof action.expected === 'string' ? result.content : JSON.parse(result.content),
          action.expected,
        );
      }
      const isTool = Boolean(action.name);
      const delta = isTool
        ? {
            tool_calls: [
              {
                index: 0,
                id: 'provider:reused',
                type: 'function',
                function: { name: action.name, arguments: JSON.stringify(action.args) },
              },
            ],
          }
        : { content: action.answer };
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const frame = (delta, finish_reason) =>
        'data: ' +
        JSON.stringify({
          id: 'patch-fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture-model',
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n';
      response.end(
        frame(delta, null) + frame({}, isTool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
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
    healthy() {
      if (failure) throw failure;
    },
    verify() {
      if (failure) throw failure;
      assert.equal(count, script.length);
    },
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function rows(connection, sessionId) {
  const observer = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
  try {
    return await observer.subscription.loadTranscript(decodeStoredMessage);
  } finally {
    await observer.close();
  }
}

export async function verifyPatchWorkflow(connection, workspace, reopened) {
  const snapshot = join(workspace, 'patch-rows.json');
  if (reopened) {
    const stored = await rows(connection, sessionId);
    assert.equal(JSON.stringify(stored), await readFile(snapshot, 'utf8'));
    await assert.rejects(stat(join(workspace, 'patched.txt')), { code: 'ENOENT' });
    console.log(JSON.stringify({ check: 'original-client-patch-reopened', result: 'passed' }));
    return;
  }
  const model = await fixture(workspace);
  const request = (operation, input) => connection.request(operation, input, 3000);
  try {
    const created = await createModelConnection(request, {
      providerName: 'openai-compatible',
      slug: 'patch-fixture',
      name: 'Patch fixture',
      baseUrl: model.baseUrl,
      apiKey: 'dummy-patch-fixture',
      enabledModelIds: ['fixture-model'],
      modelOverrides: { 'fixture-model': { contextWindow: 200000, applyPatch: true } },
    });
    const basis = created.connection;
    await request('connection.catalog.set-default-target', {
      expectedCatalogRevision: created.catalogRevision,
      target: { connectionId: basis.connectionId, modelId: 'fixture-model' },
    });
    const stored = [],
      events = [];
    await request('session.create', {
      sessionId,
      workspace: { kind: 'host_path', path: workspace },
      modelTarget: { kind: 'default' },
      sandboxMode: 'workspace-write',
    });
    for (const turnId of ['patch-create-update', 'patch-delete']) {
      const live = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
      try {
        await request('turn.start', {
          sessionId,
          turnId,
          content: { text: turnId },
          maxSteps: 4,
        });
        await live.waitFor(
          (frame) =>
            frame.kind === 'subscription.session_projection' &&
            frame.snapshot.rootTurn?.turnId === turnId &&
            ['completed', 'failed', 'cancelled'].includes(frame.snapshot.rootTurn.status),
        );
        model.healthy();
        assert.equal((await request('turn.query', { sessionId, turnId })).status, 'completed');

        events.push(
          ...live.frames
            .filter((frame) => frame.kind === 'subscription.session_event')
            .map((frame) => frame.event)
            .filter((event) => ['tool_start', 'tool_result'].includes(event.type)),
        );
        const fences = live.frames
          .filter((frame) => frame.kind === 'subscription.transcript_advanced')
          .map((frame) => frame.throughSequence);
        assert(fences.length > 1);
        assert(fences.every((fence, index) => index === 0 || fence > fences[index - 1]));
      } finally {
        await live.close();
      }
    }
    model.verify();
    stored.push(...(await rows(connection, sessionId)));
    await assert.rejects(stat(join(workspace, 'patched.txt')), { code: 'ENOENT' });
    const calls = stored.filter((row) => row.type === 'tool_call');
    const results = stored.filter((row) => row.type === 'tool_result');
    assert.deepEqual(
      calls.map((row) => row.toolName),
      ['apply_patch', 'apply_patch', 'Read', 'apply_patch'],
    );
    assert.equal(results.length, 4);
    assert.equal(events.length, 8);
    assert.equal(
      new Set(stored.map((row) => row.id)).size,
      stored.length,
      'reused provider ID must not collide across invocations',
    );
    for (const index of [0, 1, 3])
      assert.deepEqual(results[index].content, { kind: 'json', value: completed });
    assert.deepEqual(results[2].content, {
      kind: 'json',
      value: readPage(content, { path: 'patched.txt' }),
    });
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index],
        result = results[index];
      assert.equal(call.origin, 'provider');
      assert.equal(call.modelVisibility, 'visible');
      assert.equal(result.toolUseId, call.id);
      assert.equal(result.isError, false);
      const start = events.find(
        (event) => event.type === 'tool_start' && event.toolUseId === call.id,
      );
      const end = events.find(
        (event) => event.type === 'tool_result' && event.toolUseId === call.id,
      );
      assert(start && end);
      assert.equal(start.id, call.id);
      assert.equal(end.id, result.id);
      assert.equal(end.ts, result.ts);
      assert.equal(end.status, 'completed');
    }
    for (const event of events)
      for (const key of [
        'origin',
        'modelVisibility',
        'parentToolCallId',
        'parentOperationId',
        'args',
        'content',
      ])
        assert(!Object.hasOwn(event, key));
    await writeFile(snapshot, JSON.stringify(stored));
    await writeFile(join(workspace, 'patch-live.json'), JSON.stringify(events));
    console.log(JSON.stringify({ check: 'original-client-patch', result: 'passed' }));
  } finally {
    await model.close();
  }
}
