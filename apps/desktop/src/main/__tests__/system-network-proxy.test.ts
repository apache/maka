import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSystemProxyRules } from '../system-network-proxy.js';

test('uses the first non-direct system proxy rule', () => {
  assert.deepEqual(parseSystemProxyRules('DIRECT; PROXY 127.0.0.1:7897; SOCKS5 127.0.0.1:1080'), {
    source: 'system',
    proxy: {
      enabled: true,
      type: 'http',
      host: '127.0.0.1',
      port: 7897,
      bypassList: [],
    },
    requiresAuthentication: false,
  });
});

test('normalizes an IPv6 SOCKS system proxy rule', () => {
  assert.deepEqual(parseSystemProxyRules('SOCKS5 [::1]:1088'), {
    source: 'system',
    proxy: {
      enabled: true,
      type: 'socks5',
      host: '::1',
      port: 1088,
      bypassList: [],
    },
    requiresAuthentication: false,
  });
});

test('returns no candidate for direct or malformed rules', () => {
  assert.equal(parseSystemProxyRules('DIRECT'), undefined);
  assert.equal(parseSystemProxyRules('PROXY :7897'), undefined);
});
