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

// A reconciliation the Host never answers used to hold the shared slot forever: broad
// could not acquire, and no status showed the stall. The bound must release the slot
// while keeping the unconfirmed wake visible instead of silently dropping it.
test('an unanswered recovery is bounded, resubmits nothing, and stays visible in status', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.control({ action: 'check' });

  // Crash window: the wake is admitted, but its execution outcome is never committed.
  const followup = f.agent.followup;
  f.agent.followup = async (...args: any[]) => {
    const result = await (followup as any)(...args);
    f.q.abort.abort(Error('terminated after admission'));
    return result;
  };
  await f.q.dispatch();
  await f.q.running;
  const interrupted = f.q.state().active;
  assert.ok(interrupted && !interrupted.executionCompleted);
  assert.equal(f.counts().workerCalls, 1);

  f.agent.followup = followup;
  await f.restart();
  // A real restart is a new coordinator owner, so startup reclaims the dead window's
  // reservation; this fixture keeps one coordinator, so reclaim it explicitly.
  f.parent.store.db.exec('DELETE FROM discovery_running');
  // Neither admission nor absence: the answer never comes.
  f.agent.messageExecution = async () => undefined as any;

  await f.q.dispatch();
  const recovering = f.q.state().recovery;
  assert.ok(recovering, 'a restored wake is tracked as recovering');
  assert.equal(recovering.exceededAt, undefined);
  assert.ok(f.parent.coordinator.status().recovering.quick, 'status shows the withheld lane');
  // Inside the bound the lane still reconciles before the other lane may start work.
  assert.equal(f.parent.coordinator.acquire('broad'), undefined);

  f.advance(61_000);
  await f.q.dispatch();
  const exceeded = f.q.state().recovery;
  assert.ok(exceeded.exceededAt, 'the bound is recorded');
  assert.match(f.q.state().lastError, /did not confirm/);
  // Degraded, not duplicated: the wake stays pending without a new submission.
  assert.equal(f.q.state().pending.id, interrupted.id);
  assert.equal(f.q.state().active, null);
  assert.equal(f.counts().workerCalls, 1);

  // Both the persisted status and the shared coordination status show the stall.
  const status = f.parent.coordinator.status();
  assert.equal(status.recovering.quick?.attempts, exceeded.attempts);
  assert.ok(status.recovering.quick?.exceededAt, 'the degraded lane stays visible');
  const permit = f.parent.coordinator.acquire('broad');
  assert.ok(permit, 'broad is no longer blocked by an unanswered recovery');
  f.parent.coordinator.release(permit);
});
