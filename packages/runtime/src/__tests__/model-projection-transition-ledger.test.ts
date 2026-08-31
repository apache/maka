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

import type { AgentRunEvent, AgentRunHeader } from '@maka/core/agent-run';
import {
  buildModelProjectionTransition,
  durableToolResultProjectionDigest,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import type { RuntimeEvent } from '@maka/core/runtime-event';

import {
  baseToolResultProjection,
  loadModelProjectionTransitionsFromRunLedger,
  reduceEffectiveModelProjections,
} from '../model-projection-transition-ledger.js';
import {
  archiveToolResultAsTransition,
  archivedToolResultProjection,
  collectReachableArchiveArtifactIds,
  collectStaleToolResultArchiveCandidates,
  serializedToolResultProjection,
} from '../tool-result-archive-transition.js';
import {
  buildArchivedToolResultPlaceholder,
  isArchivedToolResultPlaceholder,
} from '../tool-result-archive.js';
import { sha256 } from '../context-budget-helpers.js';

const SECRET = 'SECRET_TOOL_RESULT_BODY';

function toolResultEvent(
  id: string,
  turnId: string,
  result: unknown,
  overrides: Partial<RuntimeEvent> = {},
): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    ts: 1,
    partial: false,
    role: 'tool',
    author: 'tool',
    modelVisibility: 'visible',
    content: { kind: 'function_response', id: 'tool-1', name: 'Read', result },
    ...overrides,
  } as RuntimeEvent;
}

function archiveTransition(
  event: RuntimeEvent,
  options: {
    artifactId?: string;
    highWaterSeq?: number;
    previousTransitionId?: string;
    sourceProjection?: ReturnType<typeof baseToolResultProjection>;
  } = {},
): ModelProjectionTransition {
  const sourceProjection = options.sourceProjection ?? baseToolResultProjection(event)!;
  const serialized = serializedToolResultProjection(sourceProjection);
  const artifactId = options.artifactId ?? `artifact-${event.id}`;
  const placeholder = buildArchivedToolResultPlaceholder({
    artifactId,
    runtimeEventId: event.id,
    toolCallId: 'tool-1',
    toolName: 'Read',
    bodySha256: sha256(serialized),
    originalEstimatedTokens: serialized.length,
    originalBytes: serialized.length,
    reason: 'stale_tool_result_pruned_before_compact',
  });
  return buildModelProjectionTransition({
    sessionId: 'session-1',
    target: {
      runtimeEventId: event.id,
      part: 'tool_result',
      toolCallId: 'tool-1',
      toolName: 'Read',
    },
    sourceProjection,
    replacement: archivedToolResultProjection(placeholder),
    archive: {
      artifactId,
      bodySha256: sha256(serialized),
      originalBytes: serialized.length,
      originalEstimatedTokens: serialized.length,
    },
    reason: 'stale_tool_result_archived',
    ...(options.previousTransitionId ? { previousTransitionId: options.previousTransitionId } : {}),
    highWaterSeq: options.highWaterSeq ?? 10,
    now: 100,
  });
}

function serializedEffective(events: readonly RuntimeEvent[]): string {
  return JSON.stringify(events);
}

