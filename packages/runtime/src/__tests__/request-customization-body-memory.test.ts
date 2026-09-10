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

const url = 'https://example.test/body';
const jsonHeaders = { 'content-type': 'application/json' };
const bytes = (text: string) => new TextEncoder().encode(text);
const overlay = { bodyOverlay: { extra: true } };
function stream(chunks: Uint8Array[], error?: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (error) controller.error(error);
      else controller.close();
    },
  });
}
function streamed(body: ReadableStream<Uint8Array>): RequestInit {
  return { method: 'POST', headers: jsonHeaders, body, duplex: 'half' } as RequestInit;
}

test('buffer decoding preserves UTF-8, JSON and input override semantics', async () => {
  const cases: [string, () => BodyInit, unknown][] = [
    ['object', () => '{"value":1}', 1],
    ['BOM', () => new Uint8Array([239, 187, 191, ...bytes('{"value":1}')]), 1],
    ['invalid UTF-8', () => new Uint8Array([...bytes('{"value":"'), 255, ...bytes('"}')]), '�'],
    ['literal surrogate', () => '{"value":"\ud800"}', '�'],
    ['escaped surrogate', () => '{"value":"\\ud800"}', '\ud800'],
    [
      'split BOM',
      () => stream([new Uint8Array([239]), new Uint8Array([187, 191]), bytes('{"value":1}')]),
      1,
    ],
    [
      'split UTF-8',
      () =>
        stream([
          bytes('{"value":"'),
          new Uint8Array([240, 159]),
          new Uint8Array([152, 128]),
          bytes('"}'),
        ]),
      '😀',
    ],
  ];
  for (const [name, makeBody, expected] of cases) {
    for (const kind of ['string', 'URL', 'Request', 'override']) {
      const init = {
        method: 'POST',
        headers: jsonHeaders,
        body: makeBody(),
        duplex: 'half',
      } as RequestInit;
      const original = new Request(url, { ...init, body: '{"original":true}' });
      const input =
        kind === 'Request'
          ? new Request(url, init)
          : kind === 'override'
            ? original
            : kind === 'URL'
              ? new URL(url)
              : url;
      let calls = 0;
      const wrapped = createRequestCustomizationFetch(async (nextUrl, nextInit) => {
        calls++;
        assert.equal(nextUrl, url);
        assert.deepEqual(
          await new Response(nextInit?.body).json(),
          { value: expected, extra: true },
          `${name}/${kind}`,
        );
        return new Response();
      }, overlay);
      await wrapped(input, kind === 'Request' ? undefined : init);
      assert.equal(calls, 1);
      if (kind === 'override') {
        assert.equal(original.bodyUsed, false);
        assert.equal(original.body?.locked, false);
        assert.deepEqual(await original.json(), { original: true });
      } else if (input instanceof Request) {
        assert.equal(input.bodyUsed, true);
        assert.equal(input.body?.locked, false);
      }
    }
  }
});
test('invalid objects, conflicts and finalizer failures retain their errors', async () => {
  for (const customization of [
    overlay,
    { finalizeBody: (body: Record<string, unknown>) => body },
  ]) {
    const wrapped = createRequestCustomizationFetch(
      async () => assert.fail('must not send'),
      customization,
    );
    for (const body of ['null', '[]', '1', '"text"', '{invalid', '']) {
      await assert.rejects(
        wrapped(url, { method: 'POST', headers: jsonHeaders, body }),
        /JSON object request/,
      );
    }
  }
  const failure = new Error('provider finalizer failed');
  const cases: [RequestCustomization, RequestInit, RegExp | Error][] = [
    [overlay, { body: '{"extra":false}' }, /conflicts with a generated field: extra/],
    [
      { headers: { 'x-custom': 'custom' } },
      { headers: { 'x-custom': 'generated' } },
      /header conflicts/,
    ],
    [
      {
        finalizeBody: () => {
          throw failure;
        },
      },
      { body: '{}' },
      failure,
    ],
    [
      { finalizeBody: (body) => body },
      { body: '{}', headers: { 'content-type': 'text/plain' } },
      /finalizer requires/,
    ],
  ];
  for (const [customization, init, expected] of cases) {
    const wrapped = createRequestCustomizationFetch(
      async () => assert.fail('must not send'),
      customization,
    );
    await assert.rejects(
      wrapped(url, { method: 'POST', headers: jsonHeaders, ...init }),
      (error) => (expected instanceof Error ? error === expected : expected.test(String(error))),
    );
  }
});
test('non-JSON bytes, headers, absent bodies and content types keep their behavior', async () => {
  for (const method of ['GET', 'HEAD', 'POST']) {
    const wrapped = createRequestCustomizationFetch(
      async (_input, init) => {
        assert.equal(init?.method, method);
        assert.equal(init?.body, undefined);
        assert.equal(new Headers(init?.headers).get('x-custom'), 'yes');
        return new Response();
      },
      { ...overlay, headers: { 'x-custom': 'yes' } },
    );
    await wrapped(url, { method });
  }
  for (const contentType of [
    null,
    'application/problem+json; charset=iso-8859-1',
    'application/octet-stream',
  ]) {
    for (const customization of [overlay, { headers: { 'x-custom': 'yes' } }]) {
      const body = bytes('{"value":1}');
      const headers = new Headers({ 'content-length': String(body.byteLength) });
      if (contentType) headers.set('content-type', contentType);
      const changed = customization === overlay && contentType !== 'application/octet-stream';
      const wrapped = createRequestCustomizationFetch(async (_input, init) => {
        assert.equal(
          new Headers(init?.headers).get('content-length'),
          changed ? null : String(body.byteLength),
        );
        assert.deepEqual(
          await new Response(init?.body).json(),
          changed ? { value: 1, extra: true } : { value: 1 },
        );
        return new Response();
      }, customization);
      await wrapped(url, { method: 'POST', headers, body });
    }
  }
  const binary = new Uint8Array([0, 255, 128, 0]);
  await createRequestCustomizationFetch(async (_input, init) => {
    assert.deepEqual(new Uint8Array(await new Response(init?.body).arrayBuffer()), binary);
    return new Response();
  }, overlay)(url, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: binary,
  });
});
test('stream failures retain source error identity and caller stream lock state', async () => {
  for (const customization of [
    overlay,
    { headers: { 'x-custom': 'yes' } },
    { finalizeBody: (body: Record<string, unknown>) => body },
  ]) {
    for (const contentType of ['application/json', 'application/octet-stream']) {
      const failure = new Error('source body failed');
      const body = stream([], failure);
      const wrapped = createRequestCustomizationFetch(
        async () => assert.fail('must not send'),
        customization,
      );
      await assert.rejects(
        wrapped(url, { ...streamed(body), headers: { 'content-type': contentType } }),
        (error) => error === failure,
      );
      assert.equal(body.locked, true);
      const source = stream([], failure);
      const request = new Request(url, {
        ...streamed(source),
        headers: { 'content-type': contentType },
      });
      await assert.rejects(wrapped(request), (error) => error === failure);
      assert.equal(request.bodyUsed, true);
      assert.equal(request.body?.locked, false);
      assert.equal(source.locked, false);
    }
  }
  for (const state of ['used', 'locked']) {
    const request = new Request(url, { method: 'POST', body: '{}' });
    const reader = state === 'locked' ? request.body?.getReader() : undefined;
    if (state === 'used') await request.text();
    try {
      await assert.rejects(
        createRequestCustomizationFetch(async () => assert.fail('must not send'), overlay)(request),
        TypeError,
      );
    } finally {
      reader?.releaseLock();
    }
  }
});

