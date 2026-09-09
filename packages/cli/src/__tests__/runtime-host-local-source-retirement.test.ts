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
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
  type HostRegistration,
} from '@maka/runtime-host/protocol';
import { runRuntimeHostLocalSourceRetirement } from '../runtime-host-local-source-retirement.js';

const ROOT_ID = 'a'.repeat(64);
const INPUT = {
  rootPath: '/state',
  expectedRootId: ROOT_ID,
  expectedHostEpoch: 'source-host',
  activeWorkPolicy: 'refuse_active_work' as const,
};

test('retires only the exact ephemeral Host through the source package client', async () => {
  let closed = false;
  let observedMode = '';
  const result = await runRuntimeHostLocalSourceRetirement(INPUT, {
    connectExisting: async () => ({
      kind: 'connected',
      registration: registration(),
      connection: {
        close: async () => {
          closed = true;
        },
      } as never,
    }),
    prepareRetirement: async (_connection, mode) => {
      observedMode = mode;
      return { kind: 'prepared', pid: 42 };
    },
  });
  assert.equal(result, 0);
  assert.equal(observedMode, 'refuse_active_work');
  assert.equal(closed, true);
});

test('preserves active work unless the parent explicitly selected interruption', async () => {
  const result = await runRuntimeHostLocalSourceRetirement(
    { ...INPUT, activeWorkPolicy: 'interrupt_active_work' },
    {
      connectExisting: async () => ({
        kind: 'connected',
        registration: registration(),
        connection: { close: async () => undefined } as never,
      }),
      prepareRetirement: async (_connection, mode) => {
        assert.equal(mode, 'interrupt_active_work');
        return { kind: 'active_tasks', tasks: [] };
      },
    },
  );
  assert.equal(result, 2);
});

test('fails closed when the observed Host changes before retirement', async () => {
  let closed = false;
  await assert.rejects(
    runRuntimeHostLocalSourceRetirement(INPUT, {
      connectExisting: async () => ({
        kind: 'connected',
        registration: registration({ hostEpoch: 'replacement-host' }),
        connection: {
          close: async () => {
            closed = true;
          },
        } as never,
      }),
      prepareRetirement: async () => assert.fail('a changed Host must not be retired'),
    }),
    /changed before source-package retirement/u,
  );
  assert.equal(closed, true);
});

test('keeps service Hosts under operator authority', async () => {
  assert.equal(
    await runRuntimeHostLocalSourceRetirement(INPUT, {
      connectExisting: async () => ({
        kind: 'connected',
        registration: registration({ lifecycleMode: 'service' }),
        connection: { close: async () => undefined } as never,
      }),
      prepareRetirement: async () => assert.fail('a service Host must not be retired'),
    }),
    4,
  );
});

test('does not misclassify an unavailable source Host as operator-owned', async () => {
  await assert.rejects(
    runRuntimeHostLocalSourceRetirement(INPUT, {
      connectExisting: async () => ({ kind: 'unavailable', reason: 'not_registered' }),
    }),
    /cannot control the observed Runtime Host/u,
  );
});

function registration(overrides: Partial<HostRegistration> = {}): HostRegistration {
  return {
    kind: 'maka-runtime-host',
    schemaVersion: RUNTIME_HOST_REGISTRATION_SCHEMA_VERSION,
    rootId: ROOT_ID,
    hostEpoch: 'source-host',
    endpoint: '/tmp/maka.sock',
    protocolMin: RUNTIME_HOST_PROTOCOL_VERSION,
    protocolMax: RUNTIME_HOST_PROTOCOL_VERSION,
    compatibilityEpoch: RUNTIME_HOST_COMPATIBILITY_EPOCH,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    compositionRevision: 'revision',
    lifecycleMode: 'ephemeral',
    state: 'ready',
    pid: 42,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}
