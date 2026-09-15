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
import type { StoredMessage } from '@maka/core/session';
import { DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import {
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptPage,
  encodeDesktopTranscriptSnapshot,
} from '../desktop-transcript-ipc.js';

const identity = { sessionId: 'session-1', hostEpoch: 'host-1', generation: 'generation-1' };
const message = (sequence: number, text = String(sequence)): StoredMessage =>
  ({ type: 'assistant', id: `message-${sequence}`, turnId: `turn-${sequence}`, ts: 1, text, modelId: 'test' });

test('a Turn completing at the tail does not splice into a window parked far from it', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const navigation = store.navigate();
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 20,
    durable: [{ sequence: 5, message: message(5) }, { sequence: 6, message: message(6) }],
    hasOlder: true, hasNewer: true,
  }, navigation)) store.accept(batch);
  // 21 completes; the tail broadcast carries its durable row.
  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 20, durableThrough: 21,
    durableUpserts: [{ sequence: 21, message: message(21, 'partial and completed') }],
  })) store.accept(batch);
  // 7..20 are not in the window, so 21 cannot join its durable range contiguously.
  assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [5, 6]);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-5', 'message-6']);

  for (const batch of encodeDesktopTranscriptPage(identity, {
    durableThrough: 21, hasOlder: true, hasNewer: false,
    durable: Array.from({ length: 15 }, (_, index) => ({
      sequence: index + 7,
      message: message(index + 7, index === 14 ? 'partial and completed' : undefined),
    })),
  }, { direction: 'newer', anchor: 6 })) store.accept(batch);
  const ids = store.snapshot().messages.map(({ id }) => id);
  assert.deepEqual(ids.slice(-2), ['message-20', 'message-21']);
  assert.equal(ids.length, 17, 'reading forward brings 21 in once');
});
