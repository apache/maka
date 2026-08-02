import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  GoalContinuationCoordinator,
  GoalManager,
  SessionActivityRegistry,
} from '@maka/runtime';
import type { SessionEvent } from '@maka/core';
import {
  startDesktopSessionTurn,
  type DesktopSessionTurnStart,
  type SessionGoalBoundary,
} from '../session-turn-stream.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('Desktop session turn Goal boundary', () => {
  test('external settles once only after the complete stream drains and releases activity', async () => {
    const registry = new SessionActivityRegistry();
    const release = deferred<void>();
    const observed: string[] = [];
    async function* events(): AsyncIterable<SessionEvent> {
      yield {
        type: 'text_delta', id: 'delta', turnId: 'turn-1', ts: 1,
        messageId: 'message-1', text: 'working',
      };
      await release.promise;
      yield { type: 'complete', id: 'complete', turnId: 'turn-1', ts: 2, stopReason: 'end_turn' };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-1',
      goalBoundary: 'external',
      activities: registry,
      beginObservedTurn: () => ({
        kind: 'registered',
        settle: async (outcome) => {
          assert.equal(registry.whenIdle('session-1'), undefined);
          observed.push(`settled:${outcome.kind}`);
        },
      }),
      onEvent: (event) => { observed.push(event.type); },
      onStreamError: () => { assert.fail('stream must not fail'); },
      onDrained: () => { observed.push('drained'); },
    });
    const resultPromise = startedCompletion(started);

    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(observed, ['text_delta']);
    release.resolve();
    const result = await resultPromise;

    assert.deepEqual(result, { kind: 'completed', turnId: 'turn-1' });
    assert.deepEqual(observed, ['text_delta', 'complete', 'drained', 'settled:completed']);
  });

  test('coordinator-owned and non-turn streams never notify the external boundary', async (t) => {
    for (const goalBoundary of ['coordinator', 'none'] satisfies SessionGoalBoundary[]) {
      await t.test(goalBoundary, async () => {
        const registry = new SessionActivityRegistry();
        let settlements = 0;
        async function* events(): AsyncIterable<SessionEvent> {
          yield { type: 'complete', id: 'complete', turnId: 'turn-1', ts: 1, stopReason: 'end_turn' };
        }

        const started = startDesktopSessionTurn({
          sessionId: 'session-1',
          events: events(),
          turnId: 'turn-1',
          goalBoundary,
          activities: registry,
          beginObservedTurn: () => {
            settlements++;
            return { kind: 'unavailable', reason: 'unused' };
          },
          onEvent: () => {},
          onStreamError: () => { assert.fail('stream must not fail'); },
          onDrained: () => {},
        });
        const result = await startedCompletion(started);

        assert.equal(result.kind, 'completed');
        assert.equal(settlements, 0);
        assert.equal(registry.whenIdle('session-1'), undefined);
      });
    }
  });

  test('a closed session is rejected before activity reservation or iterator start', () => {
    const manager = new GoalManager({ generateId: () => 'goal', now: () => 1 });
    const coordinator = new GoalContinuationCoordinator({
      goalManager: manager,
      evaluator: { evaluate: async () => assert.fail('closed session must not evaluate') },
      getRecentContext: async () => 'unused',
      admitTurn: () => assert.fail('closed session must not admit a turn'),
    });
    coordinator.beginSessionClose('session-1', 'archive').commit();
    const registry = new SessionActivityRegistry();
    let iteratorStarted = false;
    async function* events(): AsyncIterable<SessionEvent> {
      iteratorStarted = true;
      yield { type: 'complete', id: 'complete', turnId: 'turn-closed', ts: 1, stopReason: 'end_turn' };
    }

    const started = startDesktopSessionTurn({
      sessionId: 'session-1',
      events: events(),
      turnId: 'turn-closed',
      goalBoundary: 'external',
      activities: registry,
      beginObservedTurn: (sessionId, turnId) => coordinator.beginObservedTurn(sessionId, turnId),
      onEvent: () => {},
      onStreamError: () => {},
      onDrained: () => {},
    });

    assert.deepEqual(started, {
      kind: 'unavailable',
      reason: 'Goal continuation session is closed.',
    });
    assert.equal(iteratorStarted, false);
    assert.equal(registry.whenIdle('session-1'), undefined);
  });
});

function startedCompletion(start: DesktopSessionTurnStart) {
  assert.equal(start.kind, 'started');
  return start.completion;
}
