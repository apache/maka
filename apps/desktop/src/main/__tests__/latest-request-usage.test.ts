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
  resolveContextUsage,
  selectLatestRequestUsage,
} from '../../renderer/application/contracts/session-inspector/latest-request-usage.js';

const ROUTE = { llmConnectionId: 'conn-a' };
const MODEL = 'model-a';

function usage(
  anchor?: {
    inputTokens: number;
    outputTokens?: number;
    modelId?: string;
    connectionId?: string;
    completedAt?: number;
  },
  ts?: number,
) {
  return {
    type: 'token_usage',
    ...(ts !== undefined ? { ts } : {}),
    ...(anchor ? { lastRequestAnchor: anchor } : {}),
  };
}

function compactionNote(kind: string, ts?: number) {
  return { type: 'system_note', kind, ...(ts !== undefined ? { ts } : {}) };
}

function appliedNote(ts?: number, turnId?: string) {
  return {
    type: 'system_note',
    kind: 'context_compaction_applied',
    ...(ts !== undefined ? { ts } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

function displayNote(ts?: number, turnId?: string) {
  return {
    type: 'system_note',
    kind: 'context_compacted',
    ...(ts !== undefined ? { ts } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
  };
}

test('reads the newest anchor on the active route', () => {
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 10, outputTokens: 2, modelId: MODEL, connectionId: 'conn-a' }),
      { type: 'assistant' },
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 120 });
});

test('scans past an anchorless usage row, which is what manual compaction writes', () => {
  // `/compact` appends a synthetic `token_usage` with no anchor. The runtime's
  // own reader skips it and keeps the last real request; stopping there would
  // read the compaction's own record as a count of zero.
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }),
      usage(),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 120 });
});

test('a compaction boundary newer than every measurement supersedes it', () => {
  // The compaction replaced the prompt the newest count described, and nothing has
  // measured the replacement. The stale figure must not be shown as a live
  // reading of what the session is about to send.
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }, 1_000),
      compactionNote('context_compacted', 2_000),
      usage(undefined, 2_100),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 2_000 });
});

test('a measurement newer than the boundary stands, which is the post-compaction reading', () => {
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }, 1_000),
      compactionNote('context_compacted', 2_000),
      usage({ inputTokens: 30, outputTokens: 5, modelId: MODEL, connectionId: 'conn-a', completedAt: 3_000 }, 3_100),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 35, at: 3_000 });
});

test('a post-compaction anchor supersedes a pre-compaction snapshot while diagnostics are pending', () => {
  const latestRequestUsage = selectLatestRequestUsage(
    [
      usage({ inputTokens: 90_000, modelId: MODEL, connectionId: 'conn-a' }, 1_000),
      compactionNote('context_compacted', 2_000),
      usage({ inputTokens: 35_000, modelId: MODEL, connectionId: 'conn-a', completedAt: 2_500 }, 3_000),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(latestRequestUsage, { kind: 'tokens', tokens: 35_000, at: 2_500 });
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage,
      live: { usageTokens: 90_000, contextWindow: 100_000, completedAt: 1_000 },
    }),
    { kind: 'measured', tokens: 35_000 },
  );
});

test('the token row written after its own request keeps the settled snapshot and window', () => {
  const latestRequestUsage = selectLatestRequestUsage(
    [usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a', completedAt: 1_000 }, 1_100)],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage,
      live: { usageTokens: 100, contextWindow: 1_000, completedAt: 1_000 },
    }),
    { kind: 'measured', tokens: 100, meteredWindow: 1_000 },
  );
});

test('a legacy anchor without settlement time cannot displace a live snapshot', () => {
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: selectLatestRequestUsage(
        [{
          type: 'token_usage', ts: 1_100,
          lastRequestAnchor: { inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' },
        }],
        MODEL,
        ROUTE,
      ),
      live: { usageTokens: 100, contextWindow: 1_000, completedAt: 1_000 },
    }),
    { kind: 'measured', tokens: 100, meteredWindow: 1_000 },
  );
});

test('a timed anchor wins when the retained snapshot has no settlement time', () => {
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'tokens', tokens: 35_000, at: 3_000 },
      live: { usageTokens: 90_000 },
    }),
    { kind: 'measured', tokens: 35_000 },
  );
});

test('a failed-open compaction is not a boundary', () => {
  // The compaction was refused and the request went out with its full raw history, so
  // the measurement behind the note still describes what was sent.
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }),
      compactionNote('context_compaction_failed_open'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 120 });
});

test('a boundary with no measurement behind it is still a superseded reading', () => {
  const reading = selectLatestRequestUsage([compactionNote('context_compacted')], MODEL, ROUTE);
  assert.deepEqual(reading, { kind: 'compacted' });
});