describe('effective model projection reduction', () => {
  test('replaces the projection and the legacy result together', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const transition = archiveTransition(event);

    const reduced = reduceEffectiveModelProjections([event], [transition]);

    assert.equal(reduced.applied.length, 1);
    assert.equal(reduced.rejected.length, 0);
    const [effective] = reduced.events;
    assert.ok(effective?.content?.kind === 'function_response');
    assert.ok(isArchivedToolResultPlaceholder(effective.content.result));
    assert.deepEqual(effective.content.modelProjection, transition.replacement);
    assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
  });

  test('reduces identically on the next Turn and after a cold restart', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const transition = archiveTransition(event);

    // Next Turn: the same ledger read, more events after it.
    const nextTurn = reduceEffectiveModelProjections(
      [event, toolResultEvent('rt-2', 'turn-2', { body: 'later' })],
      [transition],
    );
    // Cold restart: the ledger is all the process has.
    const restart = reduceEffectiveModelProjections([event], [transition]);

    assert.deepEqual(nextTurn.events[0], restart.events[0]);
    assert.equal(serializedEffective(nextTurn.events).includes(SECRET), false);
  });

  test('refuses a stale concurrent writer instead of restoring its source', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const first = archiveTransition(event, { artifactId: 'artifact-a', highWaterSeq: 10 });
    // A second Turn that never saw `first` decides against the same source.
    const stale = archiveTransition(event, { artifactId: 'artifact-b', highWaterSeq: 20 });

    const reduced = reduceEffectiveModelProjections([event], [first, stale]);

    assert.deepEqual(
      reduced.applied.map((transition) => transition.transitionId),
      [first.transitionId],
    );
    assert.deepEqual(
      reduced.rejected.map((transition) => transition.transitionId),
      [stale.transitionId],
    );
    assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
    assert.deepEqual([...reduced.reachableArchiveArtifactIds], ['artifact-a']);
  });

  test('orders concurrent Turns deterministically regardless of ledger arrival order', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const first = archiveTransition(event, { artifactId: 'artifact-a', highWaterSeq: 10 });
    const second = archiveTransition(event, {
      artifactId: 'artifact-b',
      highWaterSeq: 20,
      previousTransitionId: first.transitionId,
      sourceProjection: first.replacement,
    });

    const inOrder = reduceEffectiveModelProjections([event], [first, second]);
    const reversed = reduceEffectiveModelProjections([event], [second, first]);

    assert.deepEqual(inOrder.events, reversed.events);
    assert.deepEqual(
      inOrder.applied.map((transition) => transition.transitionId),
      [first.transitionId, second.transitionId],
    );
    assert.deepEqual([...inOrder.reachableArchiveArtifactIds].sort(), ['artifact-a', 'artifact-b']);
  });

  test('leaves provider-native opaque results alone', () => {
    const event = toolResultEvent('rt-1', 'turn-1', undefined, {
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'WebSearch',
        result: undefined,
        providerExecuted: true,
        providerOutput: { opaque: SECRET },
      },
    } as Partial<RuntimeEvent>);
    const transition = archiveTransition(toolResultEvent('rt-1', 'turn-1', { body: SECRET }));

    const reduced = reduceEffectiveModelProjections([event], [transition]);

    assert.deepEqual(reduced.events[0], event);
    assert.equal(reduced.applied.length, 0);
    assert.equal(reduced.rejected.length, 1);
    assert.equal(reduced.reachableArchiveArtifactIds.size, 0);
  });

  test('rolling compaction cannot re-measure or re-archive replaced content', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET.repeat(200) });
    const transition = archiveTransition(event);
    const reduced = reduceEffectiveModelProjections(
      [event, toolResultEvent('rt-2', 'turn-2', { body: 'tail' })],
      [transition],
    );

    const rawCandidates = collectStaleToolResultArchiveCandidates(
      [event, toolResultEvent('rt-2', 'turn-2', { body: 'tail' })],
      { enabled: true, maxResultEstimatedTokens: 1, minRecentTurnsFull: 1 },
      1,
    );
    const effectiveCandidates = collectStaleToolResultArchiveCandidates(
      reduced.events,
      { enabled: true, maxResultEstimatedTokens: 4096, minRecentTurnsFull: 1 },
      1,
    );

    assert.equal(rawCandidates.length, 1);
    assert.deepEqual(effectiveCandidates, []);
  });
});

