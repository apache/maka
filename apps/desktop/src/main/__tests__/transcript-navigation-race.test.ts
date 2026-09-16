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
import type { DesktopTranscriptBatch, DesktopTranscriptHandle, DesktopTranscriptRangeRequest } from '../../preload/transcript-contract.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { encodeDesktopTranscriptPage, encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

const PAGE_BYTES = 128 * 1024;

for (const kind of ['before', 'around'] as const) {
  test(`an invalidated ${kind} page neither answers its window nor touches the tail`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const installed: number[][] = [];
    const bootstrap = page(1);
    const pending = page(1);
    const older = record(0);
    const latest = record(1);
    const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
      snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() {} },
      transcriptBootstrap: {
        throughSequence: 1, overlayMessageCount: 0,
        durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (candidate) => ({
        messages: candidate === bootstrap ? [latest] : [older],
        nextCursor: candidate === bootstrap ? 'older' : null,
      }),
      loadTranscriptPage: async () => {
        entered.resolve();
        await release.promise;
        return pending;
      },
      async close() {},
    }), { onChange: (_replica, change) => installed.push(change.durableUpserts.map(({ sequence }) => sequence)) });
    let current = true;
    const isCurrent = () => current;
    const loading = kind === 'before'
      ? replica.loadBefore(1, PAGE_BYTES, isCurrent)
      : replica.loadAround(0, PAGE_BYTES, isCurrent);
    await entered.promise;
    // The Renderer replaced its window while this page was in flight.
    current = false;
    release.resolve();
    assert.equal(await loading, undefined);
    assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [1]);
    assert.deepEqual(installed, []);
    replica.close();
  });
}

test('a global cache trim empties the tail without publishing or reading history', async () => {
  const bootstrap = page(1);
  const decoded = new Map<SessionTranscriptPage, ReturnType<typeof record>>([[bootstrap, record(1)]]);
  const requests: number[] = [];
  const changes: number[] = [];
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 1, overlayMessageCount: 0,
      durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (candidate) => ({ messages: [decoded.get(candidate)!], nextCursor: null }),
    loadTranscriptPage: async (request) => {
      assert.ok(request.throughSequence !== null);
      requests.push(request.throughSequence);
      const candidate = page(request.throughSequence);
      decoded.set(candidate, record(request.throughSequence));
      return candidate;
    },
    async close() {},
  }), { maxResidentBytes: 64, onChange: (_replica, change) => changes.push(change.durableUpserts.length) });
  try {
    await replica.advance(2);
    assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [2],
      'catch-up keeps the newest Turn and drops the oldest');
    const published = changes.length;
    requests.length = 0;

    replica.trimDurable(0);

    assert.deepEqual(replica.snapshot().durable, []);
    assert.equal(changes.length, published, 'a cache trim is not a transcript change');
    assert.deepEqual(requests, [], 'a cache trim reads nothing back');
  } finally {
    replica.close();
  }
});

test('a tail the global cache trim emptied is read back before it answers follow latest', async () => {
  const bootstrap = page(1);
  const tail = page(1);
  const reads: Array<{ direction: string; anchorSequence: number | null }> = [];
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 1, overlayMessageCount: 0,
      durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (candidate) => ({
      messages: [record(1)], nextCursor: candidate === bootstrap ? 'older' : null,
    }),
    loadTranscriptPage: async (request) => {
      reads.push({ direction: request.direction, anchorSequence: request.anchorSequence });
      return tail;
    },
    async close() {},
  }));
  try {
    replica.trimDurable(0);
    assert.deepEqual(replica.snapshot().durable, [], 'global memory pressure empties the tail');

    await replica.refillTail(PAGE_BYTES);

    assert.deepEqual(reads, [{ direction: 'older', anchorSequence: 2 }],
      'the refill reads the newest page, not history');
    const snapshot = replica.snapshot();
    assert.deepEqual(snapshot.durable.map(({ sequence }) => sequence), [1]);
    assert.equal(snapshot.durableThrough, replica.durableThrough);
    const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
    for (const batch of encodeDesktopTranscriptSnapshot(snapshot)) store.accept(batch);
    assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
    assert.equal(store.range().hasNewer, false, 'the reader is at the tail, not short of it');

    reads.length = 0;
    await replica.refillTail(PAGE_BYTES);
    assert.deepEqual(reads, [], 'a cache holding the whole transcript answers on its own');
  } finally {
    replica.close();
  }
});

