import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core';
import { SessionActivityRegistry, type GoalTurnOutcome } from '@maka/runtime';
import { runMakaPiTuiTurn } from '../pi-tui-turn.js';

describe('Maka Pi TUI turn', () => {
  test('prepares, projects, and settles an external turn after releasing activity', async () => {
    const activities = new SessionActivityRegistry();
    const sequence: string[] = [];
    const settled: GoalTurnOutcome[] = [];

    const outcome = await runMakaPiTuiTurn({
      driver: {
        async preparePrompt(prompt, options) {
          sequence.push('prepare');
          assert.equal(prompt, 'visible prompt');
          assert.deepEqual(options, {
            modelText: 'expanded prompt',
            turnOrchestration: { mode: 'swarm', source: 'slash_command' },
          });
          return preparedTurn([
            event({
              type: 'text_delta',
              messageId: 'message-1',
              text: 'working',
            }),
            event({ type: 'complete', stopReason: 'end_turn' }),
          ]);
        },
      },
      lifecycle: {
        activities,
        beginObservedTurn: (sessionId, turnId) => {
          sequence.push('register');
          assert.equal(sessionId, 'session-1');
          assert.equal(turnId, 'turn-1');
          assert.ok(activities.whenIdle(sessionId));
          return {
            kind: 'registered',
            settle: (settledOutcome) => {
              assert.equal(activities.whenIdle(sessionId), undefined);
              sequence.push('settle');
              settled.push(settledOutcome);
              return Promise.resolve();
            },
          };
        },
      },
      request: {
        kind: 'external',
        prompt: 'visible prompt',
        sendText: 'expanded prompt',
        sessionId: null,
        turnOrchestration: { mode: 'swarm', source: 'slash_command' },
      },
      shouldAbort: () => false,
      onStart: () => {
        sequence.push('start');
      },
      onEvent: (sessionEvent) => {
        sequence.push(`event:${sessionEvent.type}`);
      },
    });

    assert.deepEqual(outcome, { kind: 'completed', turnId: 'turn-1' });
    assert.deepEqual(settled, [outcome]);
    assert.deepEqual(sequence, [
      'start',
      'prepare',
      'register',
      'event:text_delta',
      'event:complete',
      'settle',
    ]);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });

  test('projects an EOF without a terminal event exactly once', async () => {
    const activities = new SessionActivityRegistry();
    const failures: string[] = [];

    const outcome = await runMakaPiTuiTurn({
      driver: {
        async preparePrompt() {
          return preparedTurn([]);
        },
      },
      lifecycle: {
        activities,
        beginObservedTurn: () => ({
          kind: 'registered',
          settle: async () => {},
        }),
      },
      request: { kind: 'external', prompt: 'hello', sessionId: null },
      shouldAbort: () => false,
      onFailure: (error) => {
        failures.push(errorMessage(error));
      },
    });

    assert.deepEqual(outcome, {
      kind: 'errored',
      turnId: 'turn-1',
      reason: 'Session turn ended without a completion event',
    });
    assert.deepEqual(failures, ['Session turn ended without a completion event']);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });

  test('releases existing-session activity when preparation fails', async () => {
    const activities = new SessionActivityRegistry();
    const failures: string[] = [];
    let registrations = 0;

    const outcome = await runMakaPiTuiTurn({
      driver: {
        async preparePrompt() {
          assert.ok(activities.whenIdle('session-1'));
          throw new Error('prepare failed');
        },
      },
      lifecycle: {
        activities,
        beginObservedTurn: () => {
          registrations++;
          return {
            kind: 'registered',
            settle: async () => {},
          };
        },
      },
      request: { kind: 'external', prompt: 'hello', sessionId: 'session-1' },
      shouldAbort: () => false,
      onFailure: (error) => {
        failures.push(errorMessage(error));
      },
    });

    assert.deepEqual(outcome, { kind: 'errored', reason: 'prepare failed' });
    assert.deepEqual(failures, ['prepare failed']);
    assert.equal(registrations, 0);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });
});

function preparedTurn(events: readonly SessionEvent[]) {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    events: replayEvents(events),
  };
}

async function* replayEvents(events: readonly SessionEvent[]): AsyncIterable<SessionEvent> {
  for (const sessionEvent of events) yield sessionEvent;
}

function event(input: { type: SessionEvent['type'] } & Record<string, unknown>): SessionEvent {
  return {
    id: `${input.type}-id`,
    turnId: 'turn-1',
    ts: 1,
    ...input,
  } as SessionEvent;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
