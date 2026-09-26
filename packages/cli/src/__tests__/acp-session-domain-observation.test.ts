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
import { setImmediate as nextEventLoopTurn, setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import type { GoalProjection, PlanQueryResult } from '@maka/runtime-host/protocol';
import { AcpSessionDomainObservation } from '../acp/session-domain-observation.js';

for (const withPendingClear of [false, true]) {
  test(`latest null Goal survives an in-flight notification (pending clear: ${withPendingClear})`, async (t) => {
    const delivery = deferred();
    const goals: Array<GoalProjection | null> = [];
    const active = goal();
    const observer = new AcpSessionDomainObservation({
      sessionId: 'session-1',
      queryPlan: async () => page(0),
      goalNotify: () => async (status) => {
        if (status.goal === active) await delivery.promise;
        goals.push(status.goal);
      },
      planNotify: () => undefined,
    });
    t.after(() => observer.dispose());
    observer.goalChanged(null);
    await nextEventLoopTurn();
    assert.deepEqual(goals, [null]);
    observer.goalChanged(active);
    if (withPendingClear) observer.goalChanged(goal({ revision: 2, status: 'cleared' }));
    // A Session retirement can remove the Goal after clear while the client is slow.
    observer.goalChanged(null);
    assert.deepEqual(goals, [null], 'only one notification may be in flight');
    delivery.resolve();
    await nextEventLoopTurn();
    assert.deepEqual(goals, [null, active, null]);
  });
}

test('Goal delivery coalesces newer revisions and deduplicates only after delivery', async (t) => {
  const delivery = deferred();
  const goals: Array<GoalProjection | null> = [];
  const active = goal();
  const latest = goal({ revision: 3, status: 'cleared' });
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => page(0),
    goalNotify: () => async (status) => {
      if (goals.length === 0) await delivery.promise;
      goals.push(status.goal);
    },
    planNotify: () => undefined,
  });
  t.after(() => observer.dispose());
  observer.goalChanged(active);
  observer.goalChanged(goal({ revision: 2, status: 'paused' }));
  observer.goalChanged(latest);
  observer.goalChanged(goal({ revision: 2, status: 'paused' }));
  delivery.resolve();
  await nextEventLoopTurn();
  assert.deepEqual(
    goals,
    [active, latest],
    'stale revisions cannot overwrite the latest pending Goal',
  );
  observer.goalChanged({ ...latest });
  await nextEventLoopTurn();
  assert.deepEqual(goals, [active, latest], 'already delivered snapshots are not repeated');
});

test('duplicate Goal changes during delivery do not schedule a duplicate notification', async (t) => {
  const delivery = deferred();
  const goals: Array<GoalProjection | null> = [];
  const active = goal();
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => page(0),
    goalNotify: () => async (status) => {
      goals.push(status.goal);
      await delivery.promise;
    },
    planNotify: () => undefined,
  });
  t.after(() => observer.dispose());
  observer.goalChanged(active);
  observer.goalChanged({ ...active });
  delivery.resolve();
  await nextEventLoopTurn();
  assert.deepEqual(goals, [active]);
});

test('a late Goal delivery cannot suppress the same snapshot in a new canonical epoch', async (t) => {
  const delivery = deferred();
  const goals: Array<GoalProjection | null> = [];
  const active = goal();
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => page(0),
    goalNotify: () => async (status) => {
      goals.push(status.goal);
      if (goals.length === 1) await delivery.promise;
    },
    planNotify: () => undefined,
  });
  t.after(() => observer.dispose());
  observer.goalChanged(active);
  observer.canonicalReplacement({ ...active });
  delivery.resolve();
  await nextEventLoopTurn();
  assert.deepEqual(goals, [active, active]);
});

for (const rejectDelivery of [false, true]) {
  test(`dispose fences a pending Goal after delivery ${rejectDelivery ? 'failure' : 'success'}`, async (t) => {
    const delivery = deferred();
    const goals: Array<GoalProjection | null> = [];
    const errors = t.mock.method(console, 'error', () => undefined);
    const active = goal();
    const observer = new AcpSessionDomainObservation({
      sessionId: 'session-1',
      queryPlan: async () => page(0),
      goalNotify: () => async (status) => {
        goals.push(status.goal);
        await delivery.promise;
      },
      planNotify: () => undefined,
    });
    t.after(() => observer.dispose());
    observer.goalChanged(active);
    observer.goalChanged(null);
    observer.dispose();
    if (rejectDelivery) delivery.reject(new Error('notification transport closed'));
    else delivery.resolve();
    await nextEventLoopTurn();
    observer.goalChanged(null);
    assert.deepEqual(goals, [active]);
    assert.equal(errors.mock.callCount(), rejectDelivery ? 1 : 0);
  });
}

