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
import { test } from 'node:test';
import type { ZodType } from 'zod';
import {
  buildWebFetchTool,
  routeWebFetchTools,
  WEB_FETCH_MODEL_OUTPUT_MAX_BYTES,
} from '../web-fetch-tool.js';
import type { MakaToolContext } from '../tool-runtime.js';

test('WebFetch forwards the canonical URL to its executor', async () => {
  let received: { url: string; sessionId: string; abortSignal?: AbortSignal } | undefined;
  const tool = buildWebFetchTool({
    fetch: async (input) => {
      received = input;
      return { content: 'page body', finalUrl: 'https://cdn.example/final' };
    },
  });
  const abort = new AbortController();

  const result = await tool.impl({ url: 'https://example.com/a/../page' }, context(abort.signal));

  assert.deepEqual(result, {
    kind: 'text',
    text: 'page body',
    sourceUrl: 'https://cdn.example/final',
  });
  assert.deepEqual(received, {
    url: 'https://example.com/page',
    sessionId: 'session-1',
    abortSignal: abort.signal,
  });
  assert.deepEqual(tool.toModelOutput!({ toolCallId: 'fetch', input: {}, output: result }), {
    type: 'text',
    value: 'page body',
  });
});

test('WebFetch accepts only an HTTP or HTTPS url argument', () => {
  const tool = buildWebFetchTool({
    fetch: async () => ({ content: 'unused', finalUrl: 'https://example.com/' }),
  });
  const parameters = tool.parameters as ZodType;

  assert.deepEqual(parameters.parse({ url: 'https://example.com/page' }), {
    url: 'https://example.com/page',
  });
  assert.throws(() => parameters.parse({ url: 'file:///tmp/secret' }));
  assert.throws(() => parameters.parse({ url: 'https://example.com', maxBytes: 1 }));
});

test('WebFetch bounds model output with a head-truncation marker', async () => {
  const tool = buildWebFetchTool({
    fetch: async () => ({
      content: `begin:${'x'.repeat(60 * 1024)}:end`,
      finalUrl: 'https://example.com/large',
    }),
  });

  const result = await tool.impl(
    { url: 'https://example.com/large' },
    context(new AbortController().signal),
  );

  assert.equal(result.truncated, true);
  assert.match(result.text, /^begin:/);
  assert.doesNotMatch(result.text, /:end$|WebFetch content truncated/);
  const model = tool.toModelOutput!({ toolCallId: 'fetch', input: {}, output: result });
  assert.equal(model.type, 'text');
  if (model.type !== 'text') throw new Error('Expected text projection');
  assert.match(model.value, /WebFetch content truncated/);
  assert.ok(Buffer.byteLength(model.value, 'utf8') <= WEB_FETCH_MODEL_OUTPUT_MAX_BYTES);
});

test('privacy mode removes WebFetch from a turn', () => {
  const webFetch = buildWebFetchTool({
    fetch: async () => ({ content: 'unused', finalUrl: 'https://example.com/' }),
  });
  const other = { ...webFetch, name: 'Read' };

  assert.deepEqual(
    routeWebFetchTools([other, webFetch], { incognitoActive: true }).map((tool) => tool.name),
    ['Read'],
  );
  assert.deepEqual(
    routeWebFetchTools([other, webFetch], { incognitoActive: false }).map((tool) => tool.name),
    ['Read', 'WebFetch'],
  );
});

function context(abortSignal: AbortSignal): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tool-1',
    abortSignal,
    emitOutput: () => {},
  };
}
