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
import { deferred } from '@maka/core/test-only/async-primitives';
import type { StoredMessage } from '@maka/core/session';
import { SESSION_CONTINUITY_SCHEMA_VERSION, type SessionTranscriptPage } from '@maka/runtime-host/protocol';
import type { DesktopTranscriptBatch, DesktopTranscriptRangeRequest } from '../../preload/transcript-contract.js';
import { DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

// Drives the real observer, replica and Renderer store with a fake Host whose
// jump read (loadAround) is held until a fill has been queued behind it.
const PAGE_BYTES = 128 * 1024;
const THROUGH = 20;

async function harness() {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const eventsClosed = deferred<void>();
  const aroundEntered = deferred<void>();
  const releaseAround = deferred<void>();
  const bootstrap = page();
  const decoded = new Map<SessionTranscriptPage, { messages: Array<ReturnType<typeof record>>; nextCursor: string | null }>([
    [bootstrap, { messages: [record(18), record(19), record(20)], nextCursor: 'older' }],
  ]);
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => runtimeHostSessionFixture({
      snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() { await eventsClosed.promise; } },
      transcriptBootstrap: { throughSequence: THROUGH, overlayMessageCount: 0, durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' } },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (candidate) => decoded.get(candidate)!,
      loadTranscriptPage: async (request) => {
        const candidate = page();
        if (request.direction === 'newer') {
          aroundEntered.resolve();
          await releaseAround.promise;
          decoded.set(candidate, { messages: [record(5), record(6)], nextCursor: 'newer' });
        } else if (request.maxBytes === 1) {
          decoded.set(candidate, { messages: [record(4)], nextCursor: 'older' });
        } else {
          decoded.set(candidate, { messages: [record(request.anchorSequence! - 1)], nextCursor: 'older' });
        }
        return candidate;
      },
      async close() { eventsClosed.resolve(); },
    }) },
    emitSessionsChanged() {},
  });
  const ack = (batch: DesktopTranscriptBatch) => observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence, 1);
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 1, once() {}, off() {},
    send(_channel, batch) { store.accept(batch); queueMicrotask(() => ack(batch)); },
  });
  const request = (navigation: number, anchorSequence: number): DesktopTranscriptRangeRequest => ({
    consumerId: 'consumer-1', sessionId: 'session-1', hostEpoch: 'host-1', anchorSequence, maxBytes: PAGE_BYTES, navigation,
  });
  const sequences = () => store.durableEntries().map(({ sequence }) => sequence);
  return { store, observer, request, sequences, aroundEntered, releaseAround };
}

test('a fill issued while a jump is pending does not splice the old edge onto the new window', async () => {
  const h = await harness();
  try {
    assert.deepEqual(h.sequences(), [18, 19, 20]);
    const navigation = h.store.navigate();
    const jump = h.observer.loadTranscriptAround(h.request(navigation, 5), 1);
    await h.aroundEntered.promise;
    // Anchored on the window still on screen (18), under the jump's navigation.
    const fill = h.observer.loadTranscriptBefore(h.request(navigation, h.store.range().oldestSequence!), 1);
    h.releaseAround.resolve();
    await Promise.all([jump, fill]);
    assert.deepEqual(h.sequences(), [5, 6]);
  } finally {
    await h.observer.close();
  }
});

test('a trim and a fill while a jump is pending do not make Main drop the jump', async () => {
  const h = await harness();
  try {
    const navigation = h.store.navigate();
    const jump = h.observer.loadTranscriptAround(h.request(navigation, 5), 1);
    await h.aroundEntered.promise;
    assert.equal(h.store.retain(19, 20), true);
    const fill = h.observer.loadTranscriptBefore(h.request(navigation, h.store.range().oldestSequence!), 1);
    h.releaseAround.resolve();
    await Promise.all([jump, fill]);
    assert.ok(h.sequences().includes(5), `the jump target never arrived: ${JSON.stringify(h.sequences())}`);
  } finally {
    await h.observer.close();
  }
});

function record(identity: number) {
  const message: StoredMessage = { type: 'assistant', id: `message-${identity}`, turnId: `turn-${identity}`, ts: 1, text: String(identity), modelId: 'test' };
  return { identity, message };
}
function page(): SessionTranscriptPage {
  return { kind: 'page', sessionId: 'session-1', source: 'durable', direction: 'older', throughSequence: THROUGH,
    rawBytes: 1, fragments: [], rangeBoundarySequence: null, protectedTurnSequence: null, nextCursor: null };
}
function continuitySnapshot() {
  return { schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: { sessionId: 'session-1', metadataRevision: 1, status: 'running' as const, createdAt: 1, isArchived: false },
    projectionRevision: 1, rootTurn: null, goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] }, interactions: { pending: [] } };
}
