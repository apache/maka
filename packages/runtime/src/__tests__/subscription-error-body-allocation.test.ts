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
import { it } from 'node:test';
import { buildSubscriptionModelFetch } from '../subscription-model-fetch.js';

it('consumes discarded OAuth errors without teeing their bodies and leaves success readable', async () => {
  const jsonError = JSON.stringify({
    error: { code: 'invalid_token', message: 'X'.repeat(1024 * 1024) },
  });
  const htmlError = '<!doctype html><title>Rejected</title>' + 'Y'.repeat(1024 * 1024);
  const attempts = new Map<string, number>();
  const observed: Response[] = [];
  const requestBodies: string[] = [];
  let clones = 0;
  let refreshes = 0;
  const usedAtRefresh: boolean[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? '';
    const count = (attempts.get(path) ?? 0) + 1;
    attempts.set(path, count);
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requestBodies.push(Buffer.concat(chunks).toString());
      if (path === '/edge' && count === 1) {
        response.writeHead(403, { 'content-type': 'text/html', 'retry-after': '0' });
        response.end(htmlError);
      } else if (path === '/auth' || path === '/failure') {
        response.writeHead(path === '/auth' ? 401 : 500, {
          'content-type': 'application/json',
          'x-request-id': 'fixture-request',
        });
        response.end(jsonError);
      } else {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end('data: complete\n\n');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const fetchModel = buildSubscriptionModelFetch({
    connection: { slug: 'fixture', providerType: 'openai-codex', defaultModel: 'fixture' },
    sessionId: 'fixture-session',
    modelId: 'fixture',
    fetchFn: async (...args) => {
      const response = await fetch(...args);
      const clone = response.clone.bind(response);
      response.clone = () => {
        clones++;
        return clone();
      };
      observed.push(response);
      return response;
    },
    refreshOAuthAccessToken: async () => {
      refreshes++;
      usedAtRefresh.push(observed.at(-1)?.bodyUsed ?? false);
      return null;
    },
  });
  assert.ok(fetchModel);
  try {
    for (const [path, status] of [
      ['auth', 401],
      ['failure', 500],
    ] as const) {
      await assert.rejects(
        fetchModel('http://127.0.0.1:' + address.port + '/' + path, {
          method: 'POST',
          body: JSON.stringify({ input: [] }),
        }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.equal(
            error.message,
            'Codex OAuth request failed: HTTP ' + status + ' ' + jsonError.slice(0, 240),
          );
          assert.deepEqual(Object.assign({}, error), {
            name: 'OpenAiCodexHttpError',
            statusCode: status,
            data: { error: { code: 'invalid_token' } },
            responseHeaders: { 'x-request-id': 'fixture-request' },
          });
          return true;
        },
      );
    }
    const success = await fetchModel('http://127.0.0.1:' + address.port + '/edge', {
      method: 'POST',
      body: JSON.stringify({ input: [] }),
    });
    assert.equal(success.status, 200);
    assert.equal(success.bodyUsed, false);
    assert.equal(await success.text(), 'data: complete\n\n');
    assert.equal(attempts.get('/auth'), 1);
    assert.equal(attempts.get('/failure'), 1);
    assert.equal(attempts.get('/edge'), 2);
    assert.equal(refreshes, 1);
    assert.equal(new Set(requestBodies).size, 1);
    const request = JSON.parse(requestBodies[0] ?? '');
    assert.deepEqual(request.input, []);
    assert.equal(request.store, false);

    // Assert resource ownership only after wire/error/retry semantics passed.
    assert.deepEqual(usedAtRefresh, [true]);
    assert.ok(observed.filter((response) => !response.ok).every((response) => response.bodyUsed));
    assert.equal(clones, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
