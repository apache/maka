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
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeStoredMessage } from '../../packages/core/src/session.ts';
import { watchSession } from './client-subscription.mjs';
import { verifyResourceQueries } from './client-resource-query.mjs';
import { verifyResourceLifecycle } from './client-resource-lifecycle.mjs';
import { verifyModelBackground } from './client-model-shell.mjs';

const windows = process.platform === 'win32';
const command = windows
  ? '[IO.File]::AppendAllText((Join-Path (Get-Location) marker.txt), "run`n"); [Console]::Out.Write("hello 😀`n"); [Console]::Error.Write("error 中文`n"); exit 7'
  : "printf 'run\\n' >> marker.txt; printf 'hello 😀\\n'; printf 'error 中文\\n' >&2; exit 7";
const sessionIds = ['shell-bypass', 'shell-readonly'];

async function fixture(terminal) {
  const script = [
    { name: 'Shell', args: { command, timeout_ms: 3000 } },
    { answer: 'nonzero exit observed', expected: terminal },
    {
      name: 'Shell',
      args: {
        command: windows
          ? "[IO.File]::WriteAllText((Join-Path (Get-Location) sentinel.txt), 'MUTATED')"
          : "printf 'MUTATED' > sentinel.txt",
      },
    },
    { answer: 'read-only write rejected', rejectedWrite: true },
  ];
  let count = 0,
    failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer dummy-shell-fixture');
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        assert(Buffer.byteLength(body) < 128 * 1024);
      }
      const input = JSON.parse(body);
      const index = ++count;
      assert(index <= script.length);
      const pending = script[index - 1];
      const action = typeof pending === 'function' ? await pending(input) : pending;
      assert(input.tools.some((tool) => tool.function.name === 'Shell'));
      if (action.rejectedWrite) {
        const result = input.messages.at(-1);
        assert.equal(result.role, 'tool');
        if (process.platform !== 'win32') {
          const terminal = JSON.parse(result.content);
          assert.equal(terminal.kind, 'terminal');
          assert.equal(terminal.status, 'failed');
          assert.notEqual(terminal.exitCode, 0);
        } else {
          // This fixture deliberately has no provisioned Windows installation.
          // Managed launch must explain setup, never execute without isolation.
          assert.match(result.content, /Windows sandbox setup is required/);
        }
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
      if (response.destroyed) return;
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      const frame = (delta, finish_reason) =>
        'data: ' +
        JSON.stringify({
          id: 'shell-fixture',
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
    extend(actions) {
      script.push(...actions);
    },
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

export async function verifyShellWorkflow(connection, workspace, reopened, openConnection) {
  const snapshot = join(workspace, 'shell-rows.json');
  if (reopened) {
    await verifyModelBackground(connection, workspace, true);
    await verifyResourceLifecycle(connection, workspace, true);
    await verifyResourceQueries(connection, workspace);
    const stored = (await Promise.all(sessionIds.map((id) => rows(connection, id)))).flat();
    assert.equal(JSON.stringify(stored), await readFile(snapshot, 'utf8'));
    assert.equal(await readFile(join(workspace, 'marker.txt'), 'utf8'), 'run\n');
    assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'UNCHANGED');
    console.log(JSON.stringify({ check: 'original-client-shell-reopened', result: 'passed' }));
    return;
  }
  await writeFile(join(workspace, 'sentinel.txt'), 'UNCHANGED');
  const terminal = {
    kind: 'terminal',
    cwd: await realpath(workspace),
    cmd: command,
    status: 'failed',
    exitCode: 7,
    failureMessage: 'Command exited with code 7',
    output: {
      mode: 'pipes',
      stdout: 'hello 😀\n',
      stderr: 'error 中文\n',
      stdoutTruncated: false,
      stderrTruncated: false,
      redacted: false,
    },
  };
  const model = await fixture(terminal);
  const request = (operation, input) => connection.request(operation, input, 3000);
  try {
    const created = await createModelConnection(request, {
      providerName: 'openai-compatible',
      slug: 'shell-fixture',
      name: 'Shell fixture',
      baseUrl: model.baseUrl,
      apiKey: 'dummy-shell-fixture',
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
      const bypass = sessionId === 'shell-bypass';
      await request('session.create', {
        sessionId,
        workspace: { kind: 'host_path', path: workspace },
        modelTarget: { kind: 'default' },
        sandboxMode: bypass ? 'danger-full-access' : 'read-only',
      });
      const live = await watchSession(connection, sessionId, { kind: 'tail', maxBytes: 2 });
      try {
        await request('turn.start', {
          sessionId,
          turnId: sessionId,
          content: { text: sessionId },
          maxSteps: 4,
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
    assert.equal(await readFile(join(workspace, 'marker.txt'), 'utf8'), 'run\n');
    assert.equal(await readFile(join(workspace, 'sentinel.txt'), 'utf8'), 'UNCHANGED');
    const calls = stored.filter((row) => row.type === 'tool_call');
    const results = stored.filter((row) => row.type === 'tool_result');
    assert.deepEqual(
      calls.map((row) => row.toolName),
      ['Shell', 'Shell'],
    );
    assert.equal(results.length, 2);
    assert.equal(events.length, 4);
    assert.equal(
      new Set(stored.map((row) => row.id)).size,
      stored.length,
      'reused provider ID must not collide across invocations',
    );
    // A known nonzero shell exit is a completed tool execution with a failed terminal value.
    assert.deepEqual(results[0].content, { kind: 'json', value: terminal });
    for (let index = 0; index < calls.length; index++) {
      const call = calls[index],
        result = results[index];
      assert.equal(call.origin, 'provider');
      assert.equal(call.modelVisibility, 'visible');
      assert.equal(result.toolUseId, call.id);
      const rejectedBeforeStart = index === 1 && process.platform === 'win32';
      assert.equal(result.isError, rejectedBeforeStart);
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
      assert.equal(end.status, rejectedBeforeStart ? 'errored' : 'completed');
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
    await verifyResourceLifecycle(connection, workspace, false, openConnection);
    await verifyModelBackground(connection, workspace, false, model);
    await writeFile(snapshot, JSON.stringify(stored));
    await writeFile(join(workspace, 'shell-live.json'), JSON.stringify(events));
    console.log(JSON.stringify({ check: 'original-client-shell', result: 'passed' }));
  } finally {
    await model.close();
  }
}
