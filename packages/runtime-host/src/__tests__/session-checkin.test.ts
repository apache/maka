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
import { test } from 'node:test';
import type { StoredMessage, TurnRecord } from '@maka/core/session';
import type { CheckinSessionState } from '@maka/runtime/session-checkin';
import {
  decodeSessionCheckinGenerateInput,
  decodeSessionCheckinGenerateResult,
  HOST_OPERATION_SPECS,
  REMOTE_OWNER_OPERATION_GRANTS,
  type SessionCatalogProjection,
} from '../protocol/index.js';
import {
  checkinMayRead,
  checkinSessionState,
  HostSessionCheckinCoordinator,
  listCheckinCatalogSessions,
  type HostSessionCheckinPorts,
} from '../server/session-checkin.js';
import type { ConnectionContext, OperationResidency } from '../server/operation-dispatcher.js';

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

function context(): ConnectionContext & { residencies: number } {
  const value = {
    residencies: 0,
    acquireResidency() {
      value.residencies += 1;
      return { release() {} } as OperationResidency;
    },
  };
  return value as unknown as ConnectionContext & { residencies: number };
}

function catalogRow(overrides: Partial<SessionCatalogProjection> & { id: string }) {
  return {
    revision: 7,
    name: `Session ${overrides.id}`,
    activityAt: NOW - HOUR,
    isArchived: false,
    labels: [],
    status: 'active',
    backend: 'ai-sdk',
    ...overrides,
  } as unknown as SessionCatalogProjection;
}

function failedState(sessionId: string): CheckinSessionState {
  return {
    sessionId,
    revision: 7,
    name: `Session ${sessionId}`,
    activityAt: NOW - HOUR,
    lastTurn: { status: 'failed', failureClass: 'runtime_error' },
    waitingForUser: false,
    goal: null,
    todos: [],
    messages: [{ role: 'user', text: 'Migrate the settings store.' }],
  };
}

const RESUME_CARD = JSON.stringify({
  cards: [
    {
      sessionRef: 's1',
      title: 'Finish the migration',
      evidence: { source: 'signal', quote: 'The last run failed (runtime_error).' },
      action: 'resume',
    },
  ],
});

function ports(overrides: Partial<HostSessionCheckinPorts> = {}) {
  const calls = { generate: 0, prompts: [] as string[] };
  const value: HostSessionCheckinPorts = {
    allowed: async () => true,
    listSessions: async () => [catalogRow({ id: 'a' })],
    readSession: async (session) => failedState(session.id),
    readModelTarget: async () => ({ llmConnectionSlug: 'c', model: 'm' }),
    generate: async ({ prompt }) => {
      calls.generate += 1;
      calls.prompts.push(prompt);
      return { ok: true, text: RESUME_CARD };
    },
    now: () => NOW,
    ...overrides,
  };
  return { value, calls };
}

test('check-in is one ready command that a remote owner may call', () => {
  const spec = HOST_OPERATION_SPECS['session.checkin.generate'];
  assert.equal(spec.mode, 'command');
  assert.equal(spec.availability, 'ready');
  assert.ok(REMOTE_OWNER_OPERATION_GRANTS.includes('session.checkin.generate'));
});

test('check-in decoding is strict about effect identity and card shape', () => {
  assert.deepEqual(decodeSessionCheckinGenerateInput({ effectId: 'effect-1', since: null }), {
    effectId: 'effect-1',
    since: null,
  });
  assert.throws(() => decodeSessionCheckinGenerateInput({ effectId: 'effect-1' }));
  assert.throws(() => decodeSessionCheckinGenerateInput({ effectId: 'effect-1', since: -1 }));

  const card = {
    sessionId: 'a',
    sessionRevision: 7,
    sessionName: 'Session a',
    title: 'Finish the migration',
    evidence: { source: 'signal', quote: 'The last run failed.' },
    action: 'resume',
  };
  assert.deepEqual(
    decodeSessionCheckinGenerateResult({
      kind: 'generated',
      effectId: 'e',
      cards: [card],
      dropped: 2,
    }),
    { kind: 'generated', effectId: 'e', cards: [card], dropped: 2 },
  );
  assert.deepEqual(decodeSessionCheckinGenerateResult({ kind: 'empty', effectId: 'e' }), {
    kind: 'empty',
    effectId: 'e',
  });
  for (const bad of [
    { kind: 'generated', effectId: 'e', cards: [{ ...card, action: 'delete' }], dropped: 0 },
    { kind: 'generated', effectId: 'e', cards: [{ ...card, title: 'x'.repeat(81) }], dropped: 0 },
    { kind: 'generated', effectId: 'e', cards: Array(5).fill(card), dropped: 0 },
    { kind: 'failed', effectId: 'e', errorClass: 'persistence' },
  ]) {
    assert.throws(() => decodeSessionCheckinGenerateResult(bad));
  }
});

