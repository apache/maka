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

export const anchor = 'AUTO_ORIGINAL_ANCHOR: Read evidence.txt, then report completion.';
export const evidence = 'AUTO_OLD_TOOL_EVIDENCE: the requested file was read completely.\n';
export const summary = [
  '## Goal',
  'AUTO_SUMMARY_PRIVATE: Report completion after reading the workspace evidence.',
  '## Progress',
  'The file read has settled successfully and its complete tool step is durable.',
  '## Next Steps',
  'Answer the original user request without repeating the completed file operation.',
  '## Critical Context',
  'The authorized evidence.txt path has already been read. No tool call remains pending.',
].join('\n');

function gate() {
  let arrive, release;
  return {
    arrived: new Promise((resolve) => {
      arrive = resolve;
    }),
    released: new Promise((resolve) => {
      release = resolve;
    }),
    arrive: () => arrive(),
    release: () => release(),
  };
}
export async function autoContextFixture(port = 0, reopened = false) {
  const summaryGate = gate(),
    mainGate = gate();
  let count = 0,
    failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer auto-context-fixture');
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= 128 * 1024);
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const step = ++count;
      assert(step <= (reopened ? 1 : 3), 'auto compaction must not loop');
      assert.equal(input.model, 'fixture-model');
      assert.equal(input.stream, true);
      assert(
        input.messages.some((message) => message.role === 'user' && message.content === anchor),
      );
      const isSummary = !reopened && step === 2;
      const isRead = !reopened && step === 1;
      if (isSummary) {
        assert(!input.tools?.length);
        assert.equal(input.messages.at(-1).role, 'user');
        assert(/summar|compact/i.test(JSON.stringify(input.messages.at(-1).content)));
        const tool = input.messages.findLast((message) => message.role === 'tool');
        assert.equal(tool.tool_call_id, 'auto-read');
        assert.deepEqual(JSON.parse(tool.content), readPage(evidence, { path: 'evidence.txt' }));
      } else {
        assert(input.tools.some((tool) => tool.function.name === 'Read'));
        if (!isRead) {
          const serialized = JSON.stringify(input.messages);
          assert(serialized.includes(JSON.stringify(summary).slice(1, -1)));
          assert(!serialized.includes('AUTO_OLD_TOOL_EVIDENCE'));
          assert(
            !input.messages.some(
              (message) => message.role === 'tool' || message.tool_calls?.length,
            ),
          );
          assert.equal(input.messages.filter((message) => message.content === anchor).length, 1);
        }
      }
      const frame = (delta, finish_reason = null) =>
        'data: ' +
        JSON.stringify({
          id: 'auto-context-' + step,
          object: 'chat.completion.chunk',
          created: 1,
          model: input.model,
          choices: [{ index: 0, delta, finish_reason }],
        }) +
        '\n\n';
      response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'close' });
      if (isSummary) {
        response.write(frame({ content: summary }));
        summaryGate.arrive();
        await summaryGate.released;
      } else if (!isRead && !reopened) {
        mainGate.arrive();
        await mainGate.released;
      }
      const content = isRead
        ? frame({
            tool_calls: [
              {
                index: 0,
                id: 'auto-read',
                type: 'function',
                function: { name: 'Read', arguments: JSON.stringify({ path: 'evidence.txt' }) },
              },
            ],
          })
        : isSummary
          ? ''
          : frame({ content: 'automatic context complete' });
      const [prompt, completion, cached] = isRead
        ? [828390, 10, 7]
        : isSummary
          ? [999, 200, 99]
          : reopened
            ? [14, 2, 4]
            : [12, 2, 3];
      const usage =
        'data: ' +
        JSON.stringify({
          id: 'auto-context-' + step,
          object: 'chat.completion.chunk',
          created: 1,
          model: input.model,
          choices: [],
          usage: {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
            prompt_tokens_details: { cached_tokens: cached },
          },
        }) +
        '\n\n';
      response.end(
        content + frame({}, isRead ? 'tool_calls' : 'stop') + usage + 'data: [DONE]\n\n',
      );
    } catch (error) {
      failure = error;
      response.destroy(error);
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    releaseSummary: summaryGate.release,
    releaseMain: mainGate.release,
    async waitFor(stage) {
      await Promise.race([
        (stage === 'summary' ? summaryGate : mainGate).arrived,
        delay(10000, undefined, { ref: false }).then(() => {
          this.check();
          throw new Error('Provider did not reach ' + stage);
        }),
      ]);
      this.check();
    },
    check() {
      if (failure) throw failure;
    },
    verify() {
      this.check();
      assert.equal(count, reopened ? 1 : 3);
    },
    async close() {
      summaryGate.release();
      mainGate.release();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
