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
import type { ExecutionGraphStore } from '@maka/storage/execution-persistence-provider';
import type { AgentGraphSupervisorWakeCoordinator } from '@maka/runtime/agent-graph-supervisor-wake';
import type { AgentGraphCoordinator } from '@maka/runtime/stream-graph-coordinator';
import { RuntimeHostAgentGraphComposition } from '../server/agent-graph-composition.js';
import type { HostAgentGraphCoordinator } from '../server/agent-graph-coordinator.js';
import { createRuntimeHostDomainModule } from '../server/host-composition.js';

test('agent graph composition uses the selected persistence provider and closes once', async () => {
  let closes = 0;
  const store = {
    close: () => {
      closes += 1;
    },
  } as ExecutionGraphStore;
  const composition = new RuntimeHostAgentGraphComposition(store);
  assert.equal(composition.controlStore, store);
  assert.throws(() => composition.coordinator, /coordinator is not composed/);
  assert.throws(() => composition.client, /client is not composed/);
  assert.throws(() => composition.supervisorWake, /supervisor wake coordinator is not composed/);
  const module = createRuntimeHostDomainModule({
    id: 'agent-graph',
    drain: composition.drainHooks,
    close: composition.closeHooks,
  });
  module.beginDrain();
  await Promise.all([module.close(), module.close()]);
  assert.equal(closes, 1);
});

test('agent graph composition preserves recovery and drain order and attempts every close', async () => {
  const events: string[] = [];
  const composition = new RuntimeHostAgentGraphComposition({
    close: () => events.push('close:store'),
  } as unknown as ExecutionGraphStore);
  const failure = new Error('wake close failed');
  const wake = {
    recover: async () => {
      events.push('recover:wake');
    },
    beginDrain: () => events.push('drain:wake'),
    close: async () => {
      events.push('close:wake');
      throw failure;
    },
  } as unknown as AgentGraphSupervisorWakeCoordinator;
  composition.bindSupervisorWake(wake);
  composition.bindClient({
    close: () => events.push('close:client'),
  } as unknown as HostAgentGraphCoordinator);
  composition.bindCoordinator({
    recover: async () => {
      events.push('recover:coordinator');
    },
    beginDrain: () => events.push('drain:coordinator'),
    close: async () => {
      events.push('close:coordinator');
    },
  } as unknown as AgentGraphCoordinator);
  assert.throws(() => composition.bindSupervisorWake(wake), /already bound/);
  await composition.recover();
  const module = createRuntimeHostDomainModule({
    id: 'agent-graph',
    drain: composition.drainHooks,
    close: composition.closeHooks,
  });
  module.beginDrain();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(module.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [failure]);
      return true;
    });
  }
  assert.deepEqual(events, [
    'recover:wake',
    'recover:coordinator',
    'drain:wake',
    'drain:coordinator',
    'close:wake',
    'close:client',
    'close:coordinator',
    'close:store',
  ]);
});

test('a failed graph wake drain still drains the coordinator and is reported during module close', async () => {
  const events: string[] = [];
  const failure = new Error('wake drain failed');
  const composition = new RuntimeHostAgentGraphComposition({
    close: () => events.push('close:store'),
  } as unknown as ExecutionGraphStore);
  composition.bindSupervisorWake({
    beginDrain: () => {
      throw failure;
    },
    close: async () => {
      events.push('close:wake');
    },
  } as unknown as AgentGraphSupervisorWakeCoordinator);
  composition.bindCoordinator({
    beginDrain: () => events.push('drain:coordinator'),
    close: async () => {
      events.push('close:coordinator');
    },
  } as unknown as AgentGraphCoordinator);
  const module = createRuntimeHostDomainModule({
    id: 'agent-graph',
    drain: composition.drainHooks,
    close: composition.closeHooks,
  });
  module.beginDrain();
  module.beginDrain();
  await assert.rejects(module.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [failure]);
    return true;
  });
  assert.deepEqual(events, ['drain:coordinator', 'close:wake', 'close:coordinator', 'close:store']);
});

test('graph module preserves individual drain and close failures without extra aggregation', async () => {
  const failures = [
    new Error('wake drain failed'),
    new Error('coordinator drain failed'),
    new AggregateError([new Error('wake task failed')], 'wake close failed'),
    new Error('client close failed'),
    new Error('coordinator close failed'),
    new Error('store close failed'),
  ];
  const attempts: number[] = [];
  const fail = (index: number) => {
    attempts.push(index);
    throw failures[index];
  };
  const composition = new RuntimeHostAgentGraphComposition({
    close: () => fail(5),
  } as unknown as ExecutionGraphStore);
  composition.bindSupervisorWake({
    beginDrain: () => fail(0),
    close: async () => fail(2),
  } as unknown as AgentGraphSupervisorWakeCoordinator);
  composition.bindClient({ close: () => fail(3) } as unknown as HostAgentGraphCoordinator);
  composition.bindCoordinator({
    beginDrain: () => fail(1),
    close: async () => fail(4),
  } as unknown as AgentGraphCoordinator);
  const module = createRuntimeHostDomainModule({
    id: 'agent-graph',
    drain: composition.drainHooks,
    close: composition.closeHooks,
  });
  module.beginDrain();
  module.beginDrain();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(module.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures);
      return true;
    });
  }
  assert.deepEqual(attempts, [0, 1, 2, 3, 4, 5]);
});
