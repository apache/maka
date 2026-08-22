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

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isDrivingGoal } from '@maka/core/goal';
import { GoalManager, goalCheckpoint, type GoalState } from '../goal-state.js';

const SESSION = 'sess-1';

function createManager(startTime = 1_700_000_000_000) {
  let id = 0;
  let time = startTime;
  const events: Array<{ goal: GoalState; previous?: string }> = [];
  const mgr = new GoalManager({
    generateId: () => `goal-${++id}`,
    now: () => time,
    onChange: (goal, _controlLease, previous) => {
      events.push({ goal, previous });
    },
  });
  return {
    mgr,
    events,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function createGoal(
  mgr: GoalManager,
  condition = 'all tests pass',
  opts?: Parameters<GoalManager['create']>[2],
): GoalState {
  const result = mgr.create(SESSION, condition, opts);
  assert.equal(result.kind, 'created');
  return result.goal;
}

function settle(
  mgr: GoalManager,
  input:
    | { waiting: true; madeProgress?: never; tokensNow?: number; reason?: string }
    | { waiting?: false; madeProgress?: boolean; tokensNow?: number; reason?: string } = {},
) {
  const goal = mgr.getActive(SESSION);
  assert.ok(goal);
  if (input.waiting === true) {
    return mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(goal),
      verdict: 'continue',
      waiting: true,
      reason: input.reason ?? 'keep going',
      ...(input.tokensNow !== undefined ? { tokensNow: input.tokensNow } : {}),
    });
  }
  return mgr.settleTurn(SESSION, {
    checkpoint: goalCheckpoint(goal),
    verdict: 'continue',
    reason: input.reason ?? 'keep going',
    madeProgress: input.madeProgress ?? true,
    ...(input.tokensNow !== undefined ? { tokensNow: input.tokensNow } : {}),
  });
}

describe('GoalManager creation and lifecycle', () => {
  test('isolates observer failure after committing state', () => {
    let notifications = 0;
    const mgr = new GoalManager({
      generateId: () => 'goal-1',
      now: () => 1,
      onChange: () => {
        notifications++;
        throw new Error('observer failed');
      },
    });

    const created = createGoal(mgr);
    const result = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(created),
      verdict: 'continue',
      reason: 'keep going',
      madeProgress: true,
    });

    assert.ok(result);
    assert.equal(mgr.get(SESSION)?.iterations, 1);
    assert.equal(notifications, 2);
  });

  test('creates an immutable active goal with defaults and custom limits', () => {
    const { mgr } = createManager();
    const goal = createGoal(mgr, 'ship it', {
      maxIterations: 10,
      blockCap: 3,
      tokenBudget: 5000,
    });

    assert.equal(goal.revision, 0);
    assert.equal(goal.status, 'active');
    assert.equal(goal.maxIterations, 10);
    assert.equal(goal.blockCap, 3);
    assert.equal(goal.tokenBudget, 5000);
    assert.equal(goal.tokensAtStart, 0);
    assert.ok(Object.isFrozen(goal));

    const { mgr: defaults } = createManager();
    const defaultGoal = createGoal(defaults);
    assert.equal(defaultGoal.maxIterations, 50);
    assert.equal(defaultGoal.blockCap, 8);
  });

  test('stores the condition trimmed, whichever caller set it', () => {
    const { mgr } = createManager();
    assert.equal(createGoal(mgr, '  ship it\n').condition, 'ship it');
  });

  test('rejects active and paused Goal replacement without mutating either snapshot', () => {
    const { mgr, events } = createManager();
    const original = createGoal(mgr, 'first');

    const activeConflict = mgr.create(SESSION, 'second');
    assert.equal(activeConflict.kind, 'unfinished');
    assert.strictEqual(activeConflict.goal, original);

    const paused = mgr.pause(SESSION);
    assert.equal(paused?.revision, 1);
    const pausedConflict = mgr.create(SESSION, 'third');
    assert.equal(pausedConflict.kind, 'unfinished');
    assert.strictEqual(pausedConflict.goal, paused);
    assert.equal(events.length, 2);
  });

  test('a terminal Goal may be followed by a new Goal without rewriting its snapshot', () => {
    const { mgr } = createManager();
    const first = createGoal(mgr, 'first');
    const cleared = mgr.clear(SESSION);
    assert.equal(cleared?.status, 'cleared');
    const second = mgr.create(SESSION, 'second');

    assert.equal(second.kind, 'created');
    assert.notEqual(second.goal.id, first.id);
    assert.equal(first.status, 'active');
    assert.equal(first.revision, 0);
  });

  test('pause, resume, waiting wake, and clear each produce a new revision', () => {
    const { mgr, advance } = createManager();
    const original = createGoal(mgr);
    advance(10);
    const paused = mgr.pause(SESSION);
    const resumed = mgr.resume(SESSION);
    const waiting = settle(mgr, { waiting: true });
    assert.ok(waiting);
    const woken = mgr.wakeWaiting(SESSION, goalCheckpoint(waiting));
    const cleared = mgr.clear(SESSION);

    assert.equal(original.revision, 0);
    assert.equal(paused?.revision, 1);
    assert.equal(paused?.status, 'paused');
    assert.equal(resumed?.revision, 2);
    assert.equal(resumed?.status, 'active');
    assert.equal(resumed?.pausedAt, undefined);
    assert.equal(waiting.revision, 3);
    assert.equal(waiting.status, 'waiting');
    assert.equal(woken?.revision, 4);
    assert.equal(woken?.status, 'active');
    assert.equal(cleared?.revision, 5);
    assert.equal(cleared?.status, 'cleared');
    assert.equal(mgr.clear(SESSION), undefined);
  });

  test('waiting blocks replacement, can be paused with a reason, and rejects stale wake', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'wait for CI');
    const waiting = settle(mgr, {
      waiting: true,
      reason: 'CI is still running',
    });
    assert.ok(waiting);

    assert.equal(mgr.create(SESSION, 'replacement').kind, 'unfinished');
    const stale = { goalId: waiting.id, revision: waiting.revision - 1 };
    assert.equal(mgr.wakeWaiting(SESSION, stale), undefined);
    assert.equal(mgr.get(SESSION)?.status, 'waiting');

    const paused = mgr.pause(SESSION, {
      checkpoint: goalCheckpoint(waiting),
      reason: 'Continuation host is unavailable',
    });
    assert.equal(paused?.status, 'paused');
    assert.equal(paused?.lastReason, 'Continuation host is unavailable');
  });

  test('restored control authority uses durable value identity and rejects an older generation', () => {
    const { mgr: source } = createManager();
    const goal = createGoal(source, 'survive restart');
    const durableLease = source.getControlLease(SESSION);
    assert.ok(durableLease);

    const { mgr: restored } = createManager();
    restored.restore(goal, durableLease);
    assert.notStrictEqual(restored.getControlLease(SESSION), durableLease);
    assert.equal(restored.matchesControlLease(SESSION, durableLease), true);

    assert.ok(restored.pause(SESSION));
    assert.equal(restored.matchesControlLease(SESSION, durableLease), false);
  });
});

