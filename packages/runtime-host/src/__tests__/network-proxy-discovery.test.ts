import assert from 'node:assert/strict';
import test from 'node:test';
import { detectEnvironmentProxy } from '../server/network-proxy-discovery.js';

test('detects the highest-priority standard proxy environment variable', () => {
  assert.deepEqual(
    detectEnvironmentProxy({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:8080',
      NO_PROXY: 'localhost, 127.0.0.1',
    }),
    {
      source: 'environment',
      proxy: {
        enabled: true,
        type: 'http',
        host: '127.0.0.1',
        port: 7897,
        bypassList: ['localhost', '127.0.0.1'],
      },
      requiresAuthentication: false,
    },
  );
});

test('detects authenticated and IPv6 SOCKS candidates without retaining credentials', () => {
  assert.deepEqual(detectEnvironmentProxy({ ALL_PROXY: 'socks5://proxy-user:secret@[::1]:1088' }), {
    source: 'environment',
    proxy: {
      enabled: true,
      type: 'socks5',
      host: '::1',
      port: 1088,
      bypassList: [],
    },
    requiresAuthentication: true,
  });
});

test('ignores invalid or unsupported proxy environment values', () => {
  assert.equal(detectEnvironmentProxy({ HTTPS_PROXY: 'not a url' }), undefined);
  assert.equal(detectEnvironmentProxy({ HTTPS_PROXY: 'ftp://proxy.example:21' }), undefined);
});