test('check-in makes no model call when nothing qualifies or privacy forbids it', async () => {
  const quiet = {
    readSession: async (session: SessionCatalogProjection) => ({
      ...failedState(session.id),
      lastTurn: { status: 'completed' as const },
    }),
  };
  for (const [override, since] of [
    [{ allowed: async () => false }, null],
    [{ listSessions: async () => [catalogRow({ id: 'a', isArchived: true })] }, null],
    // A quiet Session with nothing new since the last check-in.
    [quiet, NOW],
  ] as const) {
    const { value, calls } = ports(override);
    const coordinator = new HostSessionCheckinCoordinator(value);
    const outcome = await coordinator.generate({ effectId: 'e1', since }, context());
    assert.deepEqual(outcome, { ok: true, result: { kind: 'empty', effectId: 'e1' } });
    assert.equal(calls.generate, 0);
  }
});

test('check-in returns validated cards and pays once per effect identity', async () => {
  const { value, calls } = ports();
  const coordinator = new HostSessionCheckinCoordinator(value);
  const first = coordinator.generate({ effectId: 'e1', since: null }, context());
  const again = coordinator.generate({ effectId: 'e1', since: null }, context());
  assert.equal(first, again);
  assert.deepEqual(await first, {
    ok: true,
    result: {
      kind: 'generated',
      effectId: 'e1',
      cards: [
        {
          sessionId: 'a',
          sessionRevision: 7,
          sessionName: 'Session a',
          title: 'Finish the migration',
          evidence: { source: 'signal', quote: 'The last run failed (runtime_error).' },
          action: 'resume',
        },
      ],
      dropped: 0,
    },
  });
  assert.equal(calls.generate, 1);
  assert.match(calls.prompts[0]!, /\[s1\] Session a/);

  const conflict = await coordinator.generate({ effectId: 'e1', since: NOW }, context());
  assert.equal(conflict.ok, false);
  assert.equal(!conflict.ok && conflict.error.code, 'operation_conflict');
});

test('check-in reports model and configuration failures without cards', async () => {
  // With no default model nothing is listed or read, and nothing is paid for.
  let listed = 0;
  const noModel = ports({
    readModelTarget: async () => undefined,
    listSessions: async () => {
      listed += 1;
      return [catalogRow({ id: 'a' })];
    },
  });
  assert.deepEqual(
    await new HostSessionCheckinCoordinator(noModel.value).generate(
      { effectId: 'e1', since: null },
      context(),
    ),
    { ok: true, result: { kind: 'failed', effectId: 'e1', errorClass: 'configuration' } },
  );
  assert.equal(listed, 0);
  assert.equal(noModel.calls.generate, 0);

  const prose = new HostSessionCheckinCoordinator(
    ports({ generate: async () => ({ ok: true, text: 'Nothing is left to do.' }) }).value,
  );
  assert.deepEqual(await prose.generate({ effectId: 'e2', since: null }, context()), {
    ok: true,
    result: { kind: 'failed', effectId: 'e2', errorClass: 'invalid_response' },
  });

  const provider = new HostSessionCheckinCoordinator(
    ports({ generate: async () => ({ ok: false, errorClass: 'provider' }) }).value,
  );
  assert.deepEqual(await provider.generate({ effectId: 'e3', since: null }, context()), {
    ok: true,
    result: { kind: 'failed', effectId: 'e3', errorClass: 'provider' },
  });
});

test('a check-in that can read no Session fails instead of finding nothing to do', async () => {
  const unreadable = async (): Promise<CheckinSessionState> => {
    throw new Error('Cannot enter Session admission from an active admission');
  };
  const { value, calls } = ports({ readSession: unreadable });
  const coordinator = new HostSessionCheckinCoordinator(value);
  assert.deepEqual(await coordinator.generate({ effectId: 'e1', since: null }, context()), {
    ok: true,
    result: { kind: 'failed', effectId: 'e1', errorClass: 'unknown' },
  });
  assert.equal(calls.generate, 0);

  // One unreadable Session is skipped and the rest still check in.
  const partly = ports({
    listSessions: async () => [catalogRow({ id: 'a' }), catalogRow({ id: 'b' })],
    readSession: async (session) => (session.id === 'b' ? unreadable() : failedState(session.id)),
  });
  const outcome = await new HostSessionCheckinCoordinator(partly.value).generate(
    { effectId: 'e2', since: null },
    context(),
  );
  assert.equal(outcome.ok && outcome.result.kind, 'generated');
  assert.equal(partly.calls.generate, 1);
});

test('a draining Host refuses new check-ins', async () => {
  const coordinator = new HostSessionCheckinCoordinator(ports().value);
  await coordinator.close();
  const outcome = await coordinator.generate({ effectId: 'e1', since: null }, context());
  assert.equal(!outcome.ok && outcome.error.code, 'host_draining');
});

test('the catalog row alone rules out Sessions check-in never reads', () => {
  assert.equal(checkinMayRead(catalogRow({ id: 'a' }), NOW), true);
  for (const row of [
    catalogRow({ id: 'archived', isArchived: true }),
    catalogRow({ id: 'child', parentSessionId: 'a' }),
    catalogRow({ id: 'plugin', backend: 'plugin-executor' }),
    catalogRow({ id: 'running', status: 'running' }),
    catalogRow({ id: 'side', labels: ['mode:side_conversation'] }),
    catalogRow({ id: 'maka_workhub_coordination' }),
    catalogRow({ id: 'old', activityAt: NOW - 8 * 24 * HOUR }),
  ]) {
    assert.equal(checkinMayRead(row, NOW), false, row.id);
  }
});

