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
  estimateNextRequestTokens,
  exceedsContextWindow,
  exceedsHighWater,
  planMidTurnCapacityCompaction,
  selectMidTurnSafeBoundary,
  type PlanMidTurnCapacityCompactionInput,
} from '../mid-turn-capacity-compact.js';
import { HistoryCompactSummarizerError } from '../history-compact-summarizer.js';
import { applyRuntimeEventHistoryCompact } from '../history-compact.js';
import { matchHistoryCompactCheckpointPrefix } from '../history-compact-checkpoint.js';

describe('mid-turn capacity trigger measurement', () => {
  test('anchors on real provider usage plus a tail char/4 delta', () => {
    // last step: 100 input + 40 output real tokens, then 400 chars of new tool results
    assert.equal(
      estimateNextRequestTokens({ priorUsageTokens: 140, appendedChars: 400, charsPerToken: 4 }),
      140 + 100,
    );
  });

  test('credits a SIGNED negative payload delta after a compaction shrank the projection', () => {
    // The last usage sample measured the PRE-compaction request; the payload
    // delta is negative after the fold, so the estimate must shrink with it —
    // clamping the delta at zero would judge the compacted request by the
    // pre-compaction usage and wrongly exhaust a rescued turn.
    assert.equal(
      estimateNextRequestTokens({ priorUsageTokens: 700, appendedChars: -1_200, charsPerToken: 4 }),
      400,
    );
    // The estimate never goes below zero even when the shrink exceeds usage.
    assert.equal(
      estimateNextRequestTokens({ priorUsageTokens: 100, appendedChars: -4_000, charsPerToken: 4 }),
      0,
    );
  });

  test('falls back to whole-projection char/4 on cold start (no usage)', () => {
    assert.equal(
      estimateNextRequestTokens({ appendedChars: 40, charsPerToken: 4, coldStartChars: 800 }),
      200,
    );
  });

  test('high-water crosses at contextWindow minus reserve; hard cap at the window', () => {
    assert.equal(exceedsHighWater(100_000, 128_000, 16_384), false);
    assert.equal(exceedsHighWater(120_000, 128_000, 16_384), true);
    assert.equal(exceedsContextWindow(120_000, 128_000), false);
    assert.equal(exceedsContextWindow(130_000, 128_000), true);
  });
});

describe('mid-turn safe boundary selection', () => {
  test('folds the largest immutable non-partial prefix, leaving the reserved tail', () => {
    const events = [
      user('anchor', 'turn-1'),
      model('m1', 'turn-1'),
      model('m2', 'turn-1'),
      model('m3', 'turn-1'),
    ];
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 3 });
  });

  test('never cuts on a partial (streaming) event', () => {
    const events = [
      user('anchor', 'turn-1'),
      model('m1', 'turn-1'),
      { ...model('m2-partial', 'turn-1'), partial: true },
    ];
    // Reserving 0 tail would cut after the partial; it must retreat to m1.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 0 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 2 });
  });

  test('never splits a tool call/result pair', () => {
    const events = [
      user('anchor', 'turn-1'),
      call('c1', 'call-1', 'turn-1'),
      result('r1', 'call-1', 'turn-1'),
      call('c2', 'call-2', 'turn-1'),
      result('r2', 'call-2', 'turn-1'),
    ];
    // reserveTail=2 would cut at index 3, between call-2 and its result → retreat to 3? No:
    // index 3 straddles call-2(3)/result-2(4)? call at 3 >= 3, result at 4 >= 3, both outside → safe.
    // Force a straddle: reserveTail=1 → maxCut=4 straddles nothing (call-2 at 3<4, result-2 at 4>=4) → straddle, retreat to 3.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 3 });
  });

  test('retreats before a partial in the middle of the prefix, not just at the cut', () => {
    const events = [
      user('anchor', 'turn-1'),
      { ...model('m-partial', 'turn-1'), partial: true },
      model('m-final', 'turn-1'),
    ];
    // With no reserved tail the largest cut ends on the immutable m-final, but
    // the prefix would still span the partial snapshot — coverage must stop
    // strictly before the first partial.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 0 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 1 });
  });

  test('never covers an open tool call whose response has not arrived', () => {
    const events = [
      model('prior', 'turn-0'),
      user('anchor', 'turn-1'),
      call('open-call', 'call-open', 'turn-1'),
    ];
    // Even with no reserved tail, covering the open call would orphan the
    // response that lands after compaction — the cut must stop before it.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 0 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 2 });
  });

  test('reports no safe completed span when the whole pool is one atomic pair', () => {
    const events = [call('c1', 'call-1', 'turn-1'), result('r1', 'call-1', 'turn-1')];
    // Reserving 1 tail forces maxCut=1, which straddles the only pair → no safe span.
    const boundary = selectMidTurnSafeBoundary(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: false, reason: 'no_safe_completed_span' });
  });
});

