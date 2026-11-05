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

/** Stop at the crash boundary that the Host owns: the wake was admitted, the completion
 * state was never stored, and the admitted turn is still running in its Session. */
async function handoff(f: any) {
  await f.q.control({ action: 'check', eventIntake: false });
  const followup = f.agent.followup;
  f.agent.followup = async (...args: any[]) => {
    const result = await followup(...args);
    f.q.abort.abort(Error('terminated after admission'));
    return result;
  };
  await f.q.dispatch();
  await f.q.running;
  const active = f.q.state().active;
  assert.ok(active && !active.executionCompleted, 'the crash leaves the activation unfinished');
  assert.equal(active.submission.messageId, active.messageId, 'the accepted payload is sealed');
  f.agent.followup = followup;
  f.agent.snapshot = async () => ({ agent: { status: 'running' }, pendingInteractions: 0 });
  f.advance(3600000);
  await f.restart();
  await f.q.control({ action: 'configure', eventIntake: false });
  f.agent.snapshot = async () => ({ agent: { status: 'running' }, pendingInteractions: 0 });
  f.advance(3600000);
  return active;
}

test('recovery keeps the shared investigation slot while the admitted worker still runs', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const active = await handoff(f);
  assert.equal(f.parent.coordinator.status().running, null, 'the crash released the old owner');
  await f.q.dispatch();
  const state = f.q.state();
  assert.equal(state.active, null, 'the recovered activation stays pending until it can run');
  assert.equal(state.pending.id, active.id);
  assert.equal(
    f.parent.coordinator.status().running?.lane,
    'quick',
    'a running worker still owns the shared slot',
  );
  assert.equal(
    f.parent.coordinator.acquire('broad'),
    undefined,
    'broad discovery cannot start under an unfinished quick activation',
  );
  f.parent.coordinator.withdraw('broad');
});

test('a sealed handoff keeps the worker write identity across recovery', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const active = await handoff(f);
  await f.q.dispatch();
  assert.equal(f.q.state().active, null);
  assert.equal(
    f.q.execution('worker', true),
    active.id,
    'DiscoveryNotebookRemember must resolve the sealed activation, not reject it',
  );
  assert.throws(() => f.q.execution('owner', true), /Not a discovery worker/);
  // Only an accepted payload is sealed; a prepared but unaccepted handoff grants nothing.
  f.q.store.update((s: any) => {
    delete s.pending.submission;
  });
  assert.throws(
    () => f.q.execution('worker', true),
    /No active quick discovery execution/,
    'an unaccepted handoff does not keep a write identity',
  );
});
