import { describe, test } from 'node:test';
import { expect } from '../../test-helpers.js';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { getEnvWithProxy } from '../proxy-env.js';

describe('getEnvWithProxy', () => {
  test('injects proxy env without overwriting user exports', () => {
    const out = getEnvWithProxy(
      { HTTP_PROXY: 'http://existing:1234' },
      { ...PROXY_DEFAULTS, enabled: true, host: '127.0.0.1', port: 7890 },
    );
    expect(out.HTTP_PROXY).toBe('http://existing:1234');
    expect(out.HTTPS_PROXY).toBe('http://127.0.0.1:7890');
    expect(out.NO_PROXY).toBe('localhost,127.0.0.1,::1,*.local');
  });

  test('emits socks5 and IPv6 URLs', () => {
    const out = getEnvWithProxy(
      {},
      { ...PROXY_DEFAULTS, enabled: true, type: 'socks5', host: '::1', port: 1080 },
    );
    expect(out.HTTP_PROXY).toBe('socks5://[::1]:1080');
  });
});