test('return to latest answers with a tail after reclaim emptied the cache', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const eventsClosed = deferred<void>();
  const bootstrap = page(1);
  const tail = page(1);
  const reads: Array<{ direction: string; anchorSequence: number | null }> = [];
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => runtimeHostSessionFixture({
      snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() { await eventsClosed.promise; } },
      transcriptBootstrap: {
        throughSequence: 1, overlayMessageCount: 0,
        durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      // What global reclaim leaves behind: the watermark stands, the rows are gone.
      decodeTranscriptPage: async (candidate) => candidate === bootstrap
        ? { messages: [], nextCursor: 'older' }
        : { messages: [record(1)], nextCursor: null },
      loadTranscriptPage: async (request) => {
        reads.push({ direction: request.direction, anchorSequence: request.anchorSequence });
        return tail;
      },
      async close() { eventsClosed.resolve(); },
    }) },
    emitSessionsChanged() {},
  });
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 1, once() {}, off() {},
    send(_channel, batch) {
      store.accept(batch);
      queueMicrotask(() => observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence, 1));
    },
  });
  assert.deepEqual(store.snapshot().messages, [], 'the window opens on the emptied cache');

  const navigation = store.navigate();
  await observer.loadTranscriptLatest({
    consumerId: 'consumer-1', sessionId: 'session-1', hostEpoch: 'host-1',
    anchorSequence: null, maxBytes: PAGE_BYTES, navigation,
  }, 1);

  assert.deepEqual(reads, [{ direction: 'older', anchorSequence: 2 }]);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  assert.equal(store.range().hasNewer, false, 'the return-to-latest affordance is gone because the rows arrived');
  await observer.close();
});

test('a superseded fragmented reset cannot clear or complete the next navigation', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  acceptSnapshot(store, undefined, 'generation-1', [record(1)]);
  store.navigate();
  const stale = [...encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 1,
    durable: [{ sequence: 0, message: { ...record(0).message, text: 'A'.repeat(300 * 1024) } as StoredMessage }],
    overlay: [], hasOlder: false, hasNewer: true,
  }, 1)];
  assert.equal(store.accept(stale[0]!), false);
  store.navigate();
  acceptSnapshot(store, 2, 'generation-2', [record(1)]);
  const committed = store.snapshot();
  for (const batch of stale) assert.equal(store.accept(batch), false);
  assert.strictEqual(store.snapshot(), committed);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  // Even a reset carrying the current navigation cannot resurrect a retired replica.
  acceptSnapshot(store, 2, 'generation-1', [record(0)]);
  assert.strictEqual(store.snapshot(), committed);
});

test('a replica replacement is admitted whole, however far the window has navigated', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  acceptSnapshot(store, undefined, 'generation-1', [record(1)]);
  store.navigate();
  const replacement = [...encodeDesktopTranscriptSnapshot({
    ...identity, generation: 'generation-2', durableThrough: 1,
    durable: [
      { sequence: 0, message: { ...record(0).message, text: 'A'.repeat(300 * 1024) } as StoredMessage },
      { sequence: 1, message: record(1).message },
    ],
    overlay: [], hasOlder: false, hasNewer: false,
  })];
  assert.ok(replacement.length > 1, 'the replacement has to span more than its reset batch');
  for (const batch of replacement) store.accept(batch);
  assert.equal(store.range().ready, true);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-0', 'message-1']);
});

