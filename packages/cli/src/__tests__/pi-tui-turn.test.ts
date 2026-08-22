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
import { describe, test } from 'node:test';
import type { SessionEvent } from '@maka/core/events';
import { SessionActivityRegistry } from '@maka/runtime/goal-turn-lifecycle';
import { runMakaPiTuiTurn } from '../pi-tui-turn.js';

describe('Maka Pi TUI turn', () => {
  test('prepares and drains an external turn under one Session activity lease', async () => {
    const activities = new SessionActivityRegistry();
    const sequence: string[] = [];

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
      turnActivity: { activities },
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
    assert.deepEqual(sequence, ['start', 'prepare', 'event:text_delta', 'event:complete']);
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
      turnActivity: { activities },
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

    const outcome = await runMakaPiTuiTurn({
      driver: {
        async preparePrompt() {
          assert.ok(activities.whenIdle('session-1'));
          throw new Error('prepare failed');
        },
      },
      turnActivity: { activities },
      request: { kind: 'external', prompt: 'hello', sessionId: 'session-1' },
      shouldAbort: () => false,
      onFailure: (error) => {
        failures.push(errorMessage(error));
      },
    });

    assert.deepEqual(outcome, { kind: 'errored', reason: 'prepare failed' });
    assert.deepEqual(failures, ['prepare failed']);
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