describe('plan mid-turn capacity compaction', () => {
  // A long turn: two prior turns folded already conceptually, plus the current
  // turn's head anchor and several completed steps.
  function longTurnEvents(): RuntimeEvent[] {
    return [
      model('prior-0', 'turn-0', 'prior context zero '.repeat(80)),
      model('prior-1', 'turn-0', 'prior context one '.repeat(80)),
      user('anchor', 'turn-1'),
      call('call-a', 'ca', 'turn-1'),
      result('res-a', 'ca', 'turn-1'),
      call('call-b', 'cb', 'turn-1'),
      result('res-b', 'cb', 'turn-1'),
    ];
  }
  // The write gate validates checkpoint structure (#3029), so stub summaries
  // must be shaped like real checkpoints while keeping their sentinel text.
  function structuredSummary(body: string): string {
    return `## Goal\n${body}\n\n## Progress\n- done\n\n## Next Steps\n1. continue\n\n## Critical Context\n- (none)`;
  }
  function planInput(
    over: Partial<PlanMidTurnCapacityCompactionInput> = {},
  ): PlanMidTurnCapacityCompactionInput {
    return {
      sessionId: 'session-1',
      orderedEvents: longTurnEvents(),
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-1' },
      estimatedNextRequestTokens: 120_000,
      contextWindow: 128_000,
      reserveTokens: 16_384,
      reserveTailEvents: 1,
      charsPerToken: 4,
      now: 1_800_000_010_000,
      summarize: () => structuredSummary('A faithful mid-turn summary.'),
      ...over,
    };
  }

  test('skips below the high-water threshold', async () => {
    const result = await planMidTurnCapacityCompaction(
      planInput({ estimatedNextRequestTokens: 100_000 }),
    );
    assert.deepEqual(result, { decision: 'skip', reason: 'below_high_water' });
  });

  test('compacts a safe prefix, keeps the head anchor verbatim, and continues with the tail', async () => {
    const result = await planMidTurnCapacityCompaction(planInput());
    assert.equal(result.decision, 'compacted');
    if (result.decision !== 'compacted') return;
    assert.equal(result.checkpoint.phase, 'mid_turn');
    // Replacement is [block, verbatim head anchor, ...tail]; completed tool
    // calls/results before the boundary are folded, not replayed raw.
    const ids = result.replacementEvents.map((event) => event.id);
    assert.equal(ids[0], `history-compact:${result.checkpoint.checkpointId}`);
    assert.equal(ids[1], 'anchor');
    // Head anchor byte-identical to the raw event.
    assert.deepEqual(result.replacementEvents[1], longTurnEvents()[2]);
    // No folded raw event re-appears in the replacement.
    assert.equal(ids.includes('call-a'), false);
    assert.equal(ids.includes('res-a'), false);
    // The reserved tail (last event) is preserved verbatim.
    assert.equal(ids.at(-1), 'res-b');
  });

  test('step-0 recovery folds prior history without covering the current user anchor', async () => {
    const events = longTurnEvents();
    const result = await planMidTurnCapacityCompaction(
      planInput({ phase: 'pre_turn', orderedEvents: events }),
    );
    assert.equal(result.decision, 'compacted');
    if (result.decision !== 'compacted') return;

    assert.equal(result.checkpoint.phase, undefined);
    assert.deepEqual(
      result.coveredRuntimeEvents.map((event) => event.id),
      ['prior-0', 'prior-1'],
    );
    assert.deepEqual(
      result.replacementEvents.slice(1).map((event) => event.id),
      events.slice(2).map((event) => event.id),
    );
    assert.deepEqual(result.replacementEvents[1], events[2]);
  });

  test('persisted checkpoint replay-validates against the same ledger prefix (recovery)', async () => {
    const events = longTurnEvents();
    const result = await planMidTurnCapacityCompaction(planInput({ orderedEvents: events }));
    assert.equal(result.decision, 'compacted');
    if (result.decision !== 'compacted') return;

    // Re-projecting the ledger with the persisted checkpoint must match the exact
    // covered prefix and not re-inject any raw covered event.
    const match = matchHistoryCompactCheckpointPrefix(result.checkpoint, events);
    assert.equal(match.reason, undefined);
    assert.equal(match.coveredEventCount, result.coveredRuntimeEvents.length);

    // Normal thresholds: even though the raw ledger is far below the default
    // high water, the accepted mid_turn checkpoint replays — recovery never
    // re-injects the replaced raw span.
    const replay = applyRuntimeEventHistoryCompact(
      events,
      { enabled: true, mode: 'read_write', checkpoint: result.checkpoint },
      4,
      1_000_000,
    );
    assert.equal(replay.checkpoint?.checkpointId, result.checkpoint.checkpointId);
    const replayIds = replay.events.map((event) => event.id);
    assert.equal(replayIds[0], `history-compact:${result.checkpoint.checkpointId}`);
    assert.equal(replayIds.includes('anchor'), true);
    assert.equal(replayIds.includes('call-a'), false);
  });

  test('fails open below the window when the summarizer fails', async () => {
    const result = await planMidTurnCapacityCompaction(
      planInput({
        estimatedNextRequestTokens: 120_000, // over high-water, under window
        summarize: () => {
          throw new Error('summarizer down');
        },
      }),
    );
    assert.deepEqual(result, { decision: 'fail_open', reason: 'summarizer_failed' });
  });

  test('preserves a typed summarizer failure as the mid-turn diagnostic reason', async () => {
    const result = await planMidTurnCapacityCompaction(
      planInput({
        summarize: () => {
          throw new HistoryCompactSummarizerError('provider_error');
        },
      }),
    );
    assert.deepEqual(result, {
      decision: 'fail_open',
      reason: 'summarizer_failed',
      diagnosticReason: 'provider_error',
    });
  });

  test('fails open (never terminates) above the window when the summarizer fails', async () => {
    // The engine is a pure shaper: the over-window pass/terminate verdict is
    // issued by the backend's final-request estimate owner, never here.
    const result = await planMidTurnCapacityCompaction(
      planInput({
        estimatedNextRequestTokens: 130_000, // over the window itself
        summarize: () => '',
      }),
    );
    assert.deepEqual(result, { decision: 'fail_open', reason: 'summarizer_failed' });
  });

  test('the write gate rejects a malformed summary from any producer', async () => {
    // The default summarizer validates its own completions; the write gate
    // enforces the same invariant for any other producer (#3029).
    const result = await planMidTurnCapacityCompaction(
      planInput({ summarize: () => '这不是结构化摘要，而是一段自由文本。' }),
    );
    assert.deepEqual(result, {
      decision: 'fail_open',
      reason: 'summarizer_failed',
      diagnosticReason: 'malformed_summary_missing_section',
    });
  });

  test('fails open with no_safe_completed_span when the pool has no safe cut past the anchor', async () => {
    // Only the head anchor and one open call/result pair; reserving the tail
    // leaves no safe completed span that also covers a step past the anchor.
    const events = [
      user('anchor', 'turn-1'),
      call('c', 'c1', 'turn-1'),
      result('r', 'c1', 'turn-1'),
    ];
    const outcome = await planMidTurnCapacityCompaction(
      planInput({
        orderedEvents: events,
        estimatedNextRequestTokens: 130_000,
        reserveTailEvents: 1,
      }),
    );
    assert.deepEqual(outcome, { decision: 'fail_open', reason: 'no_safe_completed_span' });
  });

  test('still shapes when the estimate exceeds the window — no post-fold window verdict here', async () => {
    // Review round-3 finding A: a post-fold re-estimate that subtracts the
    // RAW covered span is wrong on a rolling (second) compaction — the
    // previous request was already `[block, anchor, tail]` and never carried
    // that raw prefix, so the subtraction over-credits the fold and passes a
    // still-over-window request. The engine therefore makes NO window claim
    // after folding: it returns the shape and the backend owner re-measures
    // the actual replacement payload.
    const outcome = await planMidTurnCapacityCompaction(
      planInput({
        estimatedNextRequestTokens: 10_000,
        contextWindow: 1_000,
        reserveTokens: 100,
      }),
    );
    assert.equal(outcome.decision, 'compacted');
  });

  // Note: a fold whose materialized replacement does not SHRINK the request
  // (e.g. a runaway summary block) is refused at the backend hook, which
  // measures the real payload bytes — see the mid-turn backend suite. The
  // engine works on runtime-event char estimates and makes no such claim.

  test('rolls forward from a matching previous checkpoint (only the new span is summarized)', async () => {
    const events = longTurnEvents();
    const first = await planMidTurnCapacityCompaction(
      planInput({
        orderedEvents: events.slice(0, 5), // fold through res-a
      }),
    );
    assert.equal(first.decision, 'compacted');
    if (first.decision !== 'compacted') return;

    let seenNewlyFolded: string[] = [];
    const second = await planMidTurnCapacityCompaction(
      planInput({
        orderedEvents: events,
        previousCheckpoint: first.checkpoint,
        summarize: ({ newlyFoldedRuntimeEvents, previousCheckpoint }) => {
          seenNewlyFolded = newlyFoldedRuntimeEvents.map((event) => event.id);
          assert.equal(previousCheckpoint?.checkpointId, first.checkpoint.checkpointId);
          return structuredSummary('rolled-forward summary');
        },
      }),
    );
    assert.equal(second.decision, 'compacted');
    if (second.decision !== 'compacted') return;
    // First folded through `anchor`; the second folds through `res-a`, so only
    // the span after the previous checkpoint's coverage is re-summarized.
    assert.deepEqual(seenNewlyFolded, ['call-a', 'res-a']);
    assert.equal(second.checkpoint.previousCheckpointId, first.checkpoint.checkpointId);
  });
});

function base(id: string, turnId: string): Omit<RuntimeEvent, 'role' | 'author' | 'content'> {
  return {
    id,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId,
    invocationId: 'run-1',
    ts: 1_800_000_000_000,
    partial: false,
  };
}
function user(id: string, turnId: string): RuntimeEvent {
  return { ...base(id, turnId), role: 'user', author: 'user', content: { kind: 'text', text: id } };
}
function model(id: string, turnId: string, text: string = id): RuntimeEvent {
  return { ...base(id, turnId), role: 'model', author: 'agent', content: { kind: 'text', text } };
}
function call(id: string, callId: string, turnId: string): RuntimeEvent {
  return {
    ...base(id, turnId),
    role: 'model',
    author: 'agent',
    content: { kind: 'function_call', id: callId, name: 'tool', args: {} },
  };
}
function result(id: string, callId: string, turnId: string, payload: string = 'ok'): RuntimeEvent {
  return {
    ...base(id, turnId),
    role: 'tool',
    author: 'tool',
    content: { kind: 'function_response', id: callId, name: 'tool', result: payload },
  };
}
