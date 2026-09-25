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
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';

const content = 'written 😀 中文\n';
const edited = 'edited $& 😀\n';
const sessionIds = ['write-ask', 'write-explore'];
const editMetadata = { ok: true, replacements: 1, matchedVia: 'exact', startLine: 1, endLine: 1 };
const globResult = { files: ['written.txt'], complete: true };
const grepResult = { matches: ['1:edited $& 😀'], complete: true };

async function fixture(writeResult) {
  const editResult = { ...editMetadata, path: writeResult.path };
  const script = [
    { name: 'Write', args: { path: 'written.txt', content } },
    {
      name: 'Edit',
      args: { path: 'written.txt', old_string: content, new_string: edited },
      expected: writeResult,
    },
    { name: 'Glob', args: { pattern: 'written.*' }, expected: editResult },
    { name: 'Grep', args: { pattern: '^edited', path: 'written.txt' }, expected: globResult },
    { name: 'Read', args: { path: 'written.txt' }, expected: grepResult },
    { answer: 'mutations verified', expected: readPage(edited, { path: 'written.txt' }) },
    { name: 'Write', args: { path: 'sentinel.txt', content } },
    { answer: 'write unavailable', expected: 'tool is unavailable' },
  ];
  let count = 0,
    failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer dummy-write-fixture');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert(Buffer.byteLength(body) < 128 * 1024);
      }
      const input = JSON.parse(body);
      const index = ++count;
      assert(index <= script.length);
      const action = script[index - 1];
      assert(input.tools.some((tool) => tool.function.name === 'Read'));
      for (const name of ['Write', 'Edit']) {
        assert.equal(
          input.tools.some((tool) => tool.function.name === name),
          index <= 6,
        );
      }
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
          id: 'write-fixture',
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

export async function verifyWriteWorkflow(connection, workspace, reopened) {
  const snapshot = join(workspace, 'write-rows.json');
  if (reopened) {
    const stored = (await Promise.all(sessionIds.map((id) => rows(connection, id)))).flat();
    assert.equal(JSON.stringify(stored), await readFile(snapshot, 'utf8'));
    assert.equal(await readFile(join(workspace, 'written.txt'), 'utf8'), edited);
    assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'UNCHANGED');
    console.log(JSON.stringify({ check: 'original-client-write-reopened', result: 'passed' }));
    return;
  }
  await writeFile(join(workspace, 'sentinel.txt'), 'UNCHANGED');
  const writeResult = {
    kind: 'file_write',
    path: join(await realpath(workspace), 'written.txt'),
    bytes: Buffer.byteLength(content),
  };
  const model = await fixture(writeResult);
  const request = (operation, input) => connection.request(operation, input, 3000);
  try {
    const created = await createModelConnection(request, {
      providerName: 'openai-compatible',
      slug: 'write-fixture',
      name: 'Write fixture',
      baseUrl: model.baseUrl,
      apiKey: 'dummy-write-fixture',
      enabledModelIds: ['fixture-model'],
      modelOverrides: { 'fixture-model': { contextWindow: 200000 } },
    });
    const basis = created.connection;
    await request('connection.catalog.set-default-target', {
      expectedCatalogRevision: created.catalogRevision,
      target: { connectionId: basis.connectionId, modelId: 'fixture-model' },
    });
    const stored = [],
      events = [];
    for (const sessionId of sessionIds) {
      const explore = sessionId === 'write-explore';
      await request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: workspace },
        modelTarget: { kind: 'default' },
        ...(explore
          ? { mode: 'bot', sandboxMode: 'read-only' }
          : { sandboxMode: 'workspace-write' }),
      });
      const live = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
      try {
        await request('turn.start', {
          sessionId,
          turnId: sessionId,
          content: { text: sessionId },
          maxSteps: 6,
        });
        await live.waitFor(
          (frame) =>
            frame.kind === 'subscription.session_projection' &&
            frame.snapshot.rootTurn?.turnId === sessionId &&
            ['completed', 'failed', 'cancelled'].includes(frame.snapshot.rootTurn.status),
        );
        model.healthy();
        assert.equal(
          (await request('turn.query', { sessionId, turnId: sessionId })).status,
          'completed',
        );
        stored.push(...(await rows(connection, sessionId)));
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
    assert.equal(await readFile(join(workspace, 'written.txt'), 'utf8'), edited);
    assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'UNCHANGED');
    const calls = stored.filter((row) => row.type === 'tool_call');
    const results = stored.filter((row) => row.type === 'tool_result');
    assert.deepEqual(
      calls.map((row) => row.toolName),
      ['Write', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
    );
    assert.equal(results.length, 6);
    assert.equal(events.length, 12);
    assert.equal(
      new Set(stored.map((row) => row.id)).size,
      stored.length,
      'reused provider ID must not collide even within one invocation',
    );
    assert.deepEqual(results[0].content, { kind: 'json', value: writeResult });
    assert.deepEqual(results[1].content, {
      kind: 'json',
      value: { ...editMetadata, path: writeResult.path },
    });
    assert.deepEqual(results[2].content, { kind: 'json', value: globResult });
    assert.deepEqual(results[3].content, { kind: 'json', value: grepResult });
    assert.deepEqual(results[4].content, {
      kind: 'json',
      value: readPage(edited, { path: 'written.txt' }),
    });
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index],
        result = results[index];
      assert.equal(call.origin, 'provider');
      assert.equal(call.modelVisibility, 'visible');
      assert.equal(result.toolUseId, call.id);
      assert.equal(result.isError, index === 5);
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
      assert.equal(end.status, index === 5 ? 'errored' : 'completed');
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
    await writeFile(join(workspace, 'write-live.json'), JSON.stringify(events));
    console.log(JSON.stringify({ check: 'original-client-write', result: 'passed' }));
  } finally {
    await model.close();
  }
}
