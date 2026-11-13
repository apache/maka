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
import { laneFixture } from './runner-fixture.js';

// Recovery age, not investigation age, controls abandonment. Captured source work
// remains available, while a retired worker cannot send reports into a later cycle.
for (const failure of [
  'unanswered query',
  'Session lookup failure',
  'Session lookup never replies',
]) {
  test(`${failure} abandons after five minutes and retries on the ordinary cadence`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    await f.q.intake.collect();
    f.add('pending-hint');
    await f.q.intake.collect();
    f.advance();
    await f.q.intake.judge();
    await f.q.control({ action: 'check' });
    const idle = f.agent.whenIdle;
    f.agent.whenIdle = async () => {
      throw Error('Observer connection lost');
    };
    await f.q.dispatch();
    await f.q.running;
    const interrupted = f.q.state().pending;
    assert.ok(interrupted && !interrupted.executionCompleted);
    const since = f.parent.runner.status().recovering.quick.since;
    const query = f.agent.messageExecution;
    const resume = f.ctx.agents.resume;
    if (failure === 'unanswered query') f.agent.messageExecution = async () => undefined as any;
    else if (failure === 'Session lookup never replies')
      f.ctx.agents.resume = () => new Promise(() => {});
    else
      f.ctx.agents.resume = async () => {
        throw Error('Session lookup unavailable');
      };

    const broad = laneFixture(f.parent.runner, f.parent.store, 'broad');
    broad.request();
    f.advance(299_999);
    await f.q.dispatch();
    assert.equal(f.parent.runner.status().running?.lane, 'quick');
    assert.equal(broad.calls(), 0);
    assert.equal(f.parent.runner.status().recovering.quick.since, since);
    await f.restart();
    f.advance(1);
    let cancellations = 0;
    f.agent.cancel = async () => {
      cancellations++;
      return new Promise<void>(() => {});
    };
    await f.q.dispatch();
    assert.equal(f.parent.runner.abandoned(interrupted.id), true);
    assert.equal(f.parent.runner.status().running?.lane, 'broad');
    assert.equal(broad.calls(), 1, 'another due investigation is no longer blocked');
    assert.equal(f.q.state().pending, null);
    assert.equal(f.q.state().active, null);
    assert.equal(f.q.state().checkRequested, false);
    assert.equal(f.q.state().workerSession, undefined);
    assert.equal(f.counts().workerCalls, 1, 'no immediate replacement');
    assert.equal(f.q.state().checkedThrough, undefined, 'no successful source watermark');
    assert.equal((await f.q.intake.next())?.ids.length, 1, 'captured hints are not consumed');
    await assert.rejects(
      f.q.report({ key: 'late', messages: ['discard me'] }, 'worker'),
      /active quick/,
    );
    assert.throws(() => f.q.execution('worker', true), /Not a discovery worker/);
    assert.equal(f.delivered.size, 0);
    if (failure === 'unanswered query') assert.equal(cancellations, 1);
    await broad.finish();

    f.agent.messageExecution = query;
    f.agent.whenIdle = idle;
    const sessions = await f.ctx.sessionQuery.list();
    f.ctx.agents.create = async (input: any) => {
      sessions.push({ id: 'next-worker', ...input });
      return { ...f.agent, sessionId: 'next-worker' };
    };
    f.ctx.agents.resume = async ({ sessionId }: any) =>
      sessionId === 'next-worker' ? { ...f.agent, sessionId } : resume({ sessionId });
    f.advance(f.q.state().intervalMs - 1);
    await f.q.dispatch();
    assert.equal(f.counts().workerCalls, 1);
    f.advance(1);
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.counts().workerCalls, 2);
    assert.equal(f.q.state().workerSession, 'next-worker');
    assert.equal(f.q.state().lastError, null);
    assert.equal(f.q.workerIdentity('worker')?.role, 'quick', 'retired restrictions survive');
    await assert.rejects(
      f.q.report({ key: 'late', messages: ['still discard me'] }, 'worker'),
      /active quick/,
    );
    assert.equal(f.delivered.size, 0);
  });
}

test('recovery before the deadline resumes the original admission without resubmitting', async (t) => {
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
  f.agent.followup = followup;
  await f.restart();
  const query = f.agent.messageExecution;
  f.agent.messageExecution = async () => undefined as any;
  f.advance(299_999);
  await f.q.dispatch();
  assert.equal(f.parent.runner.status().running?.lane, 'quick');
  f.agent.messageExecution = query;
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.parent.runner.status().running, null);
  assert.equal(f.counts().workerCalls, 1);
});
