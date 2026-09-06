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
import {
  deriveInspectorOverviewModel,
  RING_ACTIVE_MIN_SWEEP,
  RING_MIN_SWEEP,
  usageRingArcs,
} from '../../renderer/features/workbar/testing.js';
import type { UsageSummaryV2 } from '@maka/core/usage-stats/types';

function usageSummary(overrides: Partial<UsageSummaryV2> = {}): UsageSummaryV2 {
  return {
    range: { from: 0, to: 1 },
    totalRequests: 3,
    totalCostUsd: 0.02,
    totalTokens: {
      input: 4_000_000,
      output: 60_300,
      cacheMiss: 100_000,
      cacheRead: 3_900_000,
      cacheWrite: 0,
      reasoning: 12_000,
      total: 4_060_300,
    },
    cacheHitRequests: 2,
    cacheCreateRequests: 0,
    errorRequests: 0,
    totalDurationMs: 0,
    ...overrides,
  };
}

test('splits the session metered tokens the way a bill reads', () => {
  const { tokenUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({ totalDurationMs: 1_885_000 }),
  );

  assert.ok(tokenUsage);
  assert.deepEqual(
    tokenUsage.segments.map((segment) => [segment.kind, segment.tokens]),
    [
      ['cacheRead', 3_900_000],
      ['cacheMiss', 100_000],
      ['output', 60_300],
    ],
  );
  // The readout is the sum of the drawn rows, so the legend and its total
  // cannot disagree even when the ledger's own parts drifted.
  assert.equal(
    tokenUsage.total,
    tokenUsage.segments.reduce((carry, segment) => carry + segment.tokens, 0),
  );
});

test('derives uncached input as the prompt residual when a provider reports only its cache', () => {
  // A cache-reading-only provider leaves the ledger's cacheMiss at zero; the
  // row must still carry what the session paid as uncached input.
  const { tokenUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({
      totalTokens: {
        input: 260_500,
        output: 60_300,
        cacheMiss: 0,
        cacheRead: 200_000,
        cacheWrite: 0,
        reasoning: 0,
        total: 320_800,
      },
    }),
  );

  assert.deepEqual(
    tokenUsage?.segments.map((segment) => [segment.kind, segment.tokens]),
    [
      ['cacheRead', 200_000],
      ['cacheMiss', 60_500],
      ['output', 60_300],
    ],
  );
});

test('keeps the ledger cacheMiss as a floor for records that reported no prompt total', () => {
  const { tokenUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({
      totalTokens: {
        input: 0,
        output: 100,
        cacheMiss: 500,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 100,
      },
    }),
  );

  assert.deepEqual(
    tokenUsage?.segments.map((segment) => [segment.kind, segment.tokens]),
    [
      ['cacheMiss', 500],
      ['output', 100],
    ],
  );
});

test('a session with nothing metered has no token split to show', () => {
  const { tokenUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({
      totalTokens: {
        input: 0,
        output: 0,
        cacheMiss: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
      },
    }),
  );
  assert.equal(tokenUsage, undefined);
  assert.equal(deriveInspectorOverviewModel(undefined, undefined).tokenUsage, undefined);
});

test('shows the token split even when usage coverage is partial, since the rows are what ran', () => {
  // The cache-hit RATE goes unavailable under partial usage — a rate over a
  // part is a lie. The split stays: its rows state what was recorded, which
  // only undercounts, never fabricates.
  const { tokenUsage, cacheHitRate } = deriveInspectorOverviewModel(undefined, {
    ...usageSummary(),
    provenance: {
      coverage: {
        attempts: 3,
        pricedAttempts: 3,
        unpricedAttempts: 0,
        usageReportedAttempts: 2,
        usagePartialAttempts: 1,
        usageMissingAttempts: 0,
      },
      legacyRecords: 0,
      unreadableRecords: 0,
      pendingRepairs: 0,
    },
  });
  assert.ok(tokenUsage);
  assert.equal(cacheHitRate, undefined);
});

test('splits recorded time between model calls and tool executions', () => {
  const { durationUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({ totalDurationMs: 1_873_000, toolUsage: { requests: 78, durationMs: 78_000 } }),
  );

  assert.deepEqual(
    durationUsage?.segments.map((segment) => [segment.kind, segment.count, segment.durationMs]),
    [
      ['model', 3, 1_873_000],
      ['tool', 78, 78_000],
    ],
  );
  assert.equal(durationUsage?.totalDurationMs, 1_873_000 + 78_000);
});

test('keeps a cache-read share the provider reported without a prompt total', () => {
  // Core leaves the ledger's cacheRead unclamped when no prompt total was
  // reported, so cacheRead > input is a normal aggregate there — clamping it
  // to input would erase exactly the sessions the split exists to describe.
  const { tokenUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({
      totalTokens: {
        input: 0,
        output: 100,
        cacheMiss: 60_000,
        cacheRead: 200_000,
        cacheWrite: 0,
        reasoning: 0,
        total: 260_100,
      },
    }),
  );

  assert.deepEqual(
    tokenUsage?.segments.map((segment) => [segment.kind, segment.tokens]),
    [
      ['cacheRead', 200_000],
      ['cacheMiss', 60_000],
      ['output', 100],
    ],
  );
  assert.equal(tokenUsage?.total, 260_100);
});

