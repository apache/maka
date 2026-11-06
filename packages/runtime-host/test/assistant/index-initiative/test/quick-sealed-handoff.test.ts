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
  assert.equal(f.parent.runner.status().running, null);
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
  assert.equal(f.parent.runner.status().running?.lane, 'quick');
  f.parent.runner.request('broad');
  await f.q.dispatch();
  assert.equal(f.parent.runner.waiting('broad'), true);
  f.parent.runner.withdraw('broad');
  // Only this observer is aborted; user-input handling itself remains the Host's job.
  f.q.abort.abort(Error('Test finished at user-input boundary'));
  await f.q.running;
});

test('an unsupported completed query state cannot finish an investigation', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.control({ action: 'check', eventIntake: false });
  const query = f.agent.messageExecution;
  f.agent.messageExecution = async () => ({ state: 'completed' }) as any;
  await f.q.dispatch();
  await f.q.running;
  assert.match(f.q.state().lastError, /Unexpected Host message execution state/);
  assert.equal(f.q.state().lastFinishedAt, undefined);
  assert.equal(f.counts().workerCalls, 0);
  assert.equal(f.parent.runner.status().running?.lane, 'quick');
  f.agent.messageExecution = query;
  await f.q.control({ action: 'check' });
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.q.state().lastError, null);
  assert.equal(f.counts().workerCalls, 1);
});

test('a protocol inbox reply waits for owned admission before settling', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.control({ action: 'check', eventIntake: false });
  const query = f.agent.messageExecution;
  const followup = f.agent.followup;
  let inInbox = false;
  let observed!: () => void;
  const waiting = new Promise<void>((resolve) => {
    observed = resolve;
  });
  f.agent.followup = async (input, options) => {
    const result = await followup(input, options);
    inInbox = true;
    return result;
  };
  f.agent.messageExecution = async (id) => {
    if (inInbox) {
      observed();
      return { state: 'inbox' } as any;
    }
    return query(id);
  };
  await f.q.dispatch();
  await waiting;
  assert.equal(f.q.state().lastFinishedAt, undefined);
  assert.equal(f.parent.runner.status().running?.lane, 'quick');
  inInbox = false;
  await f.q.running;
  assert.equal(f.q.state().lastError, null);
  assert.ok(f.q.state().lastFinishedAt);
  assert.equal(f.counts().workerCalls, 1);
});
