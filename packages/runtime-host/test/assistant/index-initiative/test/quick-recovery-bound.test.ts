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
test('an unanswered recovery remains visible and cannot release or duplicate the investigation', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.control({ action: 'check' });
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
  f.agent.followup = followup;
  await f.restart();
  const query = f.agent.messageExecution;
  f.agent.messageExecution = async () => undefined as any;
  for (const elapsed of [0, 61_000, 3_600_000]) {
    f.advance(elapsed);
    await f.q.dispatch();
    assert.equal(f.parent.runner.status().running?.lane, 'quick');
    assert.match(String(f.parent.runner.status().recovering.quick?.reason), /not resolved/);
    assert.equal(f.q.state().active.id, interrupted.id);
    assert.equal(f.counts().workerCalls, 1);
  }
  f.agent.messageExecution = query;
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.parent.runner.status().running, null);
  assert.equal(f.counts().workerCalls, 1, 'recovered the original admission');
});
