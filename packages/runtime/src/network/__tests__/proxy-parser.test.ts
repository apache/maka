import { describe, test } from 'node:test';
import { expect } from '../../test-helpers.js';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { buildProxyUrl, parseProxyConfig } from '../proxy-parser.js';

describe('parseProxyConfig', () => {
  test('coerces type and port safely', () => {
    expect(parseProxyConfig({ type: 'ftp', port: '7890' })).toMatchObject({
      type: 'http',
      port: 7890,
    });
    expect(parseProxyConfig({ type: 'socks5', port: 0 })).toMatchObject({
      type: 'socks5',
      port: 8080,
    });
    expect(parseProxyConfig({ type: 'https', port: 999_999 })).toMatchObject({
      type: 'https',
      port: 8080,
    });
  });

  test('drops empty credentials and filters bypassList', () => {
    const proxy = parseProxyConfig({
      username: '',
      password: '',
      bypassList: ['localhost', 42, '', '127.0.0.1'],
    });
    expect(proxy.username).toBeUndefined();
    expect(proxy.password).toBeUndefined();
    expect(proxy.bypassList).toEqual(['localhost', '127.0.0.1']);
  });
});

describe('buildProxyUrl', () => {
  test('builds proxy URLs with encoded credentials', () => {
    expect(
      buildProxyUrl({
        ...PROXY_DEFAULTS,
        enabled: true,
        type: 'https',
        host: 'proxy.example.com',
        port: 443,
        username: 'u',
        password: 'p@ss',
      }),
    ).toBe('https://u:p%40ss@proxy.example.com:443');
  });

  test('brackets IPv6 hosts', () => {
    expect(buildProxyUrl({ ...PROXY_DEFAULTS, enabled: true, host: '::1', port: 7890 })).toBe(
      'http://[::1]:7890',
    );
  });
});