test('catalog listing follows cursors and skips legacy rows', async () => {
  const inputs: unknown[] = [];
  const sessions = await listCheckinCatalogSessions(async (input) => {
    inputs.push(input);
    return input.kind === 'list_start'
      ? {
          ok: true,
          result: {
            kind: 'page',
            revision: 'sha256:r',
            sessions: [
              catalogRow({ id: 'a' }),
              {
                kind: 'unsupported_legacy_record',
                id: 'old',
                revision: 1,
                reason: 'not_wire_representable',
              },
            ],
            nextCursor: 'c1',
          },
        }
      : {
          ok: true,
          result: {
            kind: 'page',
            revision: 'sha256:r',
            sessions: [catalogRow({ id: 'b' })],
            nextCursor: null,
          },
        };
  });
  assert.deepEqual(
    sessions.map((session) => session.id),
    ['a', 'b'],
  );
  assert.deepEqual(inputs[1], { kind: 'list_continue', revision: 'sha256:r', cursor: 'c1' });
});

test('Session state maps turns, waits, Goals and user-typed text', () => {
  const messages = [
    { type: 'user', text: 'Original request', id: 'u1', ts: 1, turnId: 't1' },
    { type: 'assistant', text: 'Reply', id: 'a1', ts: 2, turnId: 't1' },
    {
      type: 'user',
      text: 'Scheduled wake',
      id: 'u2',
      ts: 3,
      turnId: 't2',
      origin: { kind: 'scheduled_task', scheduledTaskId: 'x' },
    },
    { type: 'tool_result', content: 'secret' },
  ] as unknown as StoredMessage[];
  const base = {
    session: catalogRow({ id: 'a' }),
    todos: [{ content: 'Write tests', status: 'pending' as const }],
    messages,
    turns: [],
  };

  const failed = checkinSessionState({
    ...base,
    canonical: {
      rootTurn: {
        sessionId: 'a',
        turnId: 't1',
        runId: 'r1',
        status: 'failed',
        terminalEventId: 'e1',
        failureClass: 'runtime_error',
        failureMessage: 'boom',
      },
      goal: { status: 'stalled', condition: 'Tests pass', lastReason: 'No progress' } as never,
      interactions: { pending: [] } as never,
    },
  });
  assert.deepEqual(failed.lastTurn, {
    status: 'failed',
    failureClass: 'runtime_error',
    failureMessage: 'boom',
  });
  assert.equal(failed.waitingForUser, false);
  assert.deepEqual(failed.goal, {
    status: 'stalled',
    condition: 'Tests pass',
    lastReason: 'No progress',
  });
  assert.deepEqual(failed.messages, [
    { role: 'user', text: 'Original request' },
    { role: 'assistant', text: 'Reply' },
  ]);

  const waiting = checkinSessionState({
    ...base,
    canonical: {
      rootTurn: { sessionId: 'a', turnId: 't1', runId: 'r1', status: 'running' },
      goal: null,
      interactions: { pending: [{}] } as never,
    },
  });
  assert.equal(waiting.waitingForUser, true);
  assert.equal(waiting.lastTurn, null);

  const running = checkinSessionState({
    ...base,
    canonical: {
      rootTurn: { sessionId: 'a', turnId: 't1', runId: 'r1', status: 'running' },
      goal: null,
      interactions: { pending: [] } as never,
    },
  });
  assert.deepEqual(running.lastTurn, { status: 'in_progress' });
});

test('without a root Turn admission, only a recorded Turn status counts', () => {
  const base = {
    session: catalogRow({ id: 'a' }),
    canonical: { rootTurn: null, goal: null, interactions: { pending: [] } as never },
    todos: [],
    messages: [],
  };
  const turn = (overrides: Partial<TurnRecord>): TurnRecord => ({
    turnId: 't1',
    status: 'completed',
    statusSource: 'recorded',
    ...overrides,
  });
  assert.deepEqual(
    checkinSessionState({
      ...base,
      turns: [
        turn({ status: 'failed', errorClass: 'tool_step_cap_reached', failureMessage: 'limit' }),
      ],
    }).lastTurn,
    { status: 'failed', failureClass: 'tool_step_cap_reached', failureMessage: 'limit' },
  );
  assert.deepEqual(
    checkinSessionState({ ...base, turns: [turn({ status: 'aborted', abortSource: 'host' })] })
      .lastTurn,
    { status: 'cancelled', abortSource: 'host' },
  );
  assert.equal(
    checkinSessionState({ ...base, turns: [turn({ status: 'failed', statusSource: 'inferred' })] })
      .lastTurn,
    null,
  );
  assert.equal(checkinSessionState({ ...base, turns: [] }).lastTurn, null);
});
