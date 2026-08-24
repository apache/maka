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
import { test } from 'node:test';
import type { HostedExecutionRef } from '../server/hosted-execution-authority.js';
import { HostedExecutionRegistry } from '../server/hosted-execution-registry.js';

test('Hosted Execution registry makes replacement and stale release explicit', () => {
  const registry = new HostedExecutionRegistry<HostedExecutionRef>();
  const first = execution('run-first');
  const replacement = execution('run-replacement');

  registry.activate(first);
  assert.throws(() => registry.activate(replacement), /already has an active hosted execution/);
  assert.equal(registry.get(first.sessionId), first);

  registry.activate(replacement, first);
  assert.equal(registry.release(first), false);
  assert.equal(registry.get(first.sessionId), replacement);
  assert.equal(registry.release(replacement), true);
  assert.equal(registry.size, 0);
});

test('Hosted Execution listeners are isolated and receive immutable identity hints', () => {
  const registry = new HostedExecutionRegistry<HostedExecutionRef>();
  const received: HostedExecutionRef[] = [];
  registry.subscribe(() => {
    throw new Error('observer failure');
  });
  const unsubscribe = registry.subscribe((execution) => received.push(execution));

  registry.publish(execution('run-published'));
  unsubscribe();
  registry.publish(execution('run-ignored'));

  assert.equal(received.length, 1);
  assert.equal(received[0]?.runId, 'run-published');
  assert.equal(Object.isFrozen(received[0]), true);
});

function execution(runId: string): HostedExecutionRef {
  return { sessionId: 'session-registry', turnId: `turn-${runId}`, runId };
}