test('a host that measured zero model time keeps its row and its call count', () => {
  // Presence follows the reported field, not a zero-derived default: zero is
  // a measurement, and the row carries the count the model totals show too.
  const { durationUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({ totalDurationMs: 0 }),
  );
  assert.deepEqual(
    durationUsage?.segments.map((segment) => [segment.kind, segment.count, segment.durationMs]),
    [['model', 3, 0]],
  );
});

test('a row with neither a clock nor a count is dropped', () => {
  const { durationUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({ totalRequests: 0, totalDurationMs: 0 }),
  );
  assert.equal(durationUsage, undefined);
});

test('a tool row without a recorded duration still reports its count', () => {
  const { durationUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({ totalRequests: 0, totalDurationMs: 0, toolUsage: { requests: 4, durationMs: 0 } }),
  );

  assert.deepEqual(
    durationUsage?.segments.map((segment) => [segment.kind, segment.count, segment.durationMs]),
    [['tool', 4, 0]],
  );
  assert.equal(durationUsage?.totalDurationMs, 0);
});

test('model time without tool usage reads as a single-segment split', () => {
  const { durationUsage } = deriveInspectorOverviewModel(
    undefined,
    usageSummary({ totalRequests: 5, totalDurationMs: 2_500 }),
  );

  assert.deepEqual(
    durationUsage?.segments.map((segment) => [segment.kind, segment.count, segment.durationMs]),
    [['model', 5, 2_500]],
  );
});

test('ring arcs keep reading order and clamp the last segment to the full turn', () => {
  const arcs = usageRingArcs(
    [
      { kind: 'cacheRead' as const, amount: 1 },
      { kind: 'cacheMiss' as const, amount: 1 },
      { kind: 'output' as const, amount: 1 },
    ],
    3,
  );
  assert.deepEqual(
    arcs.map((arc) => arc.kind),
    ['cacheRead', 'cacheMiss', 'output'],
  );
  assert.equal(arcs[0]?.start, 0);
  // The last arc is clamped to the full turn rather than accumulated, so a
  // rounded share can never leave an unexplained sliver at the seam.
  assert.equal(arcs.at(-1)?.end, 1);
  for (const arc of arcs) {
    assert.ok(arc.end > arc.start);
    assert.match(arc.d, /^M [\d. ]+ A/);
    assert.match(arc.d, / Z$/);
  }
});

test('a segment owning the whole ring walks two half-turns instead of one arc', () => {
  const arcs = usageRingArcs([{ kind: 'model' as const, amount: 2_500 }], 2_500);
  assert.equal(arcs.length, 1);
  assert.equal(arcs[0]?.start, 0);
  assert.equal(arcs[0]?.end, 1);
  // One arc cannot sweep 360°; two half arcs render the full donut.
  assert.equal(arcs[0]?.d.match(/ A /g)?.length, 4);
});

test('a ring with nothing measured draws no arcs and leaves the muted track', () => {
  assert.equal(usageRingArcs([{ kind: 'tool' as const, amount: 0 }], 0).length, 0);
  assert.equal(usageRingArcs([], 100).length, 0);
});

test('a nonzero sliver keeps a visible sweep even when its share rounds to zero', () => {
  const arcs = usageRingArcs(
    [
      { kind: 'model' as const, amount: 77_000 },
      { kind: 'tool' as const, amount: 35 },
    ],
    77_035,
  );
  const tool = arcs[1];
  // The end-of-turn clamp re-derives the last sweep from the running cursor,
  // so compare with the usual floating-point courtesy.
  assert.ok(tool.end - tool.start >= RING_MIN_SWEEP - 1e-9);
  assert.equal(tool.end, 1);
});

test('hovering a tiny segment expands it on the ring so the highlight lands somewhere', () => {
  const arcs = usageRingArcs(
    [
      { kind: 'model' as const, amount: 77_000 },
      { kind: 'tool' as const, amount: 35 },
    ],
    77_035,
    'tool',
  );
  const tool = arcs[1];
  // The end-of-turn clamp re-derives the last sweep from the running cursor,
  // so compare with the usual floating-point courtesy.
  assert.ok(tool.end - tool.start >= RING_ACTIVE_MIN_SWEEP - 1e-9);
  // The cost of the focus floor comes out of the dominant share, and the
  // seam still closes on the full turn.
  assert.ok(arcs[0].end <= 1 - RING_ACTIVE_MIN_SWEEP + 1e-9);
  assert.equal(tool.end, 1);
});

test('hovering the dominant segment leaves the layout untouched', () => {
  const arcs = usageRingArcs(
    [
      { kind: 'model' as const, amount: 77_000 },
      { kind: 'tool' as const, amount: 35 },
    ],
    77_035,
    'model',
  );
  assert.ok(arcs[0].end >= 1 - RING_MIN_SWEEP);
  assert.equal(arcs[1].end, 1);
});
