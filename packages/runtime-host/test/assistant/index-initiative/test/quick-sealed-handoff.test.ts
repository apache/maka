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

import test from 'node:test';
import assert from 'node:assert/strict';
import { intakeFixture } from './intake-fixture.js';

test('a prepared submission without Host admission grants no memory write identity', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.control({ action: 'check', eventIntake: false });
  f.agent.followup = async () => {
    throw Error('Request never reached the Host');
  };
  await f.q.dispatch();
  await f.q.running;
  const pending = f.q.state().pending;
  assert.equal(
    pending.submission.messageId,
    pending.messageId,
    'a payload is saved before submission',
  );
  assert.equal((await f.agent.messageExecution(pending.messageId)).state, 'not_admitted');
  assert.throws(() => f.q.execution('worker', true), /No active quick discovery execution/);
  assert.equal(f.q.execution('worker', false), undefined);
  assert.throws(() => f.q.execution('owner', true), /Not a discovery worker/);
  // Reconciliation clears uncertainty without ignoring the configured retry deadline.
  await f.q.dispatch();
  assert.equal(f.counts().workerCalls, 0);
  const broad = f.parent.coordinator.acquire('broad');
  assert.ok(broad);
  f.parent.coordinator.release(broad);
});

test('an investigation awaiting user input keeps its slot and write identity', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.control({ action: 'check', eventIntake: false });
  let awaiting = false;
  let observed!: () => void;
  const blocked = new Promise<void>((resolve) => {
    observed = resolve;
  });
  f.agent.whenIdle = async () => {
    awaiting = true;
  };
  f.agent.snapshot = async () => {
    if (awaiting) observed();
    return {
      agent: { status: awaiting ? 'waiting_for_user' : 'idle' },
      pendingInteractions: Number(awaiting),
    };
  };
  await f.q.dispatch();
  await blocked;
  assert.ok(f.q.running);
  assert.equal(f.q.execution('worker', true), f.q.state().active.id);
  assert.equal(f.parent.coordinator.status().running?.lane, 'quick');
  assert.equal(f.parent.coordinator.acquire('broad'), undefined);
  f.parent.coordinator.withdraw('broad');
  // Only this observer is aborted; user-input handling itself remains the Host's job.
  f.q.abort.abort(Error('Test finished at user-input boundary'));
  await f.q.running;
});
