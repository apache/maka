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
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type {
  ModelCallAttempt,
  PreparedRequestObservation,
  PreparedRequestObservationSegment,
} from '@maka/core/model-call-attempt';
import type { AgentRunEvent, AgentRunHeader } from '@maka/core/agent-run';
import {
  deriveAttemptRequestPreservation,
  deriveRequestPreservation,
} from '../request-preservation.js';

test('keeps every earlier cacheable segment when the current request only appends', () => {
  const previous = observation([message(0, 'system'), message(1, 'user-1')]);
  const current = observation([
    message(0, 'system'),
    message(1, 'user-1'),
    message(2, 'assistant-1'),
  ]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'preserved',
    previousSegmentCount: 2,
    preservedSegmentCount: 2,
  });
});

test('does not treat opaque digests as evidence of divergence', () => {
  const previous = observation([{ ...message(0, 'redacted-a'), comparison: 'opaque' }]);
  const current = observation([{ ...message(0, 'redacted-b'), comparison: 'opaque' }]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'unknown',
    previousSegmentCount: 1,
    preservedSegmentCount: 0,
  });
});

test('reports the first changed earlier segment', () => {
  const previous = observation([message(0, 'system'), message(1, 'user-1')]);
  const current = observation([message(0, 'system'), message(1, 'edited-user-1')]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'diverged',
    previousSegmentCount: 2,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 1 },
  });
});

test('reports the first removed earlier segment', () => {
  const previous = observation([message(0, 'system'), message(1, 'user-1')]);
  const current = observation([message(0, 'system')]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'diverged',
    previousSegmentCount: 2,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 1 },
  });
});

test('reports the current segment at the first middle deletion', () => {
  const previous = observation([
    message(0, 'system'),
    message(1, 'user-1'),
    message(2, 'assistant-1'),
  ]);
  const current = observation([message(0, 'system'), message(2, 'assistant-1')]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'diverged',
    previousSegmentCount: 3,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 2 },
  });
});

test('reports an inserted segment as the first divergence', () => {
  const previous = observation([message(0, 'system'), message(2, 'assistant-1')]);
  const current = observation([
    message(0, 'system'),
    message(1, 'inserted-user'),
    message(2, 'assistant-1'),
  ]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'diverged',
    previousSegmentCount: 2,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 1 },
  });
});

test('reports the first moved segment after a reorder', () => {
  const previous = observation([
    message(0, 'system'),
    message(1, 'user-1'),
    message(2, 'assistant-1'),
  ]);
  const current = observation([
    message(0, 'system'),
    message(2, 'assistant-1'),
    message(1, 'user-1'),
  ]);

  assert.deepEqual(deriveRequestPreservation(current, previous), {
    status: 'diverged',
    previousSegmentCount: 3,
    preservedSegmentCount: 1,
    firstDivergentSegment: { kind: 'message', index: 2 },
  });
});

test('uses the preceding physical retry as its durable baseline', async () => {
  const previous = attempt({ attemptId: 'attempt-0', attempt: 0 });
  const current = attempt({ attemptId: 'attempt-1', attempt: 1 });
  assert.equal(
    await statusOf(current, [run('run-1', 'turn-1', PROVIDER_STATE)], [previous]),
    'preserved',
  );
});

test('does not compare across provider execution identities', async () => {
  const previous = attempt({ attemptId: 'previous', runId: 'run-1', turnId: 'turn-1' });
  const current = attempt({ attemptId: 'current', runId: 'run-2', turnId: 'turn-2' });

  assert.equal(
    await statusOf(
      current,
      [run('run-1', 'turn-1', OTHER_PROVIDER_STATE), run('run-2', 'turn-2', PROVIDER_STATE)],
      [previous],
      { runId: 'run-2', previousRootTurnId: 'turn-1' },
    ),
    'unavailable',
  );
});

test('does not compare attempts whose connection identity is missing', async () => {
  const previous = attempt({ attemptId: 'previous', runId: 'run-1', turnId: 'turn-1' });
  const current = attempt({
    attemptId: 'current',
    runId: 'run-2',
    turnId: 'turn-2',
    connectionSlug: undefined,
  });
  previous.connectionSlug = undefined;

  assert.equal(
    await statusOf(
      current,
      [run('run-1', 'turn-1', PROVIDER_STATE), run('run-2', 'turn-2', PROVIDER_STATE)],
      [previous],
      { runId: 'run-2', previousRootTurnId: 'turn-1' },
    ),
    'unavailable',
  );
});

test('does not use an attempt whose durable turn disagrees with its run', async () => {
  const previous = attempt({ attemptId: 'previous', runId: 'run-1', turnId: 'wrong-turn' });
  const current = attempt({ attemptId: 'current', runId: 'run-2', turnId: 'turn-2' });

  assert.equal(
    await statusOf(
      current,
      [run('run-1', 'turn-1', PROVIDER_STATE), run('run-2', 'turn-2', PROVIDER_STATE)],
      [previous],
      { runId: 'run-2', previousRootTurnId: 'turn-1' },
    ),
    'unavailable',
  );
});

test('does not choose between overlapping durable predecessor runs', async () => {
  const current = attempt({ attemptId: 'current', runId: 'run-3', turnId: 'turn-2' });
  const headers = [
    run('run-1', 'turn-1', PROVIDER_STATE),
    run('run-2', 'turn-1', PROVIDER_STATE),
    run('run-3', 'turn-2', PROVIDER_STATE),
  ];

  assert.equal(
    await statusOf(
      current,
      headers,
      [
        attempt({ attemptId: 'previous-1', runId: 'run-1', turnId: 'turn-1' }),
        attempt({ attemptId: 'previous-2', runId: 'run-2', turnId: 'turn-1' }),
      ],
      { runId: 'run-3', previousRootTurnId: 'turn-1' },
    ),
    'unavailable',
  );
});

