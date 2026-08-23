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
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  buildHistoryCompactCheckpoint,
  matchHistoryCompactCheckpointPrefix,
  midTurnHeadAnchorEvent,
  projectHistoryCompactCheckpointReplay,
  validateHistoryCompactCheckpointShape,
} from '../history-compact-checkpoint.js';
import { applyRuntimeEventHistoryCompact } from '../history-compact.js';

describe('mid-turn history compact checkpoint', () => {
  test('builds a mid_turn checkpoint that re-renders the covered head anchor verbatim', () => {
    // [prior turn user, prior turn model, head anchor user, current step model]
    const events = [
      textEvent('prior-user', 'turn-0', 'user', 'prior user context '.repeat(80)),
      textEvent('prior-model', 'turn-0', 'model', 'prior model context '.repeat(80)),
      textEvent('anchor', 'turn-1', 'user'),
      textEvent('step-model', 'turn-1', 'model'),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'Prior work plus the current turn opening.',
      summaryFormat: 'legacy_freeform',
      phase: 'mid_turn',
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-1' },
      now: 1_800_000_010_000,
    });

    assert.equal(checkpoint.phase, 'mid_turn');
    assert.deepEqual(checkpoint.headAnchor, { runtimeEventId: 'anchor', turnId: 'turn-1' });
    assert.equal(validateHistoryCompactCheckpointShape(checkpoint, 'session-1'), true);
    // Coverage remains a contiguous prefix whose digest matches the raw events.
    const match = matchHistoryCompactCheckpointPrefix(checkpoint, [
      ...events,
      textEvent('tail', 'turn-1', 'model'),
    ]);
    assert.equal(match.coveredEventCount, 4);
    assert.deepEqual(
      match.successorRuntimeEvents.map((event) => event.id),
      ['tail'],
    );

    const anchor = midTurnHeadAnchorEvent(checkpoint, match.coveredRuntimeEvents);
    assert.equal(anchor?.id, 'anchor');
    const projected = projectHistoryCompactCheckpointReplay(
      checkpoint,
      match.coveredRuntimeEvents,
      match.successorRuntimeEvents,
    );
    assert.deepEqual(
      projected.map((event) => event.id),
      [`history-compact:${checkpoint.checkpointId}`, 'anchor', 'tail'],
    );
    // Head anchor is byte-identical to the covered raw event.
    assert.deepEqual(projected[1], events[2]);
  });

  test('rejects a mid_turn checkpoint without a covered head anchor', () => {
    const events = [textEvent('a', 'turn-1', 'user'), textEvent('b', 'turn-1', 'model')];
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: events,
          summary: 'x',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
        }),
      /requires a head anchor/,
    );
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: events,
          summary: 'x',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
          headAnchor: { runtimeEventId: 'missing', turnId: 'turn-1' },
        }),
      /must be a covered RuntimeEvent/,
    );
  });

  test("rejects a head anchor that is not the compacted turn's user event", () => {
    const events = [textEvent('a', 'turn-1', 'user'), textEvent('b', 'turn-1', 'model')];
    // Anchor turnId disagrees with the covered event.
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: events,
          summary: 'x',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
          headAnchor: { runtimeEventId: 'a', turnId: 'turn-9' },
        }),
      /must be the compacted turn's user event/,
    );
    // Anchor references a model event, not the turn's user message.
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: events,
          summary: 'x',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
          headAnchor: { runtimeEventId: 'b', turnId: 'turn-1' },
        }),
      /must be the compacted turn's user event/,
    );
  });

  test("rejects a head anchor pointing at another covered turn's user event", () => {
    // A self-consistent anchor (role user, matching self-reported turnId) that
    // resolves to a PRIOR turn's prompt would silently drop the real current
    // prompt from the replay — the compacted turn is the last covered event's
    // turn, and the anchor must belong to it.
    const events = [
      textEvent('prior-user', 'turn-0', 'user'),
      textEvent('prior-model', 'turn-0', 'model'),
      textEvent('anchor', 'turn-1', 'user'),
      textEvent('step-model', 'turn-1', 'model'),
    ];
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: events,
          summary: 'x',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
          headAnchor: { runtimeEventId: 'prior-user', turnId: 'turn-0' },
        }),
      /must be the compacted turn's user event/,
    );

    // Matcher: a persisted checkpoint whose anchor was tampered to the prior
    // turn's user event must fail closed as coverage_miss.
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'mid turn summary',
      summaryFormat: 'legacy_freeform',
      phase: 'mid_turn',
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-1' },
    });
    const priorUserAnchor = {
      ...checkpoint,
      headAnchor: { runtimeEventId: 'prior-user', turnId: 'turn-0' },
    };
    assert.equal(
      matchHistoryCompactCheckpointPrefix(priorUserAnchor, events).reason,
      'coverage_miss',
    );
    assert.equal(matchHistoryCompactCheckpointPrefix(checkpoint, events).reason, undefined);
  });

  test('rejects coverage that includes a partial streaming snapshot', () => {
    const events = [
      textEvent('a', 'turn-1', 'user'),
      { ...textEvent('b-partial', 'turn-1', 'model'), partial: true },
      textEvent('c', 'turn-1', 'model'),
    ];
    assert.throws(
      () =>
        buildHistoryCompactCheckpoint({
          sessionId: 'session-1',
          coveredRuntimeEvents: events,
          summary: 'x',
          summaryFormat: 'legacy_freeform',
          phase: 'mid_turn',
          headAnchor: { runtimeEventId: 'a', turnId: 'turn-1' },
        }),
      /must not include partial events/,
    );
  });

  test('fails the prefix match closed when the head anchor reference is corrupted', () => {
    const events = [
      textEvent('anchor', 'turn-1', 'user'),
      textEvent('step-model', 'turn-1', 'model'),
      textEvent('tail', 'turn-1', 'model'),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 2),
      summary: 'mid turn summary',
      summaryFormat: 'legacy_freeform',
      phase: 'mid_turn',
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-1' },
    });

    // Anchor id pointing outside the coverage: the replay would silently drop
    // the turn's user message, so the match must fail closed instead.
    const missingAnchor = {
      ...checkpoint,
      headAnchor: { runtimeEventId: 'tail', turnId: 'turn-1' },
    };
    assert.equal(
      matchHistoryCompactCheckpointPrefix(missingAnchor, events).reason,
      'coverage_miss',
    );

    // Anchor resolving to a covered non-user event fails the same way.
    const modelAnchor = {
      ...checkpoint,
      headAnchor: { runtimeEventId: 'step-model', turnId: 'turn-1' },
    };
    assert.equal(matchHistoryCompactCheckpointPrefix(modelAnchor, events).reason, 'coverage_miss');

    // Anchor turnId disagreeing with the covered event fails too.
    const wrongTurnAnchor = {
      ...checkpoint,
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-9' },
    };
    assert.equal(
      matchHistoryCompactCheckpointPrefix(wrongTurnAnchor, events).reason,
      'coverage_miss',
    );

    // The intact checkpoint still matches.
    assert.equal(matchHistoryCompactCheckpointPrefix(checkpoint, events).reason, undefined);
  });

  test('keeps pre_turn checkpoint ids stable when phase is absent or explicit', () => {
    const events = [textEvent('a', 'turn-0', 'user'), textEvent('b', 'turn-0', 'model')];
    const implicit = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'same',
      summaryFormat: 'legacy_freeform',
      now: 5,
    });
    const explicit = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'same',
      summaryFormat: 'legacy_freeform',
      phase: 'pre_turn',
      now: 5,
    });
    assert.equal(implicit.phase, undefined);
    assert.equal(explicit.checkpointId, implicit.checkpointId);
    // A mid_turn checkpoint over the same coverage is a distinct id.
    const mid = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events,
      summary: 'same',
      summaryFormat: 'legacy_freeform',
      now: 5,
      phase: 'mid_turn',
      headAnchor: { runtimeEventId: 'a', turnId: 'turn-0' },
    });
    assert.notEqual(mid.checkpointId, implicit.checkpointId);
  });

  test('replays a mid_turn checkpoint as [block, verbatim head anchor, uncovered tail]', () => {
    const events = [
      textEvent('prior-user', 'turn-0', 'user', 'prior user context '.repeat(80)),
      textEvent('prior-model', 'turn-0', 'model', 'prior model context '.repeat(80)),
      textEvent('anchor', 'turn-1', 'user'),
      textEvent('step-model', 'turn-1', 'model'),
      textEvent('step-tool', 'turn-1', 'model'),
    ];
    const checkpoint = buildHistoryCompactCheckpoint({
      sessionId: 'session-1',
      coveredRuntimeEvents: events.slice(0, 4),
      summary: 'mid turn summary',
      summaryFormat: 'legacy_freeform',
      phase: 'mid_turn',
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-1' },
    });

    // Normal thresholds: the raw projection is far below the default high
    // water, and the accepted mid_turn checkpoint must STILL replay — the
    // covered raw span may never be re-injected on recovery.
    const replay = applyRuntimeEventHistoryCompact(
      events,
      { enabled: true, mode: 'read_write', checkpoint },
      1,
      10_000,
    );

    assert.equal(replay.checkpoint?.checkpointId, checkpoint.checkpointId);
    assert.deepEqual(
      replay.events.map((event) => event.id),
      [`history-compact:${checkpoint.checkpointId}`, 'anchor', 'step-tool'],
    );
    // The head anchor renders verbatim and is not duplicated in the tail.
    const anchorCount = replay.events.filter((event) => event.id === 'anchor').length;
    assert.equal(anchorCount, 1);
  });
});

function textEvent(
  id: string,
  turnId: string,
  role: 'user' | 'model',
  text = `payload-${id}`,
): RuntimeEvent {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'run-1',
    ts: 1_800_000_000_000,
    partial: false,
    role,
    author: role === 'user' ? 'user' : 'agent',
    content: { kind: 'text', text },
  };
}
