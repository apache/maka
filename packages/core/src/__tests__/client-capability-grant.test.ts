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
import test from 'node:test';
import {
  clientCapabilityScopeIdentity,
  decodeClientCapabilityGrantTarget,
} from '../client-capability-grant.js';

const base = {
  providerId: 'provider',
  contractId: 'contract',
  serverId: 'desktop_computer_use',
  toolName: 'maka_computer',
  capability: 'computer_use',
} as const;

test('decodes Computer Use application and catalog scopes', () => {
  assert.deepEqual(
    decodeClientCapabilityGrantTarget({
      ...base,
      scope: { kind: 'macos_bundle_id', bundleId: 'Com.Example-App' },
    }),
    {
      ...base,
      scope: { kind: 'macos_bundle_id', bundleId: 'Com.Example-App' },
    },
  );
  assert.deepEqual(decodeClientCapabilityGrantTarget({ ...base, scope: { kind: 'app_catalog' } }), {
    ...base,
    scope: { kind: 'app_catalog' },
  });
  assert.equal(clientCapabilityScopeIdentity({ kind: 'app_catalog' }), 'app_catalog');
});

test('rejects invalid Computer Use application scopes', () => {
  for (const bundleId of ['', ' com.example.App', 'com/example/App', 'pid:42', 'x'.repeat(513)]) {
    assert.throws(
      () =>
        decodeClientCapabilityGrantTarget({
          ...base,
          scope: { kind: 'macos_bundle_id', bundleId },
        }),
      /Invalid macOS bundle ID/u,
    );
  }
  assert.throws(
    () =>
      decodeClientCapabilityGrantTarget({
        ...base,
        capability: 'browser',
        scope: { kind: 'app_catalog' },
      }),
    /scope does not match capability/u,
  );
});