test('a fill landing under a pending jump joins the window it was anchored on', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const arrive = deferred<void>();
  const handle: DesktopTranscriptHandle = {
    ...identity, readThroughMessageId: null, acknowledgeTail: async () => {},
    async loadBefore(anchor) {
      for (const batch of encodeDesktopTranscriptPage(identity, {
        durableThrough: 1, durable: [{ sequence: 0, message: record(0).message }], hasOlder: false,
      }, { direction: 'older', anchor })) store.accept(batch);
    },
    async loadAfter() { assert.fail('unexpected'); },
    async loadAround(_anchor, _bytes, navigation) {
      await arrive.promise;
      acceptSnapshot(store, navigation, 'generation-1', [record(9)]);
    },
    async loadLatest() { assert.fail('unexpected'); },
    async close() {},
  };
  const controller = createDesktopTranscriptRangeController(store, async () => handle);
  acceptSnapshot(store, undefined, 'generation-1', [record(1), record(2)]);
  const navigation = controller.loadAround(9);
  await Promise.resolve();

  assert.equal(await controller.loadBefore(), true);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id),
    ['message-0', 'message-1', 'message-2'],
    'the fill is anchored on an edge of the window still on screen, and reaches it');

  arrive.resolve();
  await navigation;
  // The jump replaces the window whole, so the fill leaves no trace in it.
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-9']);
  await controller.close();
});

test('a fill that left an edge where it found it is not asked again', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  let reads = 0;
  const handle: DesktopTranscriptHandle = {
    ...identity, readThroughMessageId: null, acknowledgeTail: async () => {},
    // The window still has history, but this answer reaches none of it: the
    // Host read past a retired generation, or the page came back refused.
    async loadBefore() { reads += 1; },
    async loadAfter() { assert.fail('unexpected'); },
    async loadAround() { assert.fail('unexpected'); },
    async loadLatest() { assert.fail('unexpected'); },
    async close() {},
  };
  const controller = createDesktopTranscriptRangeController(store, async () => handle);
  acceptSnapshot(store, undefined, 'generation-1', [record(1), record(2)]);
  assert.equal(store.range().hasOlder, true);

  await controller.loadBefore();
  await controller.loadBefore();
  await controller.loadBefore();
  assert.equal(reads, 1, 'the same edge is not read twice');

  // Anything that moves the edge makes it worth asking again.
  assert.equal(store.retain(2, 2), true);
  await controller.loadBefore();
  assert.equal(reads, 2);
  await controller.close();
});

test('a fill anchored on the window a navigation replaced cannot splice onto it', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  acceptSnapshot(store, undefined, 'generation-1', [record(8), record(9)]);
  const navigating = store.navigate();
  acceptSnapshot(store, navigating, 'generation-1', [record(1), record(2)]);
  for (const batch of encodeDesktopTranscriptPage(identity, {
    durableThrough: 9, durable: [{ sequence: 9, message: record(9).message }], hasNewer: false,
  }, { direction: 'newer', anchor: 9 })) store.accept(batch);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1', 'message-2']);
});

test('a navigation outlives the band trimming the window it was issued under', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  acceptSnapshot(store, undefined, 'generation-1', [record(1), record(2)]);
  const navigating = store.navigate();
  assert.equal(store.retain(2, 2), true);
  const replacement = [...encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 1,
    durable: [
      { sequence: 0, message: { ...record(0).message, text: 'A'.repeat(300 * 1024) } as StoredMessage },
      { sequence: 1, message: record(1).message },
    ],
    overlay: [], hasOlder: false, hasNewer: false,
  }, navigating)];
  assert.ok(replacement.length > 1, 'the replacement has to span more than its reset batch');
  for (const batch of replacement) store.accept(batch);
  assert.equal(store.range().ready, true);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-0', 'message-1']);
  // The fill the band left in flight is anchored on an edge nothing here has.
  for (const batch of encodeDesktopTranscriptPage(identity, {
    durableThrough: 3, durable: [{ sequence: 3, message: record(3).message }], hasNewer: false,
  }, { direction: 'newer', anchor: 2 })) store.accept(batch);
  assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [0, 1]);
  assert.equal(store.range().hasNewer, true, 'the watermark it carried still moved');
});

