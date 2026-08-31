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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { AgentGraphSupervisorWakeCoordinator } from '@maka/runtime/agent-graph-supervisor-wake';
import type { AgentGraphCoordinator } from '@maka/runtime/stream-graph-coordinator';
import { RuntimeHostAgentGraphComposition } from '../server/agent-graph-composition.js';
import type { HostAgentGraphCoordinator } from '../server/agent-graph-coordinator.js';

test('agent graph composition fails closed before staged authorities are bound', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-graph-composition-'));
  const composition = new RuntimeHostAgentGraphComposition(root);
  try {
    assert.throws(() => composition.coordinator, /coordinator is not composed/);
    assert.throws(() => composition.client, /client is not composed/);
    assert.throws(() => composition.supervisorWake, /supervisor wake coordinator is not composed/);
    composition.beginDrain();
    await composition.close();
    await composition.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent graph composition attempts every owned close after a failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'maka-agent-graph-composition-'));
  const composition = new RuntimeHostAgentGraphComposition(root);
  const closed: string[] = [];
  composition.bindSupervisorWake({
    close: async () => {
      closed.push('wake');
      throw new Error('wake close failed');
    },
  } as unknown as AgentGraphSupervisorWakeCoordinator);
  composition.bindClient({
    close: () => closed.push('client'),
  } as unknown as HostAgentGraphCoordinator);
  composition.bindCoordinator({
    close: async () => {
      closed.push('coordinator');
    },
  } as unknown as AgentGraphCoordinator);
  try {
    await assert.rejects(composition.close(), /wake close failed/);
    assert.deepEqual(closed, ['wake', 'client', 'coordinator']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
