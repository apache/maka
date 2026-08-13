import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { fetch as undiciFetch } from 'undici';
import { createExternalProviderDispatcher } from '../external-provider-dispatcher.js';

test('external provider dispatcher defers inactivity deadlines to the benchmark', async () => {
  const server = createServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    }, 1_500);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const bounded = createExternalProviderDispatcher(undefined, {
    headersTimeoutMs: 100,
    bodyTimeoutMs: 100,
  });
  const evalTransport = createExternalProviderDispatcher(undefined);
  const url = `http://127.0.0.1:${address.port}/slow`;

  try {
    await assert.rejects(() => undiciFetch(url, { dispatcher: bounded.dispatcher }));
    const response = await undiciFetch(url, { dispatcher: evalTransport.dispatcher });
    assert.equal(await response.text(), 'ok');
  } finally {
    await Promise.all([bounded.close(), evalTransport.close()]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