describe('durable transition writer', () => {
  const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET.repeat(20) });

  function request() {
    const sourceProjection = baseToolResultProjection(event)!;
    const serializedResult = serializedToolResultProjection(sourceProjection);
    return {
      runtimeEventId: event.id,
      turnId: 'turn-1',
      toolCallId: 'tool-1',
      toolName: 'Read',
      sourceProjection,
      serializedResult,
      originalBytes: serializedResult.length,
      originalEstimatedTokens: serializedResult.length,
      reason: 'stale_tool_result_pruned_before_compact' as const,
    };
  }

  test('commits archive then transition, and the fold applies the result', async () => {
    const recorded: ModelProjectionTransition[] = [];
    const outcome = await archiveToolResultAsTransition(
      {
        sessionId: 'session-1',
        archiveToolResult: () => ({ artifactId: 'artifact-1' }),
        recordTransition: async (transition) => {
          recorded.push(transition);
        },
        now: () => 42,
      },
      request(),
    );

    assert.ok(outcome);
    assert.equal(recorded.length, 1);
    assert.equal(
      recorded[0]?.sourceProjectionDigest,
      durableToolResultProjectionDigest(baseToolResultProjection(event)!),
    );
    const reduced = reduceEffectiveModelProjections([event], recorded);
    assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
  });

  test('an archive failure leaves the model-visible content untouched', async () => {
    let recordCalls = 0;
    const outcome = await archiveToolResultAsTransition(
      {
        sessionId: 'session-1',
        archiveToolResult: () => {
          throw new Error('artifact store is unavailable');
        },
        recordTransition: async () => {
          recordCalls += 1;
        },
        now: () => 42,
      },
      request(),
    );

    assert.equal(outcome, undefined);
    assert.equal(recordCalls, 0);
  });

  test('a ledger failure leaves the content untouched and the artifact unreachable', async () => {
    const outcome = await archiveToolResultAsTransition(
      {
        sessionId: 'session-1',
        archiveToolResult: () => ({ artifactId: 'artifact-orphan' }),
        recordTransition: () => Promise.reject(new Error('ledger is unavailable')),
        now: () => 42,
      },
      request(),
    );

    assert.equal(outcome, undefined);
    const reduced = reduceEffectiveModelProjections([event], []);
    assert.equal(collectReachableArchiveArtifactIds(reduced).has('artifact-orphan'), false);
    assert.ok(serializedEffective(reduced.events).includes(SECRET));
  });
});

describe('transition ledger reads', () => {
  test('collects every session transition once and ignores undecodable records', async () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const transition = archiveTransition(event);
    const ledgerEvent = (id: string, data: Record<string, unknown>): AgentRunEvent => ({
      type: MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
      id,
      runId: 'run-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      ts: 1,
      data,
    });
    const runStore = {
      listSessionRuns: async () =>
        [{ runId: 'run-1' }, { runId: 'run-2' }] as unknown as AgentRunHeader[],
      readEvents: async (_sessionId: string, runId: string): Promise<AgentRunEvent[]> =>
        runId === 'run-1'
          ? [
              ledgerEvent(transition.transitionId, { transition }),
              ledgerEvent('broken', { transition: { kind: 'nonsense' } }),
            ]
          : [ledgerEvent(`${transition.transitionId}-replay`, { transition })],
    };

    const loaded = await loadModelProjectionTransitionsFromRunLedger(runStore, 'session-1');

    assert.deepEqual(
      loaded.map((entry) => entry.transitionId),
      [transition.transitionId],
    );
  });

  test('legacy retry: an event with no durable projection still folds through one codec', () => {
    // A legacy `function_response` carries no `modelProjection`; the
    // compatibility codec supplies one, and a transition addresses that.
    const legacy = toolResultEvent('rt-legacy', 'turn-1', { body: SECRET });
    assert.equal(
      legacy.content?.kind === 'function_response' && legacy.content.modelProjection,
      undefined,
    );
    const transition = archiveTransition(legacy);

    const first = reduceEffectiveModelProjections([legacy], [transition]);
    // The retry re-reads the same raw event and the same ledger.
    const retry = reduceEffectiveModelProjections([legacy], [transition]);

    assert.deepEqual(first.events, retry.events);
    assert.equal(serializedEffective(retry.events).includes(SECRET), false);
  });
});
