import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalWebFetchExecutor, WEB_FETCH_RESPONSE_MAX_BYTES } from '../local-web-fetch.js';

test('local WebFetch decodes the charset declared by the response', async () => {
  const executor = createLocalWebFetchExecutor({
    fetch: async () =>
      new Response(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x96, 0x20, 0x6e, 0x65, 0x77]), {
        headers: { 'content-type': 'text/plain; charset=windows-1252' },
      }),
  });

  const result = await executor.fetch({ url: 'https://example.com/legacy', sessionId: 's1' });

  assert.equal(result, 'café – new');
});

test('local WebFetch extracts readable HTML as Markdown', async () => {
  const executor = createLocalWebFetchExecutor({
    fetch: async () =>
      new Response(
        '<!doctype html><html><head><title>Example</title></head><body>' +
          '<nav>Site navigation</nav><main><article><h1>Readable title</h1>' +
          '<p>A useful <a href="/details">article</a> body long enough for extraction.</p>' +
          '</article></main></body></html>',
        {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
  });

  const result = await executor.fetch({ url: 'https://example.com/page', sessionId: 's1' });

  assert.match(result, /^#{1,2} Readable title/m);
  assert.match(result, /\[article\]\(https:\/\/example\.com\/details\)/);
  assert.doesNotMatch(result, /Site navigation/);
});

test('local WebFetch resolves links against the document base URL', async () => {
  const executor = createLocalWebFetchExecutor({
    fetch: async () =>
      new Response(
        '<html><head><base href="https://cdn.example/assets/"></head><body><article>' +
          '<h1>Base URL</h1><p>A useful <a href="details">article link</a>.</p>' +
          '</article></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
  });

  const result = await executor.fetch({ url: 'https://example.com/page', sessionId: 's1' });

  assert.match(result, /\[article link\]\(https:\/\/cdn\.example\/assets\/details\)/);
});

test('local WebFetch rejects pathologically deep HTML before DOM parsing', async () => {
  const html = `<html><body>${'<div>'.repeat(600)}content${'</div>'.repeat(600)}</body></html>`;
  const executor = createLocalWebFetchExecutor({
    fetch: async () => new Response(html, { headers: { 'content-type': 'text/html' } }),
  });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/deep', sessionId: 's1' }),
    /HTML nesting exceeds the safety limit/i,
  );
});

test('local WebFetch rejects explicit cloud metadata targets before connecting', async () => {
  let requests = 0;
  const executor = createLocalWebFetchExecutor({
    fetch: async () => {
      requests += 1;
      return new Response('must not connect');
    },
  });

  for (const url of [
    'http://169.254.169.254/latest/meta-data/',
    'http://169.254.170.2/v2/credentials',
    'http://169.254.170.23/v1/credentials',
    'http://100.100.100.200/latest/meta-data/',
    'http://[fd00:ec2::254]/latest/meta-data/',
    'http://[fd00:ec2::23]/v1/credentials',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://[::ffff:169.254.170.2]/v2/credentials',
    'http://[::ffff:100.100.100.200]/latest/meta-data/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata.tencentyun.com/latest/meta-data/',
  ]) {
    await assert.rejects(
      executor.fetch({ url, sessionId: 's1' }),
      /cloud metadata target is not allowed/i,
    );
  }
  assert.equal(requests, 0);
});

test('local WebFetch allows localhost and private-network targets', async () => {
  const requested: string[] = [];
  const executor = createLocalWebFetchExecutor({
    fetch: async (url) => {
      requested.push(String(url));
      return new Response('local body');
    },
  });

  assert.equal(
    await executor.fetch({ url: 'http://127.0.0.1:3000/status', sessionId: 's1' }),
    'local body',
  );
  assert.equal(
    await executor.fetch({ url: 'http://192.168.1.10/status', sessionId: 's1' }),
    'local body',
  );
  assert.deepEqual(requested, ['http://127.0.0.1:3000/status', 'http://192.168.1.10/status']);
});

test('local WebFetch revalidates every redirect target', async () => {
  const requested: string[] = [];
  const executor = createLocalWebFetchExecutor({
    fetch: async (url) => {
      requested.push(String(url));
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
      });
    },
  });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/start', sessionId: 's1' }),
    /cloud metadata target is not allowed/i,
  );
  assert.deepEqual(requested, ['https://example.com/start']);
});

test('local WebFetch stops after ten redirects', async () => {
  let requests = 0;
  const executor = createLocalWebFetchExecutor({
    fetch: async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { location: `/hop-${requests}` } });
    },
  });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/start', sessionId: 's1' }),
    /exceeded 10 redirects/i,
  );
  assert.equal(requests, 11);
});

test('local WebFetch stops reading after the raw response exceeds 5 MB', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(WEB_FETCH_RESPONSE_MAX_BYTES));
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const executor = createLocalWebFetchExecutor({
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/plain' } }),
  });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/large', sessionId: 's1' }),
    /exceeds the 5 MB response limit/i,
  );
  assert.equal(cancelled, true);
});

test('local WebFetch applies one timeout across the whole request', async () => {
  const executor = createLocalWebFetchExecutor({
    timeoutMs: 5,
    fetch: async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
  });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/slow', sessionId: 's1' }),
    /timed out after 5 ms/i,
  );
});

test('local WebFetch reports non-success HTTP status', async () => {
  const executor = createLocalWebFetchExecutor({
    fetch: async () => new Response('not found', { status: 404, statusText: 'Not Found' }),
  });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/missing', sessionId: 's1' }),
    /HTTP error: 404 Not Found/,
  );
});

test('local WebFetch rejects an empty readable body', async () => {
  const executor = createLocalWebFetchExecutor({ fetch: async () => new Response('   \n') });

  await assert.rejects(
    executor.fetch({ url: 'https://example.com/empty', sessionId: 's1' }),
    /returned an empty body/i,
  );
});
