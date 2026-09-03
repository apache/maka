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
import type { AgentRunHeader } from '@maka/core/agent-run';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  applyRuntimeEventHistoryCompact,
  planHistoryCompaction,
  selectSafeCompactionPrefix,
  type PlanHistoryCompactionInput,
} from '../history-compaction.js';
import { HistoryCompactSummarizerError } from '../history-compact-summarizer.js';
import { matchHistoryCompactCheckpointPrefix } from '../history-compact-checkpoint.js';

describe('safe compaction prefix selection', () => {
  test('folds the largest immutable non-partial prefix, leaving the reserved tail', () => {
    const events = [
      user('anchor', 'turn-1'),
      model('m1', 'turn-1'),
      model('m2', 'turn-1'),
      model('m3', 'turn-1'),
    ];
    const boundary = selectSafeCompactionPrefix(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 3 });
  });

  test('never cuts on a partial (streaming) event', () => {
    const events = [
      user('anchor', 'turn-1'),
      model('m1', 'turn-1'),
      { ...model('m2-partial', 'turn-1'), partial: true },
    ];
    // Reserving 0 tail would cut after the partial; it must retreat to m1.
    const boundary = selectSafeCompactionPrefix(events, { reserveTailEvents: 0 });
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
    const boundary = selectSafeCompactionPrefix(events, { reserveTailEvents: 1 });
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
    const boundary = selectSafeCompactionPrefix(events, { reserveTailEvents: 0 });
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
    const boundary = selectSafeCompactionPrefix(events, { reserveTailEvents: 0 });
    assert.deepEqual(boundary, { ok: true, coveredCount: 2 });
  });

  test('reports no safe completed span when the whole pool is one atomic pair', () => {
    const events = [call('c1', 'call-1', 'turn-1'), result('r1', 'call-1', 'turn-1')];
    // Reserving 1 tail forces maxCut=1, which straddles the only pair → no safe span.
    const boundary = selectSafeCompactionPrefix(events, { reserveTailEvents: 1 });
    assert.deepEqual(boundary, { ok: false, reason: 'no_safe_completed_span' });
  });
});

