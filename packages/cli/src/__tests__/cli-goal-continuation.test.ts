import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core';
import {
  AutomationManager,
  AutomationScheduler,
  GoalManager,
  type GoalTurnOutcome,
} from '@maka/runtime';
import { CliGoalContinuation } from '../cli-goal-continuation.js';
import { WAIT_BUDGET_MS } from './tui-terminal-mock.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  // Same budget policy as the shared TUI waitFor (#2221): the wait returns as
  // soon as the condition holds, so the floor only bounds a failing report,
  // and CI runners get the scaled budget instead of losing scheduling races.
  const deadline = Date.now() + Math.max(1_000, WAIT_BUDGET_MS);
  while (!condition()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe('CLI Goal continuation host', () => {
  test('routes a scheduled heartbeat through the shared turn lifecycle and Goal FIFO', async () => {
    const sessionId = 'session-1';
    let now = 1_000;
    let goalId = 0;
    let evaluations = 0;
    let admissions = 0;
    const goalManager = new GoalManager({
      generateId: () => `goal-${++goalId}`,
      now: () => now,
    });
    goalManager.create(sessionId, 'ship');
    const lifecycle = new CliGoalContinuation({
      goalManager,
      evaluator: {
        evaluate: async () => {
          evaluations++;
          return JSON.stringify({
            met: false,
            impossible: false,
            progress: true,
            waiting: false,
            reason: `evidence-${evaluations}`,
          });
        },
      },
      getRecentContext: async () => 'recent context',
    });
    const ownedCompletion = deferred<GoalTurnOutcome>();
    lifecycle.bindHost({
      admitTurn: () => {
        admissions++;
        return {
          kind: 'prepared',
          turnId: 'owned-turn',
          start: () => ownedCompletion.promise,
        };
      },
    });

    const automationManager = new AutomationManager({
      generateId: () => 'automation-1',
      now: () => now,
      random: () => 0,
    });
    const automation = automationManager.create({
      kind: 'heartbeat',
      name: 'check',
      prompt: 'check status',
      sessionId,
      schedule: { type: 'interval', seconds: 10 },
    });
    assert.ok(!('error' in automation));
    now += 11_000;

    const timers: Array<() => void> = [];
    const streamStarted = deferred<void>();
    const releaseStream = deferred<void>();
    const scheduler = new AutomationScheduler({
      automationManager,
      canFire: async () => true,
      injectTurn: async () => {
        const outcome = await lifecycle.runAutomationTurn({
          sessionId,
          turnId: 'heartbeat-turn',
          start: async function* (): AsyncIterable<SessionEvent> {
            streamStarted.resolve();
            await releaseStream.promise;
            yield {
              type: 'complete',
              id: 'heartbeat-complete',
              turnId: 'heartbeat-turn',
              ts: now,
              stopReason: 'end_turn',
            };
          },
        });
        return { runId: 'heartbeat-turn', ok: outcome.kind === 'completed' };
      },
      setTimeout: (callback) => {
        timers.push(callback);
        return callback;
      },
      clearTimeout: () => {},
      now: () => now,
    });

    scheduler.start();
    timers.shift()?.();
    await streamStarted.promise;
    assert.ok(lifecycle.activities.whenIdle(sessionId));

    releaseStream.resolve();
    await waitFor(() => evaluations === 1, 'heartbeat completion did not enter the Goal FIFO');
    await waitFor(() => admissions === 1, 'Goal admission did not resume after heartbeat drain');
    await waitFor(
      () => automationManager.get(automation.id)?.lastRunId === 'heartbeat-turn',
      'scheduler did not observe the drained heartbeat result',
    );

    assert.equal(goalManager.get(sessionId)?.iterations, 1);
    scheduler.dispose();
    lifecycle.dispose();
    goalManager.dispose();
  });
});
