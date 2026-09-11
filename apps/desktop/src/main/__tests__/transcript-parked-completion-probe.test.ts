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
import { encodeDesktopTranscriptChange, encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';

const identity = { sessionId: 'session-1', hostEpoch: 'host-1', generation: 'generation-1' };
const message = (sequence: number, text = String(sequence)): StoredMessage =>
  ({ type: 'assistant', id: `message-${sequence}`, turnId: `turn-${sequence}`, ts: 1, text, modelId: 'test' });

test('a Turn completing at the tail does not splice into a window parked far from it', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  // A jump to 5 during a run: loadAround's snapshot carries the live overlay (21).
  const navigation = store.navigate();
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, navigation, durableThrough: 20,
    durable: [{ sequence: 5, message: message(5) }, { sequence: 6, message: message(6) }],
    overlay: [message(21, 'partial')], hasOlder: true, hasNewer: true,
  })) store.accept(batch);
  // 21 completes; the tail broadcast carries its durable row.
  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 20, durableThrough: 21,
    durableUpserts: [{ sequence: 21, message: message(21, 'partial and completed') }],
  })) store.accept(batch);
  // 7..20 are not in the window, so 21 cannot join its durable range contiguously.
  assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [5, 6]);
});