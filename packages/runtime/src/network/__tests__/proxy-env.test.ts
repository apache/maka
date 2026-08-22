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