describe('GoalManager token budget baseline', () => {
  test('measures the budget from the first carried Turn, whoever set the Goal', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'ship it', { tokenBudget: 1_000 });

    // The Session had already spent 40k before anything carried this Goal.
    // That settlement establishes the baseline instead of being charged to it.
    const first = settle(mgr, { madeProgress: true, tokensNow: 40_000 });
    assert.equal(first?.status, 'active');
    assert.equal(first?.tokensAtStart, 40_000);
    assert.equal(first?.tokensBaselinePending, false);

    // Everything the Goal drives from there is measured against the budget.
    const second = settle(mgr, { madeProgress: true, tokensNow: 40_500 });
    assert.equal(second?.status, 'active', '500 of a 1,000 budget leaves it running');

    const third = settle(mgr, { madeProgress: true, tokensNow: 41_000 });
    assert.equal(third?.status, 'budget_limited');
  });
});

describe('GoalManager arming', () => {
  test('a Goal the model set drives from the moment it exists', () => {
    const { mgr } = createManager();
    assert.equal(isDrivingGoal(createGoal(mgr, 'x')), true);
  });

  test('an armed Goal drives once a carried Turn settles it into a continuation', () => {
    const { mgr } = createManager();
    assert.equal(isDrivingGoal(createGoal(mgr, 'x', { armed: true })), false);
    const settled = settle(mgr);
    assert.ok(settled);
    assert.equal(isDrivingGoal(settled), true);
  });

  test('resume drives an armed Goal no Turn ever carried', () => {
    const { mgr } = createManager();
    const armed = createGoal(mgr, 'x', { armed: true });
    const paused = mgr.pause(SESSION, { checkpoint: goalCheckpoint(armed) });
    assert.ok(paused);
    const resumed = mgr.resume(SESSION, goalCheckpoint(paused));
    assert.ok(resumed);
    assert.equal(isDrivingGoal(resumed), true);
  });
});