test('an apply-time boundary row supersedes with its own write time', () => {
  // Mid-turn compactions record `context_compaction_applied` when the compaction lands,
  // so the boundary time is the compaction moment even mid-turn.
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }, 1_000),
      appliedNote(1_500, 'turn-1'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 1_500 });
});

test('a settlement display note adopts the apply time of the compaction it describes', () => {
  // The mid-turn case: `context_compaction_applied` is written when the compaction
  // lands and `context_compacted` at settlement. The boundary time is the
  // compaction's, so post-compaction measurements settling before the turn ends are not
  // misjudged as pre-compaction.
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }, 1_000),
      appliedNote(1_500, 'turn-1'),
      displayNote(9_000, 'turn-1'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 1_500 });
});

test('the latest apply row wins when compaction is applied twice in one turn', () => {
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      appliedNote(4_000, 'turn-1'),
      displayNote(9_000, 'turn-1'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 4_000 });
});

test('an apply row from another turn does not lend the note its time', () => {
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      displayNote(9_000, 'turn-2'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 9_000 });
});

test('a usage row between the apply and the note keeps the note time', () => {
  // Cannot arise in written data — the turn's usage row lands after the
  // note — but the hunt stops at it rather than reaching across turns.
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      usage({ inputTokens: 30, modelId: MODEL, connectionId: 'conn-a', completedAt: 2_000 }, 2_100),
      displayNote(9_000, 'turn-1'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 9_000 });
});

test('a usage row settled after the notes but anchored before the compaction is superseded (#5547)', () => {
  // The failed-send settlement order: the apply row, then the display note,
  // then the usage row — whose anchor is still the last COMPLETED request,
  // which finished before the compaction because its retry never did. Position
  // alone would misread the anchor as a post-compaction measurement.
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      displayNote(9_000, 'turn-1'),
      usage(
        {
          inputTokens: 100,
          outputTokens: 20,
          modelId: MODEL,
          connectionId: 'conn-a',
          completedAt: 1_000,
        },
        9_100,
      ),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 1_500 });
});

test('a post-compaction measurement settled after the notes still stands', () => {
  // Same ledger shape, healthy send: the retry completed after the compaction, so
  // the anchor is genuinely post-compaction and stays the newest reading.
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      displayNote(9_000, 'turn-1'),
      usage(
        { inputTokens: 30, modelId: MODEL, connectionId: 'conn-a', completedAt: 2_000 },
        9_100,
      ),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 30, at: 2_000 });
});

test('a boundary tied with the anchored completion cannot prove the anchor is post-compaction', () => {
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      usage(
        { inputTokens: 30, modelId: MODEL, connectionId: 'conn-a', completedAt: 1_500 },
        9_100,
      ),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'compacted', at: 1_500 });
});

test('an anchor without a completion time cannot be superseded by a boundary behind it', () => {
  const reading = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      usage({ inputTokens: 30, modelId: MODEL, connectionId: 'conn-a' }, 9_100),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 30 });
});

test('the failed-retry ledger reads stale, not the pre-compaction measurement (#5547)', () => {
  // End to end: the send compacted at 1_500 and its retry never completed, so the
  // live snapshot and the settled anchor both describe the request that
  // finished at 1_000 — pre-compaction context. The gauge must report stale.
  const latestRequestUsage = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      displayNote(9_000, 'turn-1'),
      usage(
        {
          inputTokens: 190_000,
          modelId: MODEL,
          connectionId: 'conn-a',
          completedAt: 1_000,
        },
        9_100,
      ),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage,
      live: { usageTokens: 190_000, contextWindow: 200_000, completedAt: 1_000 },
    }),
    { kind: 'stale', reason: 'compaction' },
  );
});

test('a post-compaction snapshot is measured against the apply time, not settlement', () => {
  // The bug this event fixes: the compaction landed at 1_500, a later request
  // settled at 2_000, and the turn itself settled at 9_000. Reading the
  // display note's own write time would hide the valid post-compaction snapshot.
  const latestRequestUsage = selectLatestRequestUsage(
    [
      appliedNote(1_500, 'turn-1'),
      displayNote(9_000, 'turn-1'),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage,
      live: { usageTokens: 30_000, contextWindow: 100_000, completedAt: 2_000 },
    }),
    { kind: 'measured', tokens: 30_000, meteredWindow: 100_000 },
  );
});

