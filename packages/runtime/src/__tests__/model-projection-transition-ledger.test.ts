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

import type { AgentRunEvent } from '@maka/core/agent-run';
import {
  buildModelProjectionTransition,
  durableToolResultProjectionDigest,
  MODEL_PROJECTION_TRANSITION_EVENT_TYPE,
  type ModelProjectionTransition,
} from '@maka/core/model-projection-transition';
import { DURABLE_TOOL_RESULT_PROJECTION_FAILURE } from '@maka/core/durable-tool-result-projection';
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
    ...(options.previousTransitionId ? { previousTransitionId: options.previousTransitionId } : {}),
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

  test('refuses a stale concurrent writer instead of restoring its source', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const first = archiveTransition(event, { artifactId: 'artifact-a' });
    // A second Turn that never saw `first` decides against the same source.
    const stale = archiveTransition(event, { artifactId: 'artifact-b' });
    // Neither wrote later than the other in any sense a reader can trust, so the
    // winner is the smaller content-derived id — the same one on every reader.
    const [winner, loser] =
      first.transitionId < stale.transitionId ? [first, stale] : [stale, first];

    for (const arrival of [
      [first, stale],
      [stale, first],
    ]) {
      const reduced = reduceEffectiveModelProjections([event], arrival);
      assert.deepEqual(
        reduced.applied.map((transition) => transition.transitionId),
        [winner.transitionId],
      );
      assert.deepEqual(
        reduced.rejected.map((transition) => transition.transitionId),
        [loser.transitionId],
      );
      assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
      // The refused writer's archive is named by nothing the model can see.
      assert.deepEqual(
        [...collectReachableArchiveArtifactIds(reduced.events)],
        [winner === first ? 'artifact-a' : 'artifact-b'],
      );
    }
  });

  test('orders concurrent Turns deterministically regardless of ledger arrival order', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const first = archiveTransition(event, { artifactId: 'artifact-a' });
    const second = archiveTransition(event, {
      artifactId: 'artifact-b',
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
    assert.deepEqual([...collectReachableArchiveArtifactIds(inOrder.events)], ['artifact-b']);
  });

  test('withholds a target whose record this build cannot read', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    // A record written by a newer version may be the one that removed this
    // content. Replaying the raw body would undo whatever it decided.
    const reduced = reduceEffectiveModelProjections([event], [], new Set(['rt-1::tool_result']));

    assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
    const [effective] = reduced.events;
    assert.ok(effective?.content?.kind === 'function_response');
    assert.deepEqual(effective.content.modelProjection, DURABLE_TOOL_RESULT_PROJECTION_FAILURE);
  });

  test('refuses the decodable records of an unreadable target too', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: SECRET });
    const transition = archiveTransition(event);
    // The unreadable record's place in the chain is unknown, so no record for
    // this target can be trusted to describe the current projection.
    const reduced = reduceEffectiveModelProjections(
      [event],
      [transition],
      new Set(['rt-1::tool_result']),
    );

    assert.equal(reduced.applied.length, 0);
    assert.deepEqual(
      reduced.rejected.map((entry) => entry.transitionId),
      [transition.transitionId],
    );
    assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
    assert.equal(collectReachableArchiveArtifactIds(reduced.events).size, 0);
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
    assert.equal(collectReachableArchiveArtifactIds(reduced.events).size, 0);
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

  test('collects a media-bearing result whose reference text is tiny', () => {
    const event = toolResultEvent('rt-1', 'turn-1', 'ok', {
      content: {
        kind: 'function_response',
        id: 'tool-1',
        name: 'Screenshot',
        result: 'ok',
        modelProjection: {
          version: 1,
          kind: 'content',
          parts: [
            { kind: 'text', text: 'ok' },
            {
              kind: 'artifact',
              mediaType: 'image/png',
              ref: { kind: 'session_file', sessionId: 'session-1', relativePath: 'artifact-1' },
            },
          ],
        },
      },
    } as Partial<RuntimeEvent>);

    const candidates = collectStaleToolResultArchiveCandidates(
      [event, toolResultEvent('rt-2', 'turn-2', { body: 'tail' })],
      { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 1 },
      4,
    );

    assert.deepEqual(
      candidates.map((candidate) => candidate.runtimeEventId),
      ['rt-1'],
    );
  });

  test('leaves a text result under the size gate alone', () => {
    const event = toolResultEvent('rt-1', 'turn-1', { body: 'x'.repeat(4_000) });

    const candidates = collectStaleToolResultArchiveCandidates(
      [event, toolResultEvent('rt-2', 'turn-2', { body: 'tail' })],
      { enabled: true, maxResultEstimatedTokens: 2048, minRecentTurnsFull: 1 },
      4,
    );

    assert.deepEqual(candidates, []);
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

  test('a writer shows the transition the fold accepts, not the one it wrote', async () => {
    // Both Turns load the same source and append rival roots. Appending
    // successfully does not make either one the fold's answer, so a writer must
    // return what the ledger has settled on by the time it looks.
    for (const order of [
      ['artifact-a', 'artifact-b'],
      ['artifact-b', 'artifact-a'],
    ]) {
      const ledger: ModelProjectionTransition[] = [];
      const services = (artifactId: string) => ({
        sessionId: 'session-1',
        archiveToolResult: () => ({ artifactId }),
        recordTransition: async (transition: ModelProjectionTransition) => {
          ledger.push(transition);
        },
        loadTransitions: async () => ({ transitions: [...ledger] }),
        now: () => 42,
      });

      await archiveToolResultAsTransition(services(order[0]!), request());
      const second = await archiveToolResultAsTransition(services(order[1]!), request());

      assert.ok(second);
      assert.equal(ledger.length, 2);
      const reduced = reduceEffectiveModelProjections([event], ledger);
      assert.equal(reduced.applied.length, 1);
      const winner = reduced.applied[0]!;
      // The later writer sees both records, so it must not show its own when
      // the fold prefers the other.
      assert.equal(second.transition.transitionId, winner.transitionId);
      assert.deepEqual(archivedToolResultProjection(second.placeholder), winner.replacement);
      const effective = reduced.events[0];
      assert.ok(effective?.content?.kind === 'function_response');
      assert.ok(isArchivedToolResultPlaceholder(effective.content.result));
      assert.equal(effective.content.result.artifactId, second.placeholder.artifactId);
      assert.equal(serializedEffective(reduced.events).includes(SECRET), false);
    }
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
    assert.equal(collectReachableArchiveArtifactIds(reduced.events).has('artifact-orphan'), false);
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
      readEvents: async (_sessionId: string, runId: string): Promise<AgentRunEvent[]> =>
        runId === 'run-1'
          ? [
              ledgerEvent(transition.transitionId, { transition }),
              ledgerEvent('broken', {
                runtimeEventId: 'rt-1',
                part: 'tool_result',
                transition: { kind: 'nonsense' },
              }),
              ledgerEvent('broken-unscoped', { transition: { kind: 'nonsense' } }),
            ]
          : [ledgerEvent(`${transition.transitionId}-replay`, { transition })],
    };

    const loaded = await loadModelProjectionTransitionsFromRunLedger(runStore, 'session-1', [
      'run-1',
      'run-2',
    ]);

    assert.deepEqual(
      loaded.transitions.map((entry) => entry.transitionId),
      [transition.transitionId],
    );
    // A record of the right type this build cannot decode is confined to the
    // target its envelope names, not silently treated as "no transition here".
    assert.deepEqual([...loaded.unreadableTargets], ['rt-1::tool_result']);
    // One that names no target cannot be confined to anything.
    assert.equal(loaded.unscopedUnreadable, 1);
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
