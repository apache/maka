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
import { selectLatestRequestUsage } from '../../renderer/chat-composer-region.js';

const ROUTE = { llmConnectionId: 'conn-a' };
const MODEL = 'model-a';

function usage(anchor?: {
  inputTokens: number;
  outputTokens?: number;
  modelId?: string;
  connectionId?: string;
}) {
  return { type: 'token_usage', ...(anchor ? { lastRequestAnchor: anchor } : {}) };
}

test('reads the newest anchor on the active route', () => {
  const tokens = selectLatestRequestUsage(
    [
      usage({ inputTokens: 10, outputTokens: 2, modelId: MODEL, connectionId: 'conn-a' }),
      { type: 'assistant' },
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }),
    ],
    { hasNewer: false },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, 120);
});

test('scans past an anchorless usage row, which is what manual compaction writes', () => {
  // `/compact` appends a synthetic `token_usage` with no anchor. The runtime's
  // own reader skips it and keeps the last real request; stopping there would
  // blank the indicator after every manual compaction.
  const tokens = selectLatestRequestUsage(
    [
      usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' }),
      usage(),
    ],
    { hasNewer: false },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, 120);
});

test('refuses an anchor from another model', () => {
  // A token count is a number in one model's tokenizer. Pairing model A's
  // count with model B's window produces a precise-looking figure about a
  // request the user is not making.
  const tokens = selectLatestRequestUsage(
    [usage({ inputTokens: 100_000, modelId: 'model-b', connectionId: 'conn-a' })],
    { hasNewer: false },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, undefined);
});

test('refuses an anchor from another connection', () => {
  const tokens = selectLatestRequestUsage(
    [usage({ inputTokens: 100, modelId: MODEL, connectionId: 'conn-b' })],
    { hasNewer: false },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, undefined);
});

test('refuses an anchor written before anchors carried their route', () => {
  const tokens = selectLatestRequestUsage(
    [usage({ inputTokens: 100, outputTokens: 20 })],
    { hasNewer: false },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, undefined);
});

test('refuses every anchor while the loaded range is not the session tail', () => {
  // Browsing history must not report an older range's usage as current.
  const tokens = selectLatestRequestUsage(
    [usage({ inputTokens: 100, outputTokens: 20, modelId: MODEL, connectionId: 'conn-a' })],
    { hasNewer: true },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, undefined);
});

test('refuses when there is no active route yet', () => {
  const anchored = [usage({ inputTokens: 100, modelId: MODEL, connectionId: 'conn-a' })];
  assert.equal(selectLatestRequestUsage(anchored, undefined, undefined, ROUTE), undefined);
  assert.equal(selectLatestRequestUsage(anchored, undefined, MODEL, undefined), undefined);
});

test('refuses a non-positive input count', () => {
  const tokens = selectLatestRequestUsage(
    [usage({ inputTokens: 0, modelId: MODEL, connectionId: 'conn-a' })],
    { hasNewer: false },
    MODEL,
    ROUTE,
  );
  assert.equal(tokens, undefined);
});