describe('GoalManager atomic turn settlement', () => {
  test('commits token, iteration, progress, reason, revision, and one event atomically', () => {
    const { mgr, events } = createManager();
    const before = createGoal(mgr, 'x');
    const result = settle(mgr, {
      madeProgress: false,
      tokensNow: 50_000,
      reason: 'one check remains',
    });

    assert.ok(result);
    assert.equal(result.revision, 1);
    assert.equal(result.iterations, 1);
    assert.equal(result.consecutiveNoProgress, 1);
    assert.equal(result.tokensAtStart, 50_000);
    assert.equal(result.tokensNow, 50_000);
    assert.equal(result.lastReason, 'one check remains');
    assert.equal(before.iterations, 0);
    assert.equal(events.length, 2);
    assert.equal(events[1]?.previous, 'active');
  });

  test('terminal evaluator verdict settles without advancing turn counters', () => {
    const { mgr } = createManager();
    const goal = createGoal(mgr, 'x', { maxIterations: 1, tokenBudget: 1000 });
    const result = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(goal),
      verdict: 'achieved',
      reason: 'verified',
    });

    assert.ok(result);
    assert.equal(result.status, 'achieved');
    assert.equal(result.iterations, 0);
    assert.equal(result.lastReason, 'verified');
  });

  test('token budget stops settlement before iteration and stall updates', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x', { tokenBudget: 1000, maxIterations: 2, blockCap: 1 });
    settle(mgr, { tokensNow: 500, madeProgress: true });
    const budget = settle(mgr, { tokensNow: 1500, madeProgress: false });

    assert.ok(budget);
    assert.equal(budget.status, 'budget_limited');
    assert.equal(budget.iterations, 1);
    assert.equal(budget.consecutiveNoProgress, 0);
  });

  test('iteration cap stops settlement before the stall update', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x', { maxIterations: 1, blockCap: 1 });

    const result = settle(mgr, { madeProgress: false });

    assert.ok(result);
    assert.equal(result.status, 'max_iterations');
    assert.equal(result.consecutiveNoProgress, 0);
  });

  test('progress resets the streak and no progress eventually stalls', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x', { blockCap: 2 });
    settle(mgr, { madeProgress: false });
    settle(mgr, { madeProgress: true });
    settle(mgr, { madeProgress: false });
    const stopped = settle(mgr, { madeProgress: false });

    assert.ok(stopped);
    assert.equal(stopped.status, 'stalled');
    assert.equal(stopped.consecutiveNoProgress, 2);
  });

  test('waiting consumes a real iteration but is neutral to progress and still obeys hard caps', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'wait', { maxIterations: 2, blockCap: 1 });
    const first = settle(mgr, {
      waiting: true,
      reason: 'external check pending',
    });

    assert.ok(first);
    assert.equal(first.status, 'waiting');
    assert.equal(first.iterations, 1);
    assert.equal(first.consecutiveNoProgress, 0);

    const active = mgr.wakeWaiting(SESSION, goalCheckpoint(first));
    assert.ok(active);
    const capped = mgr.settleTurn(SESSION, {
      checkpoint: goalCheckpoint(active),
      verdict: 'continue',
      waiting: true,
      reason: 'still pending',
    });
    assert.ok(capped);
    assert.equal(capped.status, 'max_iterations');
    assert.equal(capped.consecutiveNoProgress, 0);
  });

  test('token observations remain monotonic after the initial baseline', () => {
    const { mgr } = createManager();
    createGoal(mgr, 'x');
    settle(mgr, { tokensNow: 1000 });
    settle(mgr, { tokensNow: 1800 });
    settle(mgr, { tokensNow: 1200 });

    assert.equal(mgr.get(SESSION)?.tokensNow, 1800);
    assert.equal(mgr.tokensSpent(SESSION), 800);
  });
});

describe('GoalManager stale rejection', () => {
  test('rejects an evaluator checkpoint invalidated by pause and resume', () => {
    const { mgr, events } = createManager();
    const goal = createGoal(mgr);
    const checkpoint = goalCheckpoint(goal);
    mgr.pause(SESSION);
    const resumed = mgr.resume(SESSION);
    const eventCount = events.length;

    const result = mgr.settleTurn(SESSION, {
      checkpoint,
      verdict: 'achieved',
      reason: 'stale verdict',
    });

    assert.equal(result, undefined);
    assert.strictEqual(mgr.get(SESSION), resumed);
    assert.equal(events.length, eventCount);
  });

  test('rejects an evaluator checkpoint after clear and replacement (ABA)', () => {
    const { mgr } = createManager();
    const first = createGoal(mgr, 'first');
    const checkpoint = goalCheckpoint(first);
    mgr.clear(SESSION);
    const replacement = mgr.create(SESSION, 'replacement');
    assert.equal(replacement.kind, 'created');

    const result = mgr.settleTurn(SESSION, {
      checkpoint,
      verdict: 'impossible',
      reason: 'stale verdict',
    });

    assert.equal(result, undefined);
    assert.equal(mgr.get(SESSION)?.condition, 'replacement');
    assert.equal(mgr.get(SESSION)?.status, 'active');
  });
});