test('failed Goal delivery is logged once and retried only after another domain update', async (t) => {
  const active = goal();
  const goals: Array<GoalProjection | null> = [];
  const errors = t.mock.method(console, 'error', () => undefined);
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => page(0),
    goalNotify: () => async (status) => {
      goals.push(status.goal);
      if (goals.length === 1) throw new Error('temporary notification failure');
    },
    planNotify: () => undefined,
  });
  t.after(() => observer.dispose());

  observer.goalChanged(active);
  await waitFor(() => errors.mock.callCount() === 1);
  await delay(100);
  assert.deepEqual(goals, [active], 'a failed send is not automatically retried');
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /Goal status delivery failed/);

  observer.goalChanged({ ...active });
  await waitFor(() => goals.length === 2);
  assert.deepEqual(goals, [active, active], 'failure did not mark the Goal as delivered');
  assert.equal(errors.mock.callCount(), 1);
  observer.goalChanged({ ...active });
  await nextEventLoopTurn();
  assert.equal(goals.length, 2, 'a successfully delivered duplicate is suppressed');
});

test('failed Plan delivery is logged once and retried only after another domain update', async (t) => {
  const plans: number[] = [];
  const errors = t.mock.method(console, 'error', () => undefined);
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => page(4),
    goalNotify: () => undefined,
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
      if (plans.length === 1) throw new Error('temporary notification failure');
    },
  });
  t.after(() => observer.dispose());

  observer.planChanged();
  await waitFor(() => errors.mock.callCount() === 1);
  await delay(100);
  assert.deepEqual(plans, [4], 'a failed send is not automatically retried');
  assert.match(String(errors.mock.calls[0]?.arguments[0]), /Plan status delivery failed/);

  observer.planChanged();
  await waitFor(() => plans.length === 2);
  assert.deepEqual(plans, [4, 4], 'failure did not mark the Plan as delivered');
  assert.equal(errors.mock.callCount(), 1);
  observer.planChanged();
  await nextEventLoopTurn();
  assert.equal(plans.length, 2, 'a successfully delivered duplicate is suppressed');
});

test('canonical Plan replacement rereads even when Goal is unchanged and rejects an old page', async () => {
  const reads: Array<(result: PlanQueryResult) => void> = [];
  const plans: number[] = [];
  const goals: unknown[] = [];
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: () =>
      new Promise<PlanQueryResult>((resolve) => {
        reads.push(resolve);
      }),
    goalNotify: () => async (status) => {
      goals.push(status);
    },
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
    },
  });
  observer.initialize(null);
  assert.equal(reads.length, 1);
  observer.canonicalReplacement(null);
  reads[0]!(page(9));
  await waitFor(() => reads.length === 2);
  assert.deepEqual(plans, []);
  reads[1]!(page(1));
  await waitFor(() => plans.length === 1);
  assert.deepEqual(plans, [1]);
  assert.equal(goals.length, 2, 'new canonical epoch replays the Goal projection');
  observer.dispose();
});

test('Plan invalidations coalesce during one read and dispose fences late delivery', async () => {
  const reads: Array<(result: PlanQueryResult) => void> = [];
  const plans: number[] = [];
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: () =>
      new Promise<PlanQueryResult>((resolve) => {
        reads.push(resolve);
      }),
    goalNotify: () => undefined,
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
    },
  });
  observer.planChanged();
  observer.planChanged();
  observer.planChanged();
  assert.equal(reads.length, 1);
  reads[0]!(page(1));
  await waitFor(() => reads.length === 2);
  reads[1]!(page(2));
  await waitFor(() => plans.includes(2));
  assert.deepEqual(plans, [1, 2]);
  observer.planChanged();
  await waitFor(() => reads.length === 3);
  observer.dispose();
  reads[2]!(page(3));
  await Promise.resolve();
  assert.deepEqual(plans, [1, 2]);
});

test('failed initial Plan refresh retries without inventing a state notification', async () => {
  let reads = 0;
  const plans: number[] = [];
  const observer = new AcpSessionDomainObservation({
    sessionId: 'session-1',
    queryPlan: async () => {
      reads += 1;
      if (reads === 1) throw new Error('temporary read failure');
      return page(4);
    },
    goalNotify: () => undefined,
    planNotify: () => async (status) => {
      plans.push(status.storeVersion);
    },
  });
  observer.planChanged();
  await waitFor(() => plans.length === 1);
  assert.deepEqual(plans, [4]);
  assert.equal(reads, 2);
  observer.dispose();
});

function goal(overrides: Partial<GoalProjection> = {}): GoalProjection {
  return {
    sessionId: 'session-1',
    goalId: 'goal-1',
    revision: 1,
    condition: 'Finish the task',
    status: 'active',
    setAt: 1,
    iterations: 0,
    maxIterations: 10,
    consecutiveNoProgress: 0,
    blockCap: 3,
    tokenBudget: null,
    tokensSpent: 0,
    lastReason: null,
    achievedAt: null,
    pausedAt: null,
    ...overrides,
  };
}

function page(storeVersion: number): PlanQueryResult {
  return {
    kind: 'page',
    sessionId: 'session-1',
    storeVersion,
    latestProposalId: null,
    activeExecutionId: null,
    items: [],
    nextCursor: null,
  };
}
