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
  test('drains an attached turn under one Session activity lease', async () => {
    const activities = new SessionActivityRegistry();
    const sequence: string[] = [];

    const outcome = await runMakaPiTuiTurn({
      turnActivity: { activities },
      request: {
        turn: preparedTurn([
          event({ type: 'text_delta', messageId: 'message-1', text: 'working' }),
          event({ type: 'complete', stopReason: 'end_turn' }),
        ]),
      },
      shouldAbort: () => false,
      onStart: () => sequence.push('start'),
      onEvent: (sessionEvent) => {
        sequence.push(`event:${sessionEvent.type}`);
      },
    });

    assert.deepEqual(outcome, { kind: 'completed', turnId: 'turn-1' });
    assert.deepEqual(sequence, ['start', 'event:text_delta', 'event:complete']);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });

  test('projects an EOF without a terminal event exactly once', async () => {
    const activities = new SessionActivityRegistry();
    const failures: string[] = [];

    const outcome = await runMakaPiTuiTurn({
      turnActivity: { activities },
      request: { turn: preparedTurn([]) },
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

  test('releases the Session activity when the attached stream fails', async () => {
    const activities = new SessionActivityRegistry();
    const failures: string[] = [];

    const outcome = await runMakaPiTuiTurn({
      turnActivity: { activities },
      request: {
        turn: {
          sessionId: 'session-1',
          turnId: 'turn-1',
          events: failingEvents('stream failed'),
        },
      },
      shouldAbort: () => false,
      onFailure: (error) => {
        failures.push(errorMessage(error));
      },
    });

    assert.deepEqual(outcome, { kind: 'errored', turnId: 'turn-1', reason: 'stream failed' });
    assert.deepEqual(failures, ['stream failed']);
    assert.equal(activities.whenIdle('session-1'), undefined);
  });
});

async function* failingEvents(reason: string): AsyncIterable<SessionEvent> {
  await Promise.resolve();
  throw new Error(reason);
}

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