test('refuses an anchor from another model', () => {
  // A token count is a number in one model's tokenizer. Pairing model A's
  // count with model B's window produces a precise-looking figure about a
  // request the user is not making.
  const reading = selectLatestRequestUsage(
    [usage({ inputTokens: 100_000, modelId: 'model-b', connectionId: 'conn-a' })],
    MODEL,
    ROUTE,
  );
  assert.equal(reading, undefined);
});

test('refuses an anchor from another connection', () => {
  const reading = selectLatestRequestUsage(
    [usage({ inputTokens: 100, modelId: MODEL, connectionId: 'conn-b' })],
    MODEL,
    ROUTE,
  );
  assert.equal(reading, undefined);
});

test('refuses an anchor written before anchors carried their route', () => {
  const reading = selectLatestRequestUsage(
    [usage({ inputTokens: 100, outputTokens: 20 })],
    MODEL,
    ROUTE,
  );
  assert.equal(reading, undefined);
});

test('refuses when there is no active route yet', () => {
  const anchored = [usage({ inputTokens: 100, modelId: MODEL, connectionId: 'conn-a' })];
  assert.equal(selectLatestRequestUsage(anchored, undefined, ROUTE), undefined);
  assert.equal(selectLatestRequestUsage(anchored, MODEL, undefined), undefined);
});

test('refuses a non-positive input count', () => {
  const reading = selectLatestRequestUsage(
    [usage({ inputTokens: 0, modelId: MODEL, connectionId: 'conn-a' })],
    MODEL,
    ROUTE,
  );
  assert.equal(reading, undefined);
});

test('the snapshot is the reading when it is the newer answer', () => {
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'tokens', tokens: 120, at: 1_000 },
      live: { usageTokens: 130, completedAt: 1_500 },
    }),
    { kind: 'measured', tokens: 130 },
  );
  // No snapshot at all leaves the anchor standing.
  assert.deepEqual(
    resolveContextUsage({ latestRequestUsage: { kind: 'tokens', tokens: 120 } }),
    { kind: 'measured', tokens: 120 },
  );
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'tokens', tokens: 120, at: 1_500 },
      live: { usageTokens: 130, completedAt: 1_500 },
    }),
    { kind: 'measured', tokens: 130 },
  );
  // The snapshot can still vouch when the transcript established nothing.
  assert.deepEqual(
    resolveContextUsage({ latestRequestUsage: undefined, live: { usageTokens: 130 } }),
    { kind: 'measured', tokens: 130 },
  );
  assert.deepEqual(resolveContextUsage({ latestRequestUsage: undefined }), {
    kind: 'unavailable',
  });
});

test('a boundary supersedes the snapshot it landed after', () => {
  // The manual `/compact` case: the snapshot still describes the pre-compaction
  // prompt, so the gauge says unknown rather than holding that figure.
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'compacted', at: 2_000 },
      live: { usageTokens: 90_000, completedAt: 1_000 },
    }),
    { kind: 'stale', reason: 'compaction' },
  );
  assert.deepEqual(
    resolveContextUsage({ latestRequestUsage: { kind: 'compacted', at: 2_000 } }),
    { kind: 'stale', reason: 'compaction' },
  );
  // An untimed snapshot cannot be shown to be newer than a boundary, and a
  // guess in that position is the precise-looking lie this state exists to
  // refuse.
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'compacted', at: 2_000 },
      live: { usageTokens: 90_000 },
    }),
    { kind: 'stale', reason: 'compaction' },
  );
});

test('a snapshot newer than the boundary is the post-compaction reading', () => {
  // A mid-turn compaction is followed by steps that really do measure the smaller
  // prompt, so the gauge recovers without waiting for the turn to end.
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'compacted', at: 2_000 },
      live: { usageTokens: 30_000, completedAt: 2_500 },
    }),
    { kind: 'measured', tokens: 30_000 },
  );
});


test('a selected live measurement carries only its own metered window', () => {
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'tokens', tokens: 120 },
      live: { usageTokens: 130, contextWindow: 1_000, completedAt: 1_500 },
    }),
    { kind: 'measured', tokens: 130, meteredWindow: 1_000 },
  );
  assert.deepEqual(
    resolveContextUsage({
      latestRequestUsage: { kind: 'compacted', at: 2_000 },
      live: { usageTokens: 130, contextWindow: 1_000, completedAt: 1_500 },
    }),
    { kind: 'stale', reason: 'compaction' },
  );
});

test('equal or missing boundary times cannot establish a post-compaction measurement', () => {
  for (const at of [undefined, 2_000]) {
    assert.deepEqual(
      resolveContextUsage({
        latestRequestUsage: { kind: 'compacted', at },
        live: { usageTokens: 130, completedAt: 2_000 },
      }),
      { kind: 'stale', reason: 'compaction' },
    );
  }
});
