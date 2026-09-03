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

import { decodeClientCapabilityGrantTarget } from '@maka/core/client-capability-grant';
import { clientCapabilityProviderId } from '../server/client-capability-provider-id.js';

const IDENTITY = {
  principalKind: 'capability_provider' as const,
  principalId: 'desktop:installation-a',
  clientInstanceId: 'client-instance-a',
};

describe('clientCapabilityProviderId', () => {
  test('is stable, safe, private, and sensitive to every authenticated identity field', () => {
    const first = clientCapabilityProviderId(IDENTITY);
    const second = clientCapabilityProviderId({ ...IDENTITY });

    assert.equal(first, second);
    assert.match(first, /^[A-Za-z0-9_-]{1,128}$/u);
    assert.equal(first.includes(IDENTITY.principalId), false);
    assert.equal(first.includes(IDENTITY.clientInstanceId), false);
    assert.doesNotThrow(() =>
      decodeClientCapabilityGrantTarget({
        providerId: first,
        contractId: 'contract-1',
        serverId: 'desktop_browser',
        toolName: 'browser_snapshot',
        capability: 'browser',
        scope: { kind: 'browser_origin', origin: 'https://example.com' },
      }),
    );
    const variants = [
      { ...IDENTITY, principalKind: 'local_owner' as const },
      { ...IDENTITY, principalId: 'desktop:installation-b' },
      { ...IDENTITY, clientInstanceId: 'client-instance-b' },
    ];

    for (const variant of variants) {
      assert.notEqual(clientCapabilityProviderId(variant), first);
    }
  });
});
