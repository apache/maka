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
      return 'page body';
    },
  });
  const abort = new AbortController();

  const result = await tool.impl({ url: 'https://example.com/a/../page' }, context(abort.signal));

  assert.equal(result, 'page body');
  assert.deepEqual(received, {
    url: 'https://example.com/page',
    sessionId: 'session-1',
    abortSignal: abort.signal,
  });
});

test('WebFetch accepts only an HTTP or HTTPS url argument', () => {
  const tool = buildWebFetchTool({ fetch: async () => 'unused' });
  const parameters = tool.parameters as ZodType;

  assert.deepEqual(parameters.parse({ url: 'https://example.com/page' }), {
    url: 'https://example.com/page',
  });
  assert.throws(() => parameters.parse({ url: 'file:///tmp/secret' }));
  assert.throws(() => parameters.parse({ url: 'https://example.com', maxBytes: 1 }));
});

test('WebFetch bounds model output with a head-truncation marker', async () => {
  const tool = buildWebFetchTool({ fetch: async () => `begin:${'x'.repeat(60 * 1024)}:end` });

  const result = await tool.impl(
    { url: 'https://example.com/large' },
    context(new AbortController().signal),
  );

  assert.ok(typeof result === 'string');
  assert.match(result, /^begin:/);
  assert.doesNotMatch(result, /:end$/);
  assert.match(result, /WebFetch content truncated/);
  assert.ok(Buffer.byteLength(result, 'utf8') <= WEB_FETCH_MODEL_OUTPUT_MAX_BYTES);
});

test('privacy mode removes WebFetch from a turn', () => {
  const webFetch = buildWebFetchTool({ fetch: async () => 'unused' });
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
