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
import type { RuntimeHostRetirementMode } from '@maka/runtime-host/client';
import { prepareRuntimeHostQuit } from '../runtime-host-quit.js';

test('background work requires consent before interruption', async () => {
  const modes: RuntimeHostRetirementMode[] = [];
  const owner = {
    retireOwnedLocalHost: async (mode: RuntimeHostRetirementMode) => {
      modes.push(mode);
      return mode === 'refuse_active_work'
        ? ({ kind: 'active_tasks' } as const)
        : ({ kind: 'retired', resume: () => {} } as const);
    },
  };

  assert.equal(await prepareRuntimeHostQuit(owner, async () => false), 'cancelled');
  assert.deepEqual(modes, ['refuse_active_work']);

  assert.equal(await prepareRuntimeHostQuit(owner, async () => true), 'ready');
  assert.deepEqual(modes, [
    'refuse_active_work',
    'refuse_active_work',
    'interrupt_active_work',
  ]);
});