test('large JSON customization performs one body read without a second clone allocation', () => {
  const moduleUrl = new URL('../request-customization-fetch.js', import.meta.url).href;
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
    import assert from 'node:assert/strict';
    import { createRequestCustomizationFetch } from ${JSON.stringify(moduleUrl)};
    const calls = { clone: 0, arrayBuffer: 0, text: 0 };
    const originals = {};
    for (const name of Object.keys(calls)) {
      originals[name] = Request.prototype[name];
      Request.prototype[name] = function (...args) {
        calls[name]++;
        return originals[name].apply(this, args);
      };
    }
    try {
      const value = 'a'.repeat(2 * 1024 * 1024);
      for (const mode of ['overlay', 'finalizer', 'headers', 'non-json']) {
        for (const name of Object.keys(calls)) calls[name] = 0;
        const customized = mode === 'overlay' || mode === 'finalizer';
        const customization = mode === 'headers' ? { headers: { 'x-custom': 'yes' } }
          : mode === 'finalizer' ? { finalizeBody: body => ({ ...body, extra: true }) }
          : { bodyOverlay: { extra: true } };
        const wrapped = createRequestCustomizationFetch(async (_url, init) => {
          assert.deepEqual(await new Response(init.body).json(),
            customized ? { value, extra: true } : { value });
          return new Response();
        }, customization);
        await wrapped('https://example.test/body', {
          method: 'POST', body: JSON.stringify({ value }),
          headers: { 'content-type': mode === 'non-json' ? 'text/plain' : 'application/json' },
        });
        assert.deepEqual(calls, { clone: 1, arrayBuffer: 1, text: 0 }, mode);
      }
    } finally {
      for (const name of Object.keys(calls)) Request.prototype[name] = originals[name];
    }
  `,
    ],
    { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(child.error, undefined, child.error?.message ?? 'child process failed');
  assert.equal(child.status, 0, child.stderr || child.stdout);
});
