import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import {
  SessionActivityRegistry,
  drainGoalTurn,
  type GoalTurnOutcome,
} from '../goal-turn-lifecycle.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function complete(
  turnId: string,
  stopReason: Extract<SessionEvent, { type: 'complete' }>['stopReason'],
): SessionEvent {
  return { type: 'complete', id: `${turnId}-${stopReason}`, turnId, ts: 1, stopReason };
}

describe('Goal turn lifecycle', () => {
  test('shares one idle generation and supports synchronous or waiting exclusive admission', async () => {
    const registry = new SessionActivityRegistry();
    const first = registry.reserve('session-1');
    const second = registry.reserve('session-1');
    const automation = registry.reserve('session-2');
    const firstIdle = registry.whenIdle('session-1');
    assert.ok(firstIdle);
    assert.equal(registry.reserveIfIdle('session-1'), undefined);
    assert.equal(registry.hasActive(), true);

    let acquired = false;
    const nextPromise = registry.acquire('session-1').then((lease) => {
      acquired = true;
      return lease;
    });
    first.release();
    await Promise.resolve();
    assert.equal(acquired, false);

    second.release();
    const next = await nextPromise;
    assert.equal(acquired, true);
    assert.notEqual(registry.whenIdle('session-1'), firstIdle);

    // A stale duplicate release cannot disturb the new activity generation.
    second.release();
    assert.ok(registry.whenIdle('session-1'));
    next.release();
    assert.equal(registry.whenIdle('session-1'), undefined);
    assert.equal(registry.hasActive(), true);
    automation.release();
    assert.equal(registry.hasActive(), false);
  });

  test('aborts a queued exclusive admission without acquiring after the session becomes idle', async () => {
    const registry = new SessionActivityRegistry();
    const busy = registry.reserve('session-1');
    const controller = new AbortController();
    const queued = registry.acquire('session-1', controller.signal);
    controller.abort();
    await assert.rejects(queued, (error: unknown) => {
      return error instanceof Error && error.name === 'AbortError';
    });
    busy.release();
    assert.equal(registry.whenIdle('session-1'), undefined);
  });

  test('classifies continuation outcomes at the lifecycle boundary', async () => {
    const turnId = 'turn-1';
    const cases: Array<{
      name: string;
      events: SessionEvent[];
      expected: GoalTurnOutcome;
    }> = [
      {
        name: 'clean completion',
        events: [complete(turnId, 'end_turn')],
        expected: { kind: 'completed', turnId },
      },
      {
        name: 'user stop completion',
        events: [complete(turnId, 'user_stop')],
        expected: { kind: 'aborted', turnId },
      },
      {
        name: 'abort event',
        events: [
          {
            type: 'abort',
            id: 'abort-1',
            turnId,
            ts: 1,
            reason: 'user_stop',
          },
        ],
        expected: { kind: 'aborted', turnId },
      },
      {
        name: 'runtime error completion',
        events: [complete(turnId, 'error')],
        expected: { kind: 'errored', turnId, reason: 'Turn ended with runtime_error' },
      },
      {
        name: 'step limit completion',
        events: [complete(turnId, 'step_limit')],
        expected: {
          kind: 'errored',
          turnId,
          reason: 'Turn ended with tool_step_cap_reached',
        },
      },
      {
        name: 'missing terminal event',
        events: [],
        expected: {
          kind: 'errored',
          turnId,
          reason: 'Session turn ended without a completion event',
        },
      },
    ];

    for (const fixture of cases) {
      const events = async function* (): AsyncIterable<SessionEvent> {
        for (const event of fixture.events) yield event;
      };
      assert.deepEqual(
        await drainGoalTurn({ events: events(), turnId }),
        fixture.expected,
        fixture.name,
      );
    }
  });

  test('settles only after a full drain and releases activity before notifying the owner', async () => {
    const registry = new SessionActivityRegistry();
    const lease = registry.reserve('session-1');
    const releaseStream = deferred<void>();
    const firstObserved = deferred<void>();
    const sequence: string[] = [];
    async function* events(): AsyncIterable<SessionEvent> {
      sequence.push('first-event');
      yield {
        type: 'text_delta',
        id: 'delta',
        turnId: 'turn-1',
        ts: 1,
        messageId: 'message-1',
        text: 'working',
      };
      await releaseStream.promise;
      sequence.push('complete-event');
      yield complete('turn-1', 'end_turn');
    }

    const resultPromise = drainGoalTurn({
      events: events(),
      turnId: 'turn-1',
      activity: lease,
      onEvent: (event) => {
        sequence.push(`observed:${event.type}`);
        if (event.type === 'text_delta') firstObserved.resolve();
      },
      onDrained: () => {
        assert.ok(registry.whenIdle('session-1'));
        sequence.push('drained');
      },
      onSettled: () => {
        assert.equal(registry.whenIdle('session-1'), undefined);
        sequence.push('settled');
      },
    });

    await firstObserved.promise;
    assert.deepEqual(sequence, ['first-event', 'observed:text_delta']);
    releaseStream.resolve();
    const result = await resultPromise;

    assert.deepEqual(result, { kind: 'completed', turnId: 'turn-1' });
    assert.deepEqual(sequence, [
      'first-event',
      'observed:text_delta',
      'complete-event',
      'observed:complete',
      'drained',
      'settled',
    ]);
  });

  test('keeps draining from an error event through terminal completion', async () => {
    const registry = new SessionActivityRegistry();
    const releaseStream = deferred<void>();
    const errorObserved = deferred<void>();
    let settled: unknown;
    async function* events(): AsyncIterable<SessionEvent> {
      yield {
        type: 'error',
        id: 'error',
        turnId: 'turn-1',
        ts: 1,
        recoverable: false,
        code: 'provider_error',
        reason: 'provider_error',
        message: 'provider failed',
      };
      await releaseStream.promise;
      yield complete('turn-1', 'error');
    }

    const resultPromise = drainGoalTurn({
      events: events(),
      turnId: 'turn-1',
      activity: registry.reserve('session-1'),
      onEvent: (event) => {
        if (event.type === 'error') errorObserved.resolve();
      },
      onSettled: (outcome) => {
        settled = outcome;
      },
    });

    await errorObserved.promise;
    assert.ok(registry.whenIdle('session-1'));
    assert.equal(settled, undefined);
    releaseStream.resolve();
    const result = await resultPromise;

    assert.deepEqual(result, {
      kind: 'errored',
      turnId: 'turn-1',
      reason: 'provider failed',
    });
    assert.deepEqual(settled, result);
    assert.equal(registry.whenIdle('session-1'), undefined);
  });

  test('keeps draining after an event observer failure before settling the projection error', async () => {
    const registry = new SessionActivityRegistry();
    let settled: unknown;
    const projected: string[] = [];
    let streamDrained = false;
    async function* events(): AsyncIterable<SessionEvent> {
      yield {
        type: 'text_delta',
        id: 'delta',
        turnId: 'turn-1',
        ts: 1,
        messageId: 'message-1',
        text: 'working',
      };
      yield complete('turn-1', 'end_turn');
      streamDrained = true;
    }

    const result = await drainGoalTurn({
      events: events(),
      turnId: 'turn-1',
      activity: registry.reserve('session-1'),
      onEvent: (event) => {
        projected.push(event.type);
        if (event.type === 'text_delta') throw new Error('projection failed');
      },
      onSettled: (outcome) => {
        settled = outcome;
      },
    });

    assert.equal(streamDrained, true);
    assert.deepEqual(projected, ['text_delta', 'complete']);
    assert.deepEqual(result, {
      kind: 'errored',
      turnId: 'turn-1',
      reason: 'projection failed',
    });
    assert.deepEqual(settled, result);
    assert.equal(registry.whenIdle('session-1'), undefined);
  });
});
