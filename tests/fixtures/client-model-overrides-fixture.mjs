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
import { readPage } from '../../packages/runtime/src/read-page.ts';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { secret } from './client-model-overrides-catalog.mjs';

export const evidence = 'MODEL_FACTS_FROZEN_READ_EVIDENCE\n';

export async function modelOverridesFixture(port = 0) {
  const pending = [],
    records = [],
    releases = [];
  let failure;
  const server = createServer(async (request, response) => {
    try {
      const expected = pending.shift();
      assert(expected, 'unplanned HTTP request (including unexpected compaction/discovery)');
      assert.equal(request.method, 'POST');
      assert.equal(request.url, expected.path);
      assert.equal(request.headers.authorization, 'Bearer ' + secret);
      const chunks = [];
      let length = 0;
      for await (const chunk of request) {
        length += chunk.length;
        assert(length <= 128 * 1024);
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(input.model, expected.model);
      records.push({ path: request.url, input });
      if (expected.probe) {
        assert.equal(input.stream, undefined);
        assert.deepEqual(input, {
          model: expected.model,
          ...(expected.path.endsWith('/responses')
            ? { store: false, max_output_tokens: 16, input: [{ role: 'user', content: 'Hi' }] }
            : { max_tokens: 16, messages: [{ role: 'user', content: 'Hi' }] }),
        });
      } else {
        assert.equal(input.stream, true);
        assert.equal(input.parallel_tool_calls, expected.parallel);
        assert(
          JSON.stringify(input).includes(expected.marker),
          'HTTP request must contain the expected user anchor',
        );
        assert(input.tools?.length, 'ordinary invocation must not become a summary request');
        assert.deepEqual(
          [input.max_output_tokens, input.max_completion_tokens, input.max_tokens].filter(
            (value) => value !== undefined,
          ),
          expected.outputLimit === undefined ? [] : [expected.outputLimit],
          'every request has its resolved finite reply budget',
        );
        if (expected.toolEvidence)
          assert(
            JSON.stringify(input).includes('MODEL_FACTS_FROZEN_READ_EVIDENCE'),
            'next route must replay the real committed Read result',
          );
        if (expected.toolResult) {
          const responses = expected.path.endsWith('/responses');
          const result = responses
            ? input.input.findLast((message) => message.type === 'function_call_output')
            : input.messages.findLast((message) => message.role === 'tool');
          assert.equal(responses ? result.call_id : result.tool_call_id, 'facts-read');
          assert.deepEqual(
            JSON.parse(responses ? result.output : result.content),
            readPage(evidence, { path: 'facts-evidence.txt' }),
          );
        }
      }
      expected.arrive();
      if (expected.hold) await expected.gate;
      if (expected.probe) {
        response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
        response.end('{}');
      } else if (expected.path.endsWith('/chat/completions')) {
        const frame = (delta, finish_reason = null, usage) =>
          'data: ' +
          JSON.stringify({
            id: 'facts-chat-' + records.length,
            object: 'chat.completion.chunk',
            created: 1,
            model: input.model,
            choices: [{ index: 0, delta, finish_reason }],
            ...(usage ? { usage } : {}),
          }) +
          '\n\n';
        const delta = expected.read
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: 'facts-read',
                  type: 'function',
                  function: {
                    name: 'Read',
                    arguments: JSON.stringify({ path: 'facts-evidence.txt' }),
                  },
                },
              ],
            }
          : { content: expected.answer };
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        if (expected.streamHold) {
          response.write(frame({ content: expected.answer.slice(0, 4) }));
          await expected.gate;
          delta.content = expected.answer.slice(4);
        }
        response.end(
          frame(delta) +
            frame({}, expected.read ? 'tool_calls' : 'stop', {
              prompt_tokens: expected.tokens ?? 42,
              completion_tokens: 1,
              total_tokens: (expected.tokens ?? 42) + 1,
            }) +
            'data: [DONE]\n\n',
        );
      } else {
        const id = 'facts-response-' + records.length,
          text = expected.answer;
        const item = {
          type: 'message',
          id: id + '-message',
          role: 'assistant',
          content: [{ type: 'output_text', text, annotations: [] }],
        };
        const events = [
          { type: 'response.created', response: { id, created_at: 1, model: input.model } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          {
            type: 'response.output_text.delta',
            item_id: item.id,
            output_index: 0,
            content_index: 0,
            delta: text,
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id,
              output: [item],
              usage: { input_tokens: expected.tokens ?? 43, output_tokens: 1 },
            },
          },
        ];
        response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
        response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
      }
    } catch (error) {
      failure = error;
      response.destroy(error);
    }
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    records,
    expect(value) {
      let arrive, release;
      const arrived = new Promise((resolve) => {
        arrive = resolve;
      });
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      releases.push(release);
      pending.push({ ...value, arrive, gate });
      return {
        release,
        wait: async () => {
          await Promise.race([
            arrived,
            delay(10000, undefined, { ref: false }).then(() => {
              if (failure) throw failure;
              throw new Error('Expected model facts HTTP request did not arrive');
            }),
          ]);
          if (failure) throw failure;
        },
      };
    },
    check() {
      if (failure) throw failure;
    },
    verify() {
      this.check();
      assert.equal(pending.length, 0, 'every expected HTTP request must actually execute');
    },
    async close() {
      for (const release of releases) release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
