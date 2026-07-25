import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createProviderEnvFetch } from '../provider-env-fetch.js';

test('provider env fetch routes AI SDK requests through the process HTTP proxy', async () => {
  let proxyRequests = 0;
  const proxy = createServer((_request, response) => {
    proxyRequests += 1;
    response.end('through-proxy');
  });

  await listen(proxy);
  const proxyPort = addressPort(proxy);
  const providerFetch = createProviderEnvFetch({
    NODE_USE_ENV_PROXY: '1',
    HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    NO_PROXY: '',
  });
  assert.ok(providerFetch);

  try {
    const response = await providerFetch.fetch('http://host.docker.internal:443/probe');
    assert.equal(await response.text(), 'through-proxy');
    assert.equal(proxyRequests, 1);
  } finally {
    await providerFetch.close();
    await close(proxy);
  }
});

test('provider env fetch stays absent unless environment proxying is explicitly enabled', () => {
  assert.equal(
    createProviderEnvFetch({
      HTTP_PROXY: 'http://127.0.0.1:8080',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
    }),
    undefined,
  );
});

async function listen(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

function addressPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind a TCP port');
  return address.port;
}
