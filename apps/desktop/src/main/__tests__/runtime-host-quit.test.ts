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
import { prepareRuntimeHostQuit } from '../runtime-host-quit.js';

test('quit proceeds without consent when no owned Host is probed', async () => {
  const probes: string[] = [];
  const owner = {
    probeOwnedLocalHostActivity: async () => {
      probes.push('probe');
      return { kind: 'not_owned' } as const;
    },
  };

  assert.equal(
    await prepareRuntimeHostQuit(owner, {
      confirmInterrupt: async () => assert.fail('consent is not expected without an owned Host'),
    }),
    'ready',
  );
  assert.deepEqual(probes, ['probe']);
});

test('quit proceeds without consent when the owned Host is clear', async () => {
  const owner = {
    probeOwnedLocalHostActivity: async () => ({ kind: 'clear' }) as const,
  };

  assert.equal(
    await prepareRuntimeHostQuit(owner, {
      confirmInterrupt: async () => assert.fail('consent is not expected when idle'),
    }),
    'ready',
  );
});

test('background work requires consent before quitting', async () => {
  const probes: string[] = [];
  const owner = {
    probeOwnedLocalHostActivity: async () => {
      probes.push('probe');
      return { kind: 'active_tasks' } as const;
    },
  };

  assert.equal(
    await prepareRuntimeHostQuit(owner, { confirmInterrupt: async () => false }),
    'cancelled',
  );
  assert.equal(
    await prepareRuntimeHostQuit(owner, { confirmInterrupt: async () => true }),
    'ready',
  );
  assert.deepEqual(probes, ['probe', 'probe']);
});

test('quit proceeds without an owner', async () => {
  assert.equal(
    await prepareRuntimeHostQuit(undefined, {
      confirmInterrupt: async () => assert.fail('consent is not expected without an owner'),
    }),
    'ready',
  );
});
