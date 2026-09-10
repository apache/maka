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
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createDefaultRuntimePolicy } from '@maka/core/runtime-policy';
import { buildWebFetchTool, WEB_FETCH_MODEL_OUTPUT_MAX_BYTES } from '@maka/runtime/web-fetch-tool';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { createHostWebFetchTool } from '../server/web-fetch-tool.js';

const marker = '\n\n…[WebFetch content truncated to fit the 50 KB model-output limit]';
const budget = WEB_FETCH_MODEL_OUTPUT_MAX_BYTES - Buffer.byteLength(marker);
const context: MakaToolContext = {
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  cwd: process.cwd(),
  abortSignal: new AbortController().signal,
  emitOutput: () => {},
};

function reference(content: string): string {
  if (Buffer.byteLength(content) <= WEB_FETCH_MODEL_OUTPUT_MAX_BYTES) return content;
  return Buffer.from(content).subarray(0, budget).toString().replace(/�+$/, '') + marker;
}

test('Host WebFetch encodes only the bounded model prefix after a real HTTP read', async () => {
  let body = '';
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount++;
    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/body`;
  const originalFrom = Buffer.from;
  let maxEncodingBytes = 0;
  let encoderCalls = 0;
  Buffer.from = ((...args: unknown[]) => {
    const result = Reflect.apply(originalFrom, Buffer, args);
    const caller = (new Error().stack ?? '').split('\n')[2] ?? '';
    if (caller.includes('truncateWebFetchOutput') && caller.includes('/web-fetch-tool.js:')) {
      encoderCalls++;
      maxEncodingBytes = Math.max(maxEncodingBytes, result.length);
    }
    return result;
  }) as typeof Buffer.from;
  try {
    const tool = createHostWebFetchTool({
      policy: {
        resolveHostOutboundExecution: async () => ({
          kind: 'ready',
          networkProxy: createDefaultRuntimePolicy().networkProxy,
          secretMaterial: {},
        }),
      },
    });
    for (const text of ['short response', 'x'.repeat(1024 * 1024), '界🦊'.repeat(300000)]) {
      body = text;
      assert.equal(await tool.impl({ url }, context), reference(text));
    }
    assert.equal(requestCount, 3);
    // Isolate UTF-16 boundary behavior that an HTTP UTF-8 round trip would normalize.
    const directTool = buildWebFetchTool({ fetch: async () => body });
    for (const boundary of ['界', '🦊', '\ud800', '\udc00', '�', 'e\u0301']) {
      for (const offset of [-3, -2, -1, 0, 1, 2, 3]) {
        body = 'x'.repeat(budget + offset) + boundary.repeat(50) + 'tail';
        assert.equal(await directTool.impl({ url }, context), reference(body));
      }
    }
    for (const bytes of [
      WEB_FETCH_MODEL_OUTPUT_MAX_BYTES - 1,
      WEB_FETCH_MODEL_OUTPUT_MAX_BYTES,
      WEB_FETCH_MODEL_OUTPUT_MAX_BYTES + 1,
    ]) {
      body = 'x'.repeat(bytes);
      assert.equal(await directTool.impl({ url }, context), reference(body));
    }
    const privateTool = createHostWebFetchTool({
      policy: { resolveHostOutboundExecution: async () => ({ kind: 'privacy_mode' }) },
    });
    await assert.rejects(async () => privateTool.impl({ url }, context), /privacy mode/);
    assert.equal(requestCount, 3, 'privacy refusal must not create an HTTP request');
    assert.ok(encoderCalls > 0, 'observe the actual model-output encoder');
    assert.ok(
      maxEncodingBytes <= 3 * (budget + 1),
      `model-prefix encoder allocated ${maxEncodingBytes} bytes`,
    );
  } finally {
    Buffer.from = originalFrom;
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
