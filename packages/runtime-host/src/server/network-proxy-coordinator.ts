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

import type { ProxySettings } from '@maka/core/settings/network-settings';
import type { RuntimePolicy } from '@maka/core/runtime-policy';
import { testProxyConnection } from '@maka/runtime/network/proxy-test';
import type { RuntimePolicyOperationCoordinator } from '@maka/storage/runtime-policy-stores';
import type { NetworkProxyTestInput, OperationOutcome } from '../protocol/index.js';
import type { NetworkProxyOperationHandlerMap } from './operation-dispatcher.js';

export class HostNetworkProxyCoordinator {
  readonly handlers: NetworkProxyOperationHandlerMap = {
    'network-proxy.test': (input) => this.#test(input),
  };

  constructor(
    private readonly policy: Pick<
      RuntimePolicyOperationCoordinator,
      'resolveNetworkProxyExecution'
    >,
  ) {}

  async #test(input: NetworkProxyTestInput): Promise<OperationOutcome<'network-proxy.test'>> {
    try {
      const resolved = await this.policy.resolveNetworkProxyExecution({
        ...(input.networkProxy ? { networkProxy: input.networkProxy } : {}),
        ...(input.password ? { secretOverride: input.password } : {}),
      });
      if (resolved.kind === 'credential_not_configured') {
        return {
          ok: true,
          result: {
            ok: false,
            latencyMs: 0,
            error: 'Proxy credential is not configured',
          },
        };
      }
      const proxy = toProxySettings(
        resolved.networkProxy,
        resolved.secretMaterial.networkProxy?.secret,
      );
      return {
        ok: true,
        result: await testProxyConnection({
          proxy,
          ...(input.url ? { url: input.url } : {}),
          ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
        }),
      };
    } catch {
      return {
        ok: false,
        error: {
          code: 'internal_failure',
          message: 'Network proxy test failed',
        },
      };
    }
  }
}

function toProxySettings(
  policy: RuntimePolicy['networkProxy'],
  password: string | undefined,
): ProxySettings {
  return {
    enabled: policy.enabled,
    type: policy.protocol,
    host: policy.host,
    port: policy.port,
    ...(policy.authEnabled && policy.username ? { username: policy.username } : {}),
    ...(policy.authEnabled && password ? { password } : {}),
    bypassList: [...policy.bypassList],
  };
}