test('a page anchored on an edge the band has since dropped is refused', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  acceptSnapshot(store, undefined, 'generation-1', [record(1), record(2), record(3)]);
  assert.equal(store.retain(3, 3), true);
  for (const batch of encodeDesktopTranscriptPage(identity, {
    durableThrough: 3, durable: [{ sequence: 0, message: record(0).message }],
    hasOlder: false,
  }, { direction: 'older', anchor: 1 })) store.accept(batch);
  // Installing it would leave 1..2 missing between the answer and the window,
  // and no edge cursor can name a hole in the middle.
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-3']);
  assert.equal(store.range().hasOlder, true);
});

test('follow latest invalidates an in-flight history navigation before open resolves', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const opening = deferred<DesktopTranscriptHandle>();
  const requests: Array<{ command: 'around' | 'latest'; anchor: number | null; navigation: number }> = [];
  const handle = (generation: string): DesktopTranscriptHandle => ({
    ...identity, generation, readThroughMessageId: null, acknowledgeTail: async () => {},
    async loadBefore() { assert.fail('an obsolete history request was replayed'); },
    async loadAfter() { assert.fail('an obsolete newer request was replayed'); },
    async loadAround(anchor, _bytes, navigation) {
      requests.push({ command: 'around', anchor, navigation });
      acceptSnapshot(store, navigation, generation, [record(0)]);
    },
    async loadLatest(navigation) {
      requests.push({ command: 'latest', anchor: null, navigation });
      acceptSnapshot(store, navigation, generation, [record(1)]);
    },
    async close() {},
  });
  const controller = createDesktopTranscriptRangeController(store, async () => opening.promise);
  const history = controller.loadAround(0);
  const latest = controller.loadLatest();
  opening.resolve(handle('generation-1'));
  await Promise.all([history, latest]);
  assert.deepEqual(requests, [{ command: 'latest', anchor: null, navigation: 2 }]);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  await controller.close();
});

test('a rejected older navigation cannot fail the newer latest command', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const historyEntered = deferred<void>();
  let rejectHistory!: (error: Error) => void;
  const historyResult = new Promise<void>((_resolve, reject) => { rejectHistory = reject; });
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    ...identity, readThroughMessageId: null, acknowledgeTail: async () => {},
    async loadBefore() {}, async loadAfter() {},
    async loadAround(anchor) {
      assert.equal(anchor, 0);
      historyEntered.resolve();
      await historyResult;
    },
    async loadLatest(navigation) {
      acceptSnapshot(store, navigation, identity.generation, [record(1)]);
    },
    async close() {},
  }));
  const history = controller.loadAround(0);
  await historyEntered.promise;
  await controller.loadLatest();
  rejectHistory(new Error('the obsolete range failed'));
  await assert.doesNotReject(history);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  await controller.close();
});

test('superseded batches remain ACKable and cannot reset the latest window while delivery drains', { timeout: 10_000 }, async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const firstOldBatch = deferred<void>();
  const eventsClosed = deferred<void>();
  const bootstrap = page(1);
  const historyPage = page(1);
  const latestPage = page(1);
  const old = record(0);
  const largeOld = { ...old, message: { ...old.message, text: 'A'.repeat(700 * 1024) } as StoredMessage };
  const latest = record(1);
  const blocked: DesktopTranscriptBatch[] = [];
  let releaseAcks = false;
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => runtimeHostSessionFixture({
      snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() { await eventsClosed.promise; } },
      transcriptBootstrap: {
        throughSequence: 1, overlayMessageCount: 0,
        durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (candidate) => ({
        messages: candidate === historyPage ? [largeOld] : [latest],
        nextCursor: candidate === historyPage ? 'newer' : 'older',
      }),
      loadTranscriptPage: async (request) => request.direction === 'newer' ? historyPage : latestPage,
      async close() { eventsClosed.resolve(); },
    }) },
    emitSessionsChanged() {},
  });
  const ack = (batch: DesktopTranscriptBatch) => observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence, 1);
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 1, once() {}, off() {},
    send(_channel, batch) {
      store.accept(batch);
      if (batch.navigation === 1 && !releaseAcks) {
        blocked.push(batch);
        firstOldBatch.resolve();
      } else queueMicrotask(() => ack(batch));
    },
  });
  const request: DesktopTranscriptRangeRequest = {
    consumerId: 'consumer-1', sessionId: 'session-1', hostEpoch: 'host-1',
    anchorSequence: 0, maxBytes: PAGE_BYTES, navigation: 1,
  };
  store.navigate();
  const history = observer.loadTranscriptAround(request, 1);
  await firstOldBatch.promise;
  store.navigate();
  const following = observer.loadTranscriptLatest({ ...request, navigation: 2, anchorSequence: null }, 1);
  releaseAcks = true;
  for (const batch of blocked) ack(batch);
  await Promise.all([history, following]);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  const snapshot = store.snapshot();
  // Replaying the reset of the answer the reader navigated away from: it names
  // a navigation that is over, so it cannot reinstall the window it was read for.
  for (const batch of blocked.filter(({ reset }) => reset)) {
    assert.equal(store.accept(batch), false);
  }
  assert.strictEqual(store.snapshot(), snapshot);
  await observer.close();
});

