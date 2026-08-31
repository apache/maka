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
import { describe, test } from 'node:test';
import { PROXY_DEFAULTS } from '@maka/core/settings/network-settings';
import { buildProxyUrl, parseProxyConfig } from '../proxy-parser.js';

describe('parseProxyConfig', () => {
  test('coerces type and port safely', () => {
    assert.partialDeepStrictEqual(parseProxyConfig({ type: 'ftp', port: '7890' }), {
      type: 'http',
      port: 7890,
    });
    assert.partialDeepStrictEqual(parseProxyConfig({ type: 'socks5', port: 0 }), {
      type: 'socks5',
      port: 8080,
    });
    assert.partialDeepStrictEqual(parseProxyConfig({ type: 'https', port: 999_999 }), {
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
    assert.strictEqual(proxy.username, undefined);
    assert.strictEqual(proxy.password, undefined);
    assert.deepStrictEqual(proxy.bypassList, ['localhost', '127.0.0.1']);
  });
});

describe('buildProxyUrl', () => {
  test('builds proxy URLs with encoded credentials', () => {
    assert.strictEqual(
      buildProxyUrl({
        ...PROXY_DEFAULTS,
        enabled: true,
        type: 'https',
        host: 'proxy.example.com',
        port: 443,
        username: 'u',
        password: 'p@ss',
      }),
      'https://u:p%40ss@proxy.example.com:443',
    );
  });

  test('brackets IPv6 hosts', () => {
    assert.strictEqual(
      buildProxyUrl({ ...PROXY_DEFAULTS, enabled: true, host: '::1', port: 7890 }),
      'http://[::1]:7890',
    );
  });
});
