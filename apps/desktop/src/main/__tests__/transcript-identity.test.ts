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
import test from 'node:test';
import type { DesktopTranscriptBatch } from '../../preload/transcript-contract.js';
import {
  adoptTranscriptIdentity,
  type DesktopTranscriptIdentity,
} from '../../preload/transcript-identity.js';

function batch(overrides: Partial<DesktopTranscriptBatch> = {}): DesktopTranscriptBatch {
  return {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
    durableThrough: null,
    fragments: [],
    evictedDurableSequences: [],
    completedOverlayMessageIds: [],
    hasOlder: false,
    hasNewer: false,
    reset: false,
    ready: true,
    deliverySequence: 1,
    ...overrides,
  };
}

test('initializes the tracked identity from the first accepted batch', () => {
  const first = batch({ generation: 'generation-1', hostEpoch: 'host-1' });
  assert.deepEqual(adoptTranscriptIdentity(undefined, first), {
    generation: 'generation-1',
    hostEpoch: 'host-1',
  });
});

test('keeps the current identity for a regular batch', () => {
  const current: DesktopTranscriptIdentity = { generation: 'generation-1', hostEpoch: 'host-1' };
  assert.equal(adoptTranscriptIdentity(current, batch()), current);
});

test('adopts a reset batch identity so the next range request targets the replacement Host', () => {
  const current: DesktopTranscriptIdentity = { generation: 'generation-1', hostEpoch: 'host-1' };
  const replacement = batch({
    generation: 'generation-2',
    hostEpoch: 'host-2',
    reset: true,
  });
  const next = adoptTranscriptIdentity(current, replacement);
  assert.deepEqual(next, { generation: 'generation-2', hostEpoch: 'host-2' });
  // The adopted identity stays in effect for later regular batches.
  assert.equal(
    adoptTranscriptIdentity(next, batch({ generation: 'generation-2', hostEpoch: 'host-2' })),
    next,
  );
});

test('does not mutate an identity already captured by a dispatched request', () => {
  const dispatched: DesktopTranscriptIdentity = { generation: 'generation-1', hostEpoch: 'host-1' };
  const replacement = batch({
    generation: 'generation-2',
    hostEpoch: 'host-2',
    reset: true,
  });
  adoptTranscriptIdentity(dispatched, replacement);
  // The host-1 request keeps its epoch; the Main-process guard fails it closed.
  assert.deepEqual(dispatched, { generation: 'generation-1', hostEpoch: 'host-1' });
});