test('uses the unique continuation tip for the previous root turn', async () => {
  const previous = attempt({ attemptId: 'continued', runId: 'run-2', turnId: 'turn-1' });
  const current = attempt({ attemptId: 'current', runId: 'run-3', turnId: 'turn-2' });

  assert.equal(
    await statusOf(
      current,
      [
        run('run-1', 'turn-1', PROVIDER_STATE),
        run('run-2', 'turn-1', PROVIDER_STATE, {
          parentRunId: 'run-1',
          continuationSource: continuationSource('run-1'),
        }),
        run('run-3', 'turn-2', PROVIDER_STATE),
      ],
      [previous],
      { runId: 'run-3', previousRootTurnId: 'turn-1' },
    ),
    'preserved',
  );
});

test('compares later local turns without inheriting a copied session baseline', async () => {
  const previous = attempt({ attemptId: 'local-1', runId: 'run-1', turnId: 'turn-1' });
  const current = attempt({ attemptId: 'local-2', runId: 'run-2', turnId: 'turn-2' });
  const runs = [
    run('copied-run', 'copied-turn', PROVIDER_STATE),
    run('run-1', 'turn-1', PROVIDER_STATE),
    run('run-2', 'turn-2', PROVIDER_STATE),
  ];

  assert.equal(
    await statusOf(previous, runs, [], { runId: 'run-1', previousRootTurnId: null }),
    'unavailable',
  );

  assert.equal(
    await statusOf(current, runs, [previous], {
      runId: 'run-2',
      previousRootTurnId: 'turn-1',
    }),
    'preserved',
  );
});

test('does not compare a child run against its parent session run', async () => {
  const previous = attempt({ attemptId: 'parent-attempt', runId: 'run-parent' });
  const current = attempt({ attemptId: 'child-attempt', runId: 'run-child' });
  assert.equal(
    await statusOf(
      current,
      [
        run('run-parent', 'turn-1', PROVIDER_STATE),
        run('run-child', 'turn-1', PROVIDER_STATE, { parentRunId: 'run-parent' }),
      ],
      [previous],
    ),
    'unavailable',
  );
});

async function statusOf(
  current: ModelCallAttempt,
  runs: AgentRunHeader[],
  attempts: ModelCallAttempt[],
  admission?: { runId: string; previousRootTurnId: string | null },
) {
  return (
    await deriveAttemptRequestPreservation({
      current,
      store: preservationStore(runs, attempts, admission),
    })
  ).status;
}

function observation(segments: PreparedRequestObservationSegment[]): PreparedRequestObservation {
  return {
    schemaVersion: 1,
    digest: digestFor(segments.map((segment) => segment.digest).join(':')),
    bytes: 1,
    segments,
  };
}

function message(index: number, digest: string): PreparedRequestObservationSegment {
  return {
    kind: 'message',
    index,
    cacheable: true,
    comparison: 'exact',
    digest: digestFor(digest),
    bytes: 1,
  };
}

function digestFor(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

const PROVIDER_STATE = `sha256:${'1'.repeat(64)}` as const;
const OTHER_PROVIDER_STATE = `sha256:${'2'.repeat(64)}` as const;

function attempt(overrides: Partial<ModelCallAttempt>): ModelCallAttempt {
  return {
    schemaVersion: 1,
    logicalCallId: 'logical-1',
    attemptId: 'attempt-0',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    connectionSlug: 'connection',
    providerId: 'anthropic',
    modelId: 'model',
    requestObservation: observation([message(0, 'same')]),
    startedAt: 1,
    completedAt: 2,
    latencyMs: 1,
    status: 'completed',
    usageBasis: 'missing',
    costBasis: 'unpriced',
    ...overrides,
  };
}

function run(
  runId: string,
  turnId: string,
  providerStateIdentity: `sha256:${string}`,
  overrides: Partial<AgentRunHeader> = {},
): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId,
    status: 'completed',
    backendKind: 'ai-sdk',
    providerStateIdentity,
    llmConnectionSlug: 'connection',
    modelId: 'model',
    cwd: '/repo',
    permissionMode: 'ask',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function continuationSource(
  sourceRunId: string,
): NonNullable<AgentRunHeader['continuationSource']> {
  return {
    sourceInvocationId: sourceRunId,
    sourceRunId,
    sourceTurnId: 'turn-1',
    sourceRuntimeEventHighWater: 1,
  };
}

function preservationStore(
  runs: AgentRunHeader[],
  attempts: ModelCallAttempt[],
  admission?: { runId: string; previousRootTurnId: string | null },
) {
  return {
    listSessionRuns: async () => runs,
    readEvents: async (_sessionId: string, runId: string) =>
      attempts.filter((item) => item.runId === runId).map(attemptEvent),
    readRootTurnAdmission: async () => admission,
  };
}

function attemptEvent(attempt: ModelCallAttempt): AgentRunEvent {
  return {
    type: 'model_call_attempt_recorded',
    id: attempt.attemptId,
    runId: attempt.runId,
    sessionId: attempt.sessionId,
    turnId: attempt.turnId,
    ts: attempt.completedAt,
    data: { ...attempt },
  };
}
