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
import { queryTavily } from '../tavily-search.js';

test('Tavily search sends one bounded request and projects only safe rows', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const result = await queryTavily({
    apiKey: 'tavily-secret',
    query: ' current results ',
    limit: 2,
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({
        results: [
          {
            title: 'A'.repeat(300),
            url: 'https://one.example/article',
            content: 'S'.repeat(500),
          },
          { title: 'unsafe', url: 'file:///private/result', content: 'discarded' },
          {
            title: 'credential URL',
            url: 'https://user:password@example.com',
            content: 'discarded',
          },
          { title: 'malformed', url: 'https://[invalid', content: 'discarded' },
          {
            title: 'oversized after normalization',
            url: `https://unicode.example/${'汉'.repeat(2_000)}`,
            content: 'discarded',
          },
          { title: 'Second', url: 'http://two.example/result', content: 'two' },
          { title: 'Third', url: 'https://three.example/result', content: 'three' },
        ],
      });
    },
  });

  assert.deepEqual(requestBody, {
    api_key: 'tavily-secret',
    query: 'current results',
    max_results: 2,
    search_depth: 'basic',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.results.length, 2);
  assert.equal(result.results[0]?.title.length, 240);
  assert.equal(result.results[0]?.snippet.length, 400);
  assert.equal(result.results[0]?.source, 'one.example');
  assert.equal(result.results[1]?.source, 'two.example');
  assert.doesNotMatch(JSON.stringify(result), /tavily-secret/);
});

test('Tavily search fails closed over oversized or invalid provider responses', async () => {
  for (const body of [
    JSON.stringify({ results: [{ content: 'x'.repeat(256) }] }),
    JSON.stringify({ answer: 'unexpected response shape' }),
    'not-json',
  ]) {
    const result = await queryTavily({
      apiKey: 'tavily-secret',
      query: 'bounded response',
      limit: 5,
      responseMaxBytes: 64,
      fetch: async () => new Response(body, { status: 200 }),
    });
    assert.deepEqual(result, {
      ok: false,
      reason: 'network_error',
      message: 'The Tavily request failed.',
    });
  }
});

test('Tavily search distinguishes its timeout from caller cancellation', async () => {
  const waitForAbort: typeof fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      assert.ok(signal);
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  const timedOut = await queryTavily({
    apiKey: 'tavily-secret',
    query: 'slow search',
    limit: 5,
    timeoutMs: 5,
    fetch: waitForAbort,
  });
  assert.equal(timedOut.ok, false);
  if (!timedOut.ok) assert.equal(timedOut.reason, 'timeout');

  const abort = new AbortController();
  const cancelled = queryTavily({
    apiKey: 'tavily-secret',
    query: 'cancelled search',
    limit: 5,
    abortSignal: abort.signal,
    fetch: waitForAbort,
  });
  const reason = new DOMException('Parent turn stopped', 'AbortError');
  abort.abort(reason);
  await assert.rejects(cancelled, (error) => error === reason);
});
