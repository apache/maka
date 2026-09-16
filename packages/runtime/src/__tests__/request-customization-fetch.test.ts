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
import { describe, test } from 'node:test';
import { createRequestCustomizationFetch } from '../request-customization-fetch.js';

describe('createRequestCustomizationFetch', () => {
  test('preserves caller cancellation, including signal override and explicit null', async () => {
    for (const selection of ['inherited', 'override', 'null'] as const) {
      const original = new AbortController();
      const override = new AbortController();
      const request = new Request('https://example.test/', { signal: original.signal });
      let forwarded: AbortSignal | null | undefined;
      const fetch = createRequestCustomizationFetch(
        async (_input, init) => {
          forwarded = init?.signal;
          return new Response();
        },
        { headers: { 'x-test': 'abort' } },
      );
      await fetch(
        request,
        selection === 'inherited'
          ? undefined
          : {
              signal: selection === 'override' ? override.signal : null,
            },
      );
      original.abort(new Error('original abort'));
      if (selection === 'null') assert.equal(forwarded, null);
      else if (selection === 'inherited') assert.equal(forwarded?.reason, original.signal.reason);
      else {
        assert.equal(forwarded?.aborted, false);
        override.abort(new Error('override abort'));
        assert.equal(forwarded?.reason, override.signal.reason);
      }
    }
  });

  test('native response still aborts after temporary customization Requests are collected', () => {
    const child = spawnSync(
      process.execPath,
      [
        '--expose-gc',
        '--input-type=module',
        '--eval',
        `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { setImmediate } from 'node:timers/promises';
      import { createRequestCustomizationFetch } from ${JSON.stringify(new URL('../request-customization-fetch.js', import.meta.url).href)};
      const server = createServer(async (req, res) => {
        for await (const chunk of req) {}
        res.writeHead(200);
        res.write('first');
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      try {
        const controller = new AbortController();
        const fetch = createRequestCustomizationFetch(globalThis.fetch, { bodyOverlay: { extra: true } });
        const response = await fetch('http://127.0.0.1:' + server.address().port, {
          method: 'POST', body: '{}', signal: controller.signal,
        });
        const reader = response.body.getReader();
        assert.equal((await reader.read()).done, false);
        // Collection exposes native Request's weak abort forwarding; no heap-size assertion.
        for (let i = 0; i < 8; i++) { await setImmediate(); global.gc(); }
        controller.abort();
        let timer;
        try {
          const result = await Promise.race([
            reader.read().then(() => 'resolved', error => error.name),
            new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), 2000); }),
          ]);
          assert.equal(result, 'AbortError');
        } finally { clearTimeout(timer); }
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `,
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr || child.stdout);
  });

  test('applies generic headers and extra fields to a JSON POST request', async () => {
    const requests: Request[] = [];
    const fetch = createRequestCustomizationFetch(
      async (input, init) => {
        requests.push(new Request(input, init));
        return new Response('{}', { status: 200 });
      },
      {
        headers: { 'HTTP-Referer': 'https://maka.example', 'X-Title': 'Maka' },
        bodyOverlay: { provider: { order: ['Anthropic'], allow_fallbacks: false } },
      },
    );

    await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'example/model', messages: [] }),
    });

    const request = requests[0];
    assert.ok(request);
    assert.equal(request.headers.get('http-referer'), 'https://maka.example');
    assert.equal(request.headers.get('x-title'), 'Maka');
    assert.deepEqual(await request.json(), {
      model: 'example/model',
      messages: [],
      provider: { order: ['Anthropic'], allow_fallbacks: false },
    });
  });

  test('adds headers to model discovery without adding a body', async () => {
    let captured: Request | undefined;
    const fetch = createRequestCustomizationFetch(
      async (input, init) => {
        captured = new Request(input, init);
        return new Response('{}', { status: 200 });
      },
      { headers: { 'X-Tenant': 'tenant-a' }, bodyOverlay: { provider: { sort: 'price' } } },
    );

    await fetch('https://openrouter.ai/api/v1/models');

    assert.equal(captured?.headers.get('x-tenant'), 'tenant-a');
    assert.equal(captured?.body, null);
  });

  test('passes URL and init across fetch implementations instead of a realm-specific Request', async () => {
    let captured: Request | undefined;
    const fetch = createRequestCustomizationFetch(
      async (input, init) => {
        assert.equal(typeof input, 'string');
        captured = new Request(input, init);
        return new Response('{}', { status: 200 });
      },
      { bodyOverlay: { provider: { only: ['deepseek'] } } },
    );

    await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'example/model' }),
    });

    assert.deepEqual(await captured?.json(), {
      model: 'example/model',
      provider: { only: ['deepseek'] },
    });
  });

  test('rejects collisions instead of silently overriding generated request data', async () => {
    const fetch = createRequestCustomizationFetch(async () => new Response('{}', { status: 200 }), {
      headers: { 'X-Tenant': 'custom' },
      bodyOverlay: { model: 'other/model' },
    });

    await assert.rejects(
      fetch('https://example.test/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tenant': 'generated' },
        body: JSON.stringify({ model: 'generated/model' }),
      }),
      /Custom request header conflicts/,
    );

    const bodyOnly = createRequestCustomizationFetch(
      async () => new Response('{}', { status: 200 }),
      { bodyOverlay: { model: 'other/model' } },
    );
    await assert.rejects(
      bodyOnly('https://example.test/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'generated/model' }),
      }),
      /Extra request body conflicts/,
    );
  });

  test('applies a provider finalizer after caller body overlays', async () => {
    let captured: Request | undefined;
    const fetch = createRequestCustomizationFetch(
      async (input, init) => {
        captured = new Request(input, init);
        return Response.json({ ok: true });
      },
      {
        bodyOverlay: { store: true },
        finalizeBody: (body) => ({ ...body, store: false }),
      },
    );

    await fetch('https://provider.invalid/responses', {
      method: 'POST',
      headers: { 'content-length': '999', 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'qwen3.8-max' })).buffer,
    });

    assert.deepEqual(await captured?.json(), { model: 'qwen3.8-max', store: false });
    assert.equal(captured?.headers.get('content-length'), null);
    await assert.rejects(
      fetch('https://provider.invalid/responses', { method: 'POST', body: 'not-json' }),
      /finalizer requires a JSON object request body/,
    );
  });
});
