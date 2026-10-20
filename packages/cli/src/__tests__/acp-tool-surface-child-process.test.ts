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
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { methods, type SessionNotification } from '@agentclientprotocol/sdk';
import { withAcpChildProcessHarness } from './acp-child-process-harness.js';

const MODEL_ID = 'acp-tool-surface-fixture';

test('official SDK receives one authoritative builtin tool result before end_turn', {
  timeout: 60_000,
}, async () => {
  let modelCalls = 0;
  const server = createServer((request, response) => {
    void readBody(request)
      .then((body) => {
        const input = JSON.parse(body) as Record<string, unknown>;
        if (input.stream !== true) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              id: 'summary',
              object: 'chat.completion',
              created: 1,
              model: MODEL_ID,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: 'Summary' },
                  finish_reason: 'stop',
                },
              ],
            }),
          );
          return;
        }
        modelCalls += 1;
        const names = (Array.isArray(input.tools) ? input.tools : []).flatMap(
          (tool: { function?: { name?: unknown } }) =>
            typeof tool.function?.name === 'string' ? [tool.function.name] : [],
        );
        if (modelCalls === 1) {
          assert.ok(names.includes('tool_search'));
          respond(response, [
            chunk(
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'builtin-search',
                    type: 'function',
                    function: { name: 'tool_search', arguments: JSON.stringify({ query: 'read' }) },
                  },
                ],
              },
              null,
            ),
            chunk({}, 'tool_calls'),
          ]);
        } else {
          respond(response, [
            chunk({ role: 'assistant', content: 'Tool completed.' }, null),
            chunk({}, 'stop'),
          ]);
        }
      })
      .catch((error: unknown) => response.destroy(error as Error));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await withAcpChildProcessHarness(
      async (harness) => {
        const updates: SessionNotification[] = [];
        await harness.withClient(
          async ({ context }) => {
            await context.request(methods.agent.initialize, { protocolVersion: 1 });
            const created = await context.request(methods.agent.session.new, {
              cwd: harness.workspaceRoot,
              mcpServers: [],
            });
            assert.deepEqual(
              await context.request(methods.agent.session.prompt, {
                sessionId: created.sessionId,
                prompt: [{ type: 'text', text: 'Run a builtin tool' }],
              }),
              { stopReason: 'end_turn' },
            );
            const calls = updates.filter(({ update }) => update.sessionUpdate === 'tool_call');
            assert.equal(calls.length, 1, JSON.stringify(updates));
            const results = updates.filter(
              ({ update }) =>
                update.sessionUpdate === 'tool_call_update' && update.status === 'completed',
            );
            assert.ok(results.length > 0, JSON.stringify(updates));
            assert.ok(results.some(({ update }) => 'rawOutput' in update));
            await context.request(methods.agent.session.close, { sessionId: created.sessionId });
          },
          (app) =>
            app.onNotification(methods.client.session.update, ({ params }) => {
              updates.push(params);
            }),
        );
        await harness.closeStdin();
        assert.deepEqual(await harness.waitForExit(), { code: 0, signal: null });
      },
      {
        startRuntimeHost: true,
        timeoutMs: 45_000,
        model: { id: MODEL_ID, thinkingLevels: [], baseUrl: `http://127.0.0.1:${address.port}/v1` },
      },
    );
    assert.ok(modelCalls >= 2);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

function chunk(delta: Record<string, unknown>, finishReason: 'tool_calls' | 'stop' | null) {
  return {
    id: 'alpha',
    object: 'chat.completion.chunk',
    created: 1,
    model: MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason
      ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
      : {}),
  };
}

function respond(response: ServerResponse, events: readonly unknown[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}
