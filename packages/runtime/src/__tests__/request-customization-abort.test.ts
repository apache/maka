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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  createRequestCustomizationFetch,
  type RequestCustomization,
} from '../request-customization-fetch.js';

const customizations: RequestCustomization[] = [
  { headers: { 'x-test': 'abort' } },
  { bodyOverlay: { extra: true } },
  { finalizeBody: (body) => ({ ...body, finalized: true }) },
];

test('customization preserves the effective signal and abort reason across body paths', async () => {
  for (const customization of customizations) {
    const contentTypes = customization.finalizeBody
      ? ['application/json']
      : ['application/json', 'text/plain'];
    for (const contentType of contentTypes) {
      for (const selection of ['inherited', 'undefined', 'override', 'null'] as const) {
        const original = new AbortController();
        const override = new AbortController();
        const input = new Request('https://example.test/request', {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: '{}',
          signal: original.signal,
        });
        const init =
          selection === 'inherited'
            ? undefined
            : {
                signal:
                  selection === 'override'
                    ? override.signal
                    : selection === 'null'
                      ? null
                      : undefined,
              };
        const expected =
          selection === 'override' ? override.signal : selection === 'null' ? null : input.signal;
        let forwarded: AbortSignal | null | undefined;
        const wrapped = createRequestCustomizationFetch(async (_input, nextInit) => {
          forwarded = nextInit?.signal;
          assert.equal(forwarded, expected);
          return new Response();
        }, customization);
        await wrapped(input, init);
        const originalReason = new Error('original abort');
        original.abort(originalReason);
        if (selection === 'override') {
          assert.equal(forwarded?.aborted, false);
          const overrideReason = new Error('override abort');
          override.abort(overrideReason);
          assert.equal(forwarded?.reason, overrideReason);
        } else if (selection !== 'null') {
          assert.equal(forwarded?.aborted, true);
          assert.equal(forwarded?.reason, originalReason);
        } else {
          assert.equal(forwarded, null);
        }
      }
    }
  }
});

test('URL and string inputs preserve absent, null and already-aborted signals', async () => {
  const controller = new AbortController();
  const reason = new Error('already aborted');
  controller.abort(reason);
  for (const input of ['https://example.test/request', new URL('https://example.test/request')]) {
    for (const signal of [undefined, null, controller.signal]) {
      const wrapped = createRequestCustomizationFetch(
        async (_input, init) => {
          assert.equal(init?.signal, signal);
          if (signal) {
            assert.equal(init?.signal?.aborted, true);
            assert.equal(init?.signal?.reason, reason);
            init?.signal?.throwIfAborted();
          }
          return new Response();
        },
        { headers: { 'x-test': 'abort' } },
      );
      if (signal) await assert.rejects(wrapped(input, { signal }), (error) => error === reason);
      else await wrapped(input, { signal });
    }
  }
  assert.equal(createRequestCustomizationFetch(globalThis.fetch, {}), globalThis.fetch);
});

test('native HTTP abort closes the response after temporary customization Requests are collected', () => {
  const moduleUrl = new URL('../request-customization-fetch.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import http from 'node:http';
    import { setTimeout as delay } from 'node:timers/promises';
    import { createRequestCustomizationFetch } from ${JSON.stringify(moduleUrl)};

    for (const variant of ['headers', 'non-json', 'overlay', 'finalize', 'held-request']) {
      let closed;
      const responseClosed = new Promise(resolve => { closed = resolve; });
      const server = http.createServer(async (req, res) => {
        for await (const chunk of req) {}
        res.writeHead(200);
        res.write('first');
        // Even a broken implementation terminates without leaving a hanging server.
        const deadline = setTimeout(() => res.end('deadline'), 3000);
        res.on('close', () => { clearTimeout(deadline); closed(); });
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const controller = new AbortController();
      let reader;
      try {
        const url = 'http://127.0.0.1:' + server.address().port;
        const init = {
          method: 'POST',
          headers: { 'content-type': variant === 'non-json' ? 'text/plain' : 'application/json' },
          body: '{}',
          signal: controller.signal,
        };
        const customization = variant === 'overlay' || variant === 'non-json'
          ? { bodyOverlay: { extra: true } }
          : variant === 'finalize'
            ? { finalizeBody: body => ({ ...body, finalized: true }) }
            : { headers: { 'x-test': 'abort' } };
        const wrapped = createRequestCustomizationFetch(globalThis.fetch, customization);
        const heldRequest = variant === 'held-request' ? new Request(url, init) : undefined;
        const response = await (heldRequest
          ? wrapped(heldRequest)
          : wrapped(variant === 'overlay' ? new URL(url) : url, init));
        reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        for (let cycle = 0; cycle < 8; cycle++) {
          await delay(10);
          global.gc();
        }
        controller.abort();
        const outcome = await Promise.race([
          reader.read().then(() => 'resolved', error => error.name),
          delay(500, 'timeout'),
        ]);
        assert.equal(outcome, 'AbortError', variant + ': body must abort before server deadline');
        assert.equal(await Promise.race([
          responseClosed.then(() => true), delay(500, false),
        ]), true, variant + ': server response must close promptly');
        // Preserve caller-owned Request lifetime, as required by native Request semantics.
        if (heldRequest) assert.equal(heldRequest.signal.aborted, true);
      } finally {
        if (reader) {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    }
  `,
    ],
    { encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(child.error, undefined, child.error?.message ?? 'child process failed');
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
