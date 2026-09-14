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
import { createDefaultRuntimePolicy, type RuntimePolicy } from '@maka/core/runtime-policy';
import { HOST_OPERATION_SPECS } from '../protocol/operations.js';
import { HostNetworkProxyCoordinator } from '../server/network-proxy-coordinator.js';
import type { ConnectionContext } from '../server/operation-dispatcher.js';

const CONNECTION: ConnectionContext = {
  hostEpoch: 'host-epoch-1',
  connectionId: 'connection-1',
  principal: 'local_os_user',
  acquireResidency: () => ({ release: () => undefined }),
};

function coordinatorFor(
  networkProxy: Partial<RuntimePolicy['networkProxy']>,
  secret?: string,
): HostNetworkProxyCoordinator {
  const policy = createDefaultRuntimePolicy();
  return new HostNetworkProxyCoordinator({
    async resolveNetworkProxyExecution() {
      return {
        kind: 'ready',
        networkProxy: { ...policy.networkProxy, ...networkProxy },
        secretMaterial: secret === undefined ? {} : { networkProxy: { secret } },
      };
    },
  } as never);
}

async function resolve(coordinator: HostNetworkProxyCoordinator) {
  const outcome = await coordinator.handlers['network-proxy.resolve']({}, CONNECTION);
  assert.ok(outcome.ok, 'network-proxy.resolve failed');
  return outcome.result;
}

describe('network-proxy.resolve', () => {
  test('serves the enabled proxy with its merged bypass list', async () => {
    const result = await resolve(
      coordinatorFor({
        enabled: true,
        protocol: 'http',
        host: '127.0.0.1',
        port: 7897,
        authEnabled: false,
        username: '',
        bypassList: ['localhost'],
        autoBypassDomains: ['metaso.cn', 'localhost'],
      }),
    );
    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(result.proxy?.host, '127.0.0.1');
    assert.strictEqual(result.proxy?.port, 7897);
    // The Client applies the list verbatim, so the automatic domains have to be
    // merged here and duplicates dropped.
    assert.deepStrictEqual(result.proxy?.bypassList, ['localhost', 'metaso.cn']);
  });

  test('carries the credential an authenticated proxy cannot be dialled without', async () => {
    const result = await resolve(
      coordinatorFor(
        {
          enabled: true,
          protocol: 'http',
          host: 'proxy.test',
          port: 8080,
          authEnabled: true,
          username: 'operator',
          bypassList: [],
          autoBypassDomains: [],
        },
        'secret-value',
      ),
    );
    assert.strictEqual(result.proxy?.username, 'operator');
    assert.strictEqual(result.proxy?.password, 'secret-value');
  });

  test('omits the proxy when the policy disables it', async () => {
    const result = await resolve(coordinatorFor({ enabled: false }));
    assert.strictEqual(result.kind, 'ready');
    assert.strictEqual(result.proxy, undefined);
  });

  test('reports an unconfigured credential instead of a proxy', async () => {
    const coordinator = new HostNetworkProxyCoordinator({
      async resolveNetworkProxyExecution() {
        return { kind: 'credential_not_configured' };
      },
    } as never);
    const result = await resolve(coordinator);
    assert.strictEqual(result.kind, 'credential_not_configured');
    assert.strictEqual(result.proxy, undefined);
  });

  test('never reports the underlying failure, which can carry the credential', async () => {
    const coordinator = new HostNetworkProxyCoordinator({
      async resolveNetworkProxyExecution() {
        throw new Error('proxy://operator:secret-value@proxy.test:8080 is unreadable');
      },
    } as never);
    const outcome = await coordinator.handlers['network-proxy.resolve']({}, CONNECTION);
    assert.strictEqual(outcome.ok, false);
    assert.ok(!outcome.ok && !outcome.error.message.includes('secret-value'));
  });
});

describe('network-proxy.resolve codec', () => {
  const spec = HOST_OPERATION_SPECS['network-proxy.resolve'];

  test('round-trips a resolved proxy', () => {
    const decoded = spec.decodeOutput({
      kind: 'ready',
      proxy: {
        enabled: true,
        type: 'socks5',
        host: '127.0.0.1',
        port: 7897,
        username: 'operator',
        password: 'secret-value',
        bypassList: ['localhost'],
      },
    });
    assert.deepStrictEqual(decoded, {
      kind: 'ready',
      proxy: {
        enabled: true,
        type: 'socks5',
        host: '127.0.0.1',
        port: 7897,
        username: 'operator',
        password: 'secret-value',
        bypassList: ['localhost'],
      },
    });
  });

  test('rejects a proxy that is not usable', () => {
    assert.throws(() =>
      spec.decodeOutput({
        kind: 'ready',
        proxy: {
          enabled: false,
          type: 'http',
          host: '127.0.0.1',
          port: 7897,
          bypassList: [],
        },
      }),
    );
    assert.throws(() =>
      spec.decodeOutput({
        kind: 'ready',
        proxy: { enabled: true, type: 'ftp', host: 'h', port: 1, bypassList: [] },
      }),
    );
    assert.throws(() =>
      spec.decodeOutput({
        kind: 'ready',
        proxy: { enabled: true, type: 'http', host: '', port: 1, bypassList: [] },
      }),
    );
    assert.throws(() =>
      spec.decodeOutput({
        kind: 'ready',
        proxy: { enabled: true, type: 'http', host: 'h', port: 0, bypassList: [] },
      }),
    );
  });

  test('rejects an unresolved result that still carries a configuration', () => {
    assert.throws(() =>
      spec.decodeOutput({
        kind: 'credential_not_configured',
        proxy: { enabled: true, type: 'http', host: 'h', port: 1, bypassList: [] },
      }),
    );
  });

  test('rejects an unknown kind and unexpected input', () => {
    assert.throws(() => spec.decodeOutput({ kind: 'ready_ish' }));
    assert.throws(() => spec.decodeInput({ networkProxy: {} }));
  });
});