describe('plan context compaction', () => {
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
  function planInput(over: Partial<PlanHistoryCompactionInput> = {}): PlanHistoryCompactionInput {
    return {
      sessionId: 'session-1',
      orderedEvents: longTurnEvents(),
      headAnchor: { runtimeEventId: 'anchor', turnId: 'turn-1' },
      reserveTailEvents: 1,
      charsPerToken: 4,
      now: 1_800_000_010_000,
      summarize: () => structuredSummary('A faithful mid-turn summary.'),
      ...over,
    };
  }

  test('compacts whenever the caller has emitted a compaction command', async () => {
    const result = await planHistoryCompaction(planInput());
    assert.equal(result.decision, 'compacted');
  });

  test('compacts a safe prefix, keeps the head anchor verbatim, and continues with the tail', async () => {
    const result = await planHistoryCompaction(planInput());
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
    const result = await planHistoryCompaction(
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

  test('retreats to the span the last accepted input covered', async () => {
    // The newest reply's events end that span: everything before the first of
    // them was in the request the provider accepted, so it is provably within
    // capacity. Halving would be a guess in either direction (#4559).
    const events = [
      user('old-user', 'old-turn'),
      model('old-model', 'old-turn', 'old result'),
      user('recent-user', 'recent-turn'),
      model('recent-model', 'recent-turn', 'recent result'),
    ];
    const attemptedCoverage: string[][] = [];
    const result = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: events,
        runHeaders: HEADERS_A,
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        summarize: ({ coveredRuntimeEvents }) => {
          attemptedCoverage.push(coveredRuntimeEvents.map((event) => event.id));
          if (attemptedCoverage.length === 1) {
            throw new HistoryCompactSummarizerError('input_too_large');
          }
          return structuredSummary('A bounded automatic summary.');
        },
      }),
    );

    assert.equal(result.decision, 'compacted');
    if (result.decision !== 'compacted') return;
    assert.deepEqual(attemptedCoverage, [
      ['old-user', 'old-model', 'recent-user', 'recent-model'],
      ['old-user', 'old-model', 'recent-user'],
    ]);
    assert.deepEqual(
      result.tailRuntimeEvents.map((event) => event.id),
      ['recent-model'],
    );
  });

  test('a later fold rolls over the reply the retreat left verbatim', async () => {
    // The retreat keeps the newest reply out of the fold, so it stays in the
    // request as raw text. It does not stay there: the next fold covers it,
    // rolling the checkpoint forward, because by then a newer reply ends the
    // proven span. This bounds how long a retreat's leftover survives.
    const first = [
      user('old-user', 'old-turn'),
      model('old-model', 'old-turn', 'old result'),
      user('recent-user', 'recent-turn'),
      model('recent-model', 'recent-turn', 'recent result'),
    ];
    let attempts = 0;
    const retreated = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: first,
        runHeaders: HEADERS_A,
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        summarize: () => {
          attempts += 1;
          if (attempts === 1) throw new HistoryCompactSummarizerError('input_too_large');
          return structuredSummary('A bounded automatic summary.');
        },
      }),
    );
    assert.equal(retreated.decision, 'compacted');
    if (retreated.decision !== 'compacted') return;
    assert.deepEqual(
      retreated.tailRuntimeEvents.map((event) => event.id),
      ['recent-model'],
    );

    // The turn continues: a newer reply arrives, so the proven span now ends
    // after the one the retreat spared.
    const later = [...first, user('next-user', 'next-turn'), model('next-model', 'next-turn')];
    const rolled = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: later,
        runHeaders: HEADERS_A,
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        previousCheckpoint: retreated.checkpoint,
        summarize: () => structuredSummary('A bounded automatic summary.'),
      }),
    );
    assert.equal(rolled.decision, 'compacted');
    if (rolled.decision !== 'compacted') return;
    assert.equal(
      rolled.coveredRuntimeEvents.some((event) => event.id === 'recent-model'),
      true,
    );
  });

  test('fails open when the proven boundary is refused too', async () => {
    // One retreat, because there is one proven boundary. A rejection of that
    // span is the provider saying this fold cannot be made.
    const events = [
      user('old-user', 'old-turn'),
      model('old-model', 'old-turn', 'old result'),
      user('recent-user', 'recent-turn'),
      model('recent-model', 'recent-turn', 'recent result'),
    ];
    let attempts = 0;
    const result = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: events,
        runHeaders: HEADERS_A,
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        summarize: () => {
          attempts += 1;
          throw new HistoryCompactSummarizerError('input_too_large');
        },
      }),
    );

    assert.equal(attempts, 2);
    assert.equal(result.decision, 'fail_open');
    if (result.decision !== 'fail_open') return;
    assert.equal(result.diagnosticReason, 'input_too_large');
  });

  test("a mixed-route session retreats to this route's own newest reply", async () => {
    // History can span runs on several routes. A span another model accepted
    // proves nothing about this summarizer's window, so the retreat targets the
    // newest reply THIS route produced, found through the run headers.
    const events = [
      user('old-user', 'old-turn'),
      modelOnRun('mine', 'old-turn', 'run-1', 'accepted by this route'),
      user('switch-user', 'switch-turn'),
      modelOnRun('theirs', 'switch-turn', 'run-2', 'accepted by another route'),
    ];
    const attemptedCoverage: string[][] = [];
    const result = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: events,
        runHeaders: [
          runHeader('run-1', 'model-a', 'conn-a'),
          runHeader('run-2', 'model-b', 'conn-b'),
        ],
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        summarize: ({ coveredRuntimeEvents }) => {
          attemptedCoverage.push(coveredRuntimeEvents.map((event) => event.id));
          if (attemptedCoverage.length === 1) {
            throw new HistoryCompactSummarizerError('input_too_large');
          }
          return structuredSummary('A bounded automatic summary.');
        },
      }),
    );

    assert.equal(result.decision, 'compacted');
    // Not ['old-user', 'mine', 'switch-user'], which stops at the other route's
    // reply: that span is proven only for the model that accepted it.
    assert.deepEqual(attemptedCoverage, [
      ['old-user', 'mine', 'switch-user', 'theirs'],
      ['old-user'],
    ]);
  });

  test('fails open when only another route has ever been accepted', async () => {
    let attempts = 0;
    const result = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: [user('u1', 't1'), modelOnRun('theirs', 't1', 'run-2')],
        runHeaders: [runHeader('run-2', 'model-b', 'conn-b')],
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        summarize: () => {
          attempts += 1;
          throw new HistoryCompactSummarizerError('input_too_large');
        },
      }),
    );

    assert.equal(attempts, 1);
    assert.equal(result.decision, 'fail_open');
  });

  test('fails open without retrying when no accepted reply proves a boundary', async () => {
    // No model reply anywhere, so no request has ever been accepted on this
    // ledger; inventing a boundary would be the guess this change removes.
    let attempts = 0;
    const result = await planHistoryCompaction(
      planInput({
        phase: 'standalone',
        orderedEvents: [user('u1', 't1'), user('u2', 't1'), user('u3', 't2')],
        runHeaders: HEADERS_A,
        acceptedRoute: ROUTE_A,
        reserveTailEvents: 0,
        summarize: () => {
          attempts += 1;
          throw new HistoryCompactSummarizerError('input_too_large');
        },
      }),
    );

    assert.equal(attempts, 1);
    assert.equal(result.decision, 'fail_open');
  });

  test('fails open on an input-too-large rejection with the summarizer reason', async () => {
    // The retreat is bounded by what a provider has already accepted, so a
    // rejection that outlives it fails open carrying the summarizer's own
    // reason rather than a span-selection one.
    const result = await planHistoryCompaction(
      planInput({
        summarize: () => {
          throw new HistoryCompactSummarizerError('input_too_large');
        },
      }),
    );
    assert.equal(result.decision, 'fail_open');
    if (result.decision !== 'fail_open') return;
    assert.equal(result.diagnosticReason, 'input_too_large');
  });

  test('persisted checkpoint replay-validates against the same ledger prefix (recovery)', async () => {
    const events = longTurnEvents();
    const result = await planHistoryCompaction(planInput({ orderedEvents: events }));
    assert.equal(result.decision, 'compacted');
    if (result.decision !== 'compacted') return;

    // Re-projecting the ledger with the persisted checkpoint must match the exact
    // covered prefix and not re-inject any raw covered event.
    const match = matchHistoryCompactCheckpointPrefix(result.checkpoint, events);
    assert.equal(match.reason, undefined);
    assert.equal(match.coveredEventCount, result.coveredRuntimeEvents.length);

    // Normal thresholds: even though the raw ledger is far below the default
    // local threshold, the accepted mid_turn checkpoint replays — recovery never
    // re-injects the replaced raw span.
    const replay = applyRuntimeEventHistoryCompact(events, {
      enabled: true,
      checkpoint: result.checkpoint,
    });
    assert.equal(replay.checkpoint?.checkpointId, result.checkpoint.checkpointId);
    const replayIds = replay.events.map((event) => event.id);
    assert.equal(replayIds[0], `history-compact:${result.checkpoint.checkpointId}`);
    assert.equal(replayIds.includes('anchor'), true);
    assert.equal(replayIds.includes('call-a'), false);
  });

  test('fails open when the summarizer throws', async () => {
    const result = await planHistoryCompaction(
      planInput({
        summarize: () => {
          throw new Error('summarizer down');
        },
      }),
    );
    assert.deepEqual(result, { decision: 'fail_open', reason: 'summarizer_failed' });
  });

  test('preserves a typed summarizer failure as the mid-turn diagnostic reason', async () => {
    const result = await planHistoryCompaction(
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

  test('fails open when the summarizer returns no checkpoint', async () => {
    const result = await planHistoryCompaction(
      planInput({
        summarize: () => '',
      }),
    );
    assert.deepEqual(result, { decision: 'fail_open', reason: 'summarizer_failed' });
  });

  test('the write gate rejects a malformed summary from any producer', async () => {
    // The default summarizer validates its own completions; the write gate
    // enforces the same invariant for any other producer (#3029).
    const result = await planHistoryCompaction(
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
    const outcome = await planHistoryCompaction(
      planInput({
        orderedEvents: events,
        reserveTailEvents: 1,
      }),
    );
    assert.deepEqual(outcome, { decision: 'fail_open', reason: 'no_safe_completed_span' });
  });

  test('does not issue a post-fold window verdict', async () => {
    // Review round-3 finding A: a post-fold re-estimate that subtracts the
    // RAW covered span is wrong on a rolling (second) compaction — the
    // previous request was already `[block, anchor, tail]` and never carried
    // that raw prefix, so the subtraction over-credits the fold and passes a
    // still-over-window request. The engine therefore makes NO window claim
    // after folding: it returns the shape and the backend owner re-measures
    // the actual replacement payload.
    const outcome = await planHistoryCompaction(planInput());
    assert.equal(outcome.decision, 'compacted');
  });

  // Note: a fold whose materialized replacement does not SHRINK the request
  // (e.g. a runaway summary block) is refused at the backend hook, which
  // measures the real payload bytes — see the mid-turn backend suite. The
  // engine works on runtime-event char estimates and makes no such claim.

  test('rolls forward from a matching previous checkpoint (only the new span is summarized)', async () => {
    const events = longTurnEvents();
    const first = await planHistoryCompaction(
      planInput({
        orderedEvents: events.slice(0, 5), // fold through res-a
      }),
    );
    assert.equal(first.decision, 'compacted');
    if (first.decision !== 'compacted') return;

    let seenNewlyFolded: string[] = [];
    const second = await planHistoryCompaction(
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
/** A model reply produced by a named run, so a route can be attached to it. */
function modelOnRun(id: string, turnId: string, runId: string, text: string = id): RuntimeEvent {
  return { ...model(id, turnId, text), runId, invocationId: runId };
}
function runHeader(runId: string, modelId: string, llmConnectionId: string): AgentRunHeader {
  return {
    runId,
    sessionId: 'session-1',
    turnId: 'turn-1',
    status: 'completed',
    backendKind: 'ai-sdk',
    llmConnectionId,
    llmConnectionSlug: llmConnectionId,
    modelId,
    cwd: '/tmp/maka',
    permissionMode: 'ask',
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  };
}
const ROUTE_A = { modelId: 'model-a', connectionId: 'conn-a' };
const HEADERS_A = [runHeader('run-1', 'model-a', 'conn-a')];

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
