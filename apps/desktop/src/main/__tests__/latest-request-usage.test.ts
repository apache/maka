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
  // read the fold's own record as a count of zero.
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
  // The fold replaced the prompt the newest count described, and nothing has
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

test('a measurement newer than the boundary stands, which is the post-fold reading', () => {
  const reading = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }, 1_000),
      compactionNote('context_compacted', 2_000),
      usage({ inputTokens: 30, outputTokens: 5, modelId: MODEL, connectionId: 'conn-a' }, 3_000),
    ],
    MODEL,
    ROUTE,
  );
  assert.deepEqual(reading, { kind: 'tokens', tokens: 35 });
});

test('a failed-open fold is not a boundary', () => {
  // The fold was refused and the request went out with its full raw history, so
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
      latestRequestUsage: { kind: 'tokens', tokens: 120 },
      live: { usageTokens: 130, completedAt: 1_500 },
    }),
    { kind: 'measured', tokens: 130 },
  );
  // No snapshot at all leaves the anchor standing.
  assert.deepEqual(
    resolveContextUsage({ latestRequestUsage: { kind: 'tokens', tokens: 120 } }),
    { kind: 'measured', tokens: 120 },
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
  // The manual `/compact` case: the snapshot still describes the pre-fold
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

test('a snapshot newer than the boundary is the post-fold reading', () => {
  // A mid-turn fold is followed by steps that really do measure the smaller
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

test('equal or missing boundary times cannot establish a post-fold measurement', () => {
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