test('a fill in flight does not discard the replacement it was issued under', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const entered = deferred<void>();
  const release = deferred<void>();
  const eventsClosed = deferred<void>();
  const bootstrap = page(1);
  const historyPage = page(1);
  let gated = true;
  const observer = new RuntimeHostSessionObserver({
    client: { openSession: async () => runtimeHostSessionFixture({
      snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() { await eventsClosed.promise; } },
      transcriptBootstrap: {
        throughSequence: 1, overlayMessageCount: 0,
        durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (candidate) => ({
        messages: [candidate === bootstrap ? record(1) : record(0)], nextCursor: null,
      }),
      loadTranscriptPage: async () => {
        if (gated) {
          gated = false;
          entered.resolve();
          await release.promise;
        }
        return historyPage;
      },
      async close() { eventsClosed.resolve(); },
    }) },
    emitSessionsChanged() {},
  });
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 1, once() {}, off() {},
    send(_channel, batch) {
      store.accept(batch);
      queueMicrotask(() => observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence, 1));
    },
  });
  const request: DesktopTranscriptRangeRequest = {
    consumerId: 'consumer-1', sessionId: 'session-1', hostEpoch: 'host-1',
    anchorSequence: 0, maxBytes: PAGE_BYTES, navigation: 1,
  };
  store.navigate();
  const navigation = observer.loadTranscriptAround(request, 1);
  await entered.promise;
  // A fill issued while the jump is still reading names the same navigation:
  // it extends the window, and nothing about it abandons the jump.
  const filling = observer.loadTranscriptBefore({ ...request, anchorSequence: 1 }, 1);
  release.resolve();
  await Promise.all([navigation, filling]);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-0']);
  await observer.close();
});

const identity = { sessionId: 'session-1', hostEpoch: 'host-1', generation: 'generation-1' };
function acceptSnapshot(store: DesktopTranscriptRangeStore, navigation: number | undefined, generation: string, records: Array<ReturnType<typeof record>>) {
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, generation, durableThrough: 1,
    durable: records.map(({ identity: sequence, message }) => ({ sequence, message })),
    overlay: [], hasOlder: true, hasNewer: false,
  }, navigation)) store.accept(batch);
}
function record(identity: number) {
  const message: StoredMessage = { type: 'assistant', id: `message-${identity}`, turnId: `turn-${identity}`, ts: 1, text: String(identity), modelId: 'test' };
  return { identity, message };
}
function page(throughSequence: number): SessionTranscriptPage {
  return { kind: 'page', sessionId: 'session-1', source: 'durable', direction: 'older', throughSequence,
    rawBytes: 1, fragments: [], rangeBoundarySequence: null, protectedTurnSequence: null, nextCursor: null };
}
function continuitySnapshot() {
  return { schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: { sessionId: 'session-1', metadataRevision: 1, status: 'running' as const, createdAt: 1, isArchived: false },
    projectionRevision: 1, rootTurn: null, goal: null,
    queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] }, interactions: { pending: [] } };
}
