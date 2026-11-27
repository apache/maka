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

import type {
  NetworkProxy,
  SettingsNetworkSnapshot,
} from '../../../../../../packages/plugin-sdk/src/generated/runtime';
import { tr } from '../../locale';
import { credentialBasis, type SettingsRpc } from './rpc';

export async function saveNetwork(
  rpc: SettingsRpc,
  basis: SettingsNetworkSnapshot,
  proxy: NetworkProxy,
  password: string,
) {
  const credential = !proxy.authEnabled ? 'delete' : password ? 'replace' : 'keep';
  if (
    credential === 'keep' &&
    (['protocol', 'host', 'port', 'username'] as const).some(
      (key) => proxy[key] !== basis.proxy[key],
    )
  )
    throw new Error(
      tr(
        'The proxy address or username changed. Enter the password again or turn off proxy authentication.',
      ),
    );
  const result = await rpc.mutate(
    'settings',
    'updateNetwork',
    {
      expectedPolicyRevision: basis.revision,
      expectedCredential: credentialBasis(basis.credential),
      networkProxy: proxy,
      credential,
    },
    credential === 'replace' ? { secret: password } : undefined,
  );
  if (result.kind !== 'applied' || result.result.kind !== 'committed') {
    throw new Error(tr('Could not read or update settings.'), {
      cause: result.kind === 'applied' ? result.result.kind : result.kind,
    });
  }
  return rpc.query('settings', 'network', {});
}
