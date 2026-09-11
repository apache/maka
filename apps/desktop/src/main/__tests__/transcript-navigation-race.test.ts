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
import { SESSION_CONTINUITY_SCHEMA_VERSION, type SessionTranscriptPage } from '@maka/runtime-host/protocol';
import type { DesktopTranscriptBatch, DesktopTranscriptHandle, DesktopTranscriptNavigation, DesktopTranscriptRangeRequest } from '../../preload/transcript-contract.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';
import { RuntimeHostSessionObservationRegistry } from '../runtime-host-session-observation-registry.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

for (const kind of ['before', 'around', 'catch-up'] as const) {
  test(`a newer reading intent invalidates an in-flight ${kind} page before it mutates or publishes`, async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const installed: number[][] = [];
    const bootstrap = page(1);
    const pending = page(kind === 'catch-up' ? 2 : 1);
    const older = record(0);
    const latest = record(1);
    const appended = record(2);
    const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
      snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() {} },
      transcriptBootstrap: {
        throughSequence: 1, overlayMessageCount: 0,
        durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (candidate) => ({
        messages: candidate === bootstrap ? [latest] : kind === 'catch-up' ? [appended] : [older],
        nextCursor: candidate === bootstrap ? 'older' : null,
      }),
      loadTranscriptPage: async () => {
        entered.resolve();
        await release.promise;
        return pending;
      },
      async close() {},
    }), { onChange: (_replica, change) => installed.push(change.durableUpserts.map(({ sequence }) => sequence)) });
    const loading = kind === 'before' ? replica.loadBefore(1, 128 * 1024)
      : kind === 'around' ? replica.loadAround(0, 128 * 1024) : replica.advance(2);
    await entered.promise;
    const reading = replica.readAt(1);
    release.resolve();
    await Promise.all([loading, reading]);
    assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [1]);
    assert.ok(installed.every((sequences) => sequences.length === 0), 'superseded pages cannot upsert or evict the new reading range');
    replica.close();
  });
}

test('repeated older paging retains at most the adjacent anchor pair and releases it as the reader moves', async () => {
  const records = Array.from({ length: 8 }, (_, sequence) => record(sequence));
  const bootstrap = page(7);
  const pages = new Map<SessionTranscriptPage, number>([[bootstrap, 7]]);
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: continuitySnapshot(), transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 7, overlayMessageCount: 0,
      durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (candidate) => {
      const sequence = pages.get(candidate)!;
      return { messages: [records[sequence]!], nextCursor: sequence > 0 ? 'older' : null };
    },
    loadTranscriptPage: async (request) => {
      const candidate = page(7);
      pages.set(candidate, request.anchorSequence! - 1);
      return candidate;
    },
    async close() {},
  }), { maxResidentBytes: 64, maxResidentTurns: 2 });
  const maxTurnBytes = Math.max(...records.map(({ message }) => Buffer.byteLength(JSON.stringify(message))));
  assert.ok(maxTurnBytes > 64, 'each complete turn exceeds the soft byte budget');
  for (let anchor = 7; anchor > 0; anchor -= 1) {
    await replica.loadBefore(anchor, 128 * 1024);
    assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [anchor - 1, anchor]);
    assert.ok(replica.residentBytes <= maxTurnBytes * 2, 'successive pages cannot accumulate protected turns');
    // First prove consecutive paging itself releases the old pair, then prove
    // reading-anchor movement trims each remaining pair down to one turn.
    if (anchor <= 4) {
      await replica.readAt(anchor - 1);
      assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [anchor - 1]);
      assert.ok(replica.residentBytes <= maxTurnBytes);
    }
  }
  assert.equal(replica.snapshot().hasOlder, false);
  assert.equal(replica.snapshot().hasNewer, true);
  replica.close();
});

test('memory trimming cannot turn an already durable reading anchor into an unresolved live Turn', async () => {
  const bootstrap = page(1);
  const decoded = new Map<SessionTranscriptPage, ReturnType<typeof record>>([[bootstrap, record(1)]]);
  const requests: number[] = [];
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
  }), { maxResidentBytes: 64 });
  try {
    await replica.readAt(1, undefined, record(1).message.turnId);
    await replica.advance(2);
    assert.equal(replica.snapshot().hasNewer, true);
    assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [1]);
    replica.trimDurable(0);
    assert.deepEqual(replica.snapshot().durable, []);
    requests.length = 0;
    await replica.advance(3);
    assert.deepEqual(replica.snapshot().durable, [], 'budget reclaim must not authorize following a later Turn');
    assert.equal(replica.durableThrough, 3);
    assert.deepEqual(requests, [], 'a known durable anchor remains history after reclaim');
  } finally {
    replica.close();
  }
});

test('a superseded fragmented reset cannot clear or complete the next navigation', () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  acceptSnapshot(store, 0, 'generation-1', [record(1)]);
  store.expectNavigation(1);
  const stale = [...encodeDesktopTranscriptSnapshot({
    ...identity, navigationVersion: 1, durableThrough: 1,
    durable: [{ sequence: 0, message: { ...record(0).message, text: 'A'.repeat(300 * 1024) } as StoredMessage }],
    overlay: [], hasOlder: false, hasNewer: true,
  })];
  assert.equal(store.accept(stale[0]!), false);
  store.expectNavigation(2);
  acceptSnapshot(store, 2, 'generation-2', [record(1)]);
  const committed = store.snapshot();
  for (const batch of stale) assert.equal(store.accept(batch), false);
  assert.strictEqual(store.snapshot(), committed);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  // Even a reset carrying the current navigation cannot resurrect a retired replica.
  acceptSnapshot(store, 2, 'generation-1', [record(0)]);
  assert.strictEqual(store.snapshot(), committed);
});

test('follow latest invalidates before open resolves and a reload replays only that latest intent', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const opening = deferred<DesktopTranscriptHandle>();
  const requests: Array<{ generation: string; anchor: number | null; navigation?: DesktopTranscriptNavigation }> = [];
  const handle = (generation: string): DesktopTranscriptHandle => ({
    ...identity, generation, readThroughMessageId: null,
    async loadBefore() { assert.fail('an obsolete history request was replayed'); },
    async loadAfter() { assert.fail('an obsolete newer request was replayed'); },
    async loadAround(anchor, _bytes, navigation) {
      requests.push({ generation, anchor, navigation });
      acceptSnapshot(store, navigation?.navigationVersion ?? 0, generation, [record(1)]);
    },
    async close() {},
  });
  let opens = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    if (opens === 1) return opening.promise;
    // A new preload can initialize and ACK version-zero bootstrap while the
    // range store continues showing the last committed view until replay.
    acceptSnapshot(store, 0, 'generation-2', [record(0)]);
    return handle('generation-2');
  });
  const history = controller.loadAround(0);
  const latest = controller.loadLatest();
  opening.resolve(handle('generation-1'));
  await Promise.all([history, latest]);
  assert.deepEqual(requests.map(({ anchor, navigation }) => [anchor, navigation?.intent, navigation?.navigationVersion]), [[null, 'followTail', 2]]);
  await controller.reload();
  assert.deepEqual(requests.map(({ generation, navigation }) => [generation, navigation?.intent, navigation?.navigationVersion]), [
    ['generation-1', 'followTail', 2], ['generation-2', 'followTail', 2],
  ]);
  assert.equal(store.range().generation, 'generation-2');
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  await controller.close();
});

test('a rejected older navigation cannot fail the newer follow-tail intent', async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const historyEntered = deferred<void>();
  let rejectHistory!: (error: Error) => void;
  const historyResult = new Promise<void>((_resolve, reject) => { rejectHistory = reject; });
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    ...identity, readThroughMessageId: null,
    async loadBefore() {}, async loadAfter() {},
    async loadAround(anchor, _bytes, navigation) {
      if (anchor === 0) {
        historyEntered.resolve();
        await historyResult;
      } else acceptSnapshot(store, navigation!.navigationVersion, identity.generation, [record(1)]);
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

test('superseded batches remain ACKable and cannot reset the latest range while delivery drains', { timeout: 10_000 }, async () => {
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const firstOldBatch = deferred<void>();
  const eventsClosed = deferred<void>();
  const bootstrap = page(1);
  const historyPage = { ...page(1), direction: 'newer' as const };
  const beforeStartPage = page(1);
  const latestPage = page(1);
  const old = record(0);
  const largeOld = { ...old, message: { ...old.message, text: 'A'.repeat(700 * 1024) } as StoredMessage };
  const latest = record(1);
  const blocked: DesktopTranscriptBatch[] = [];
  const requests: Array<{ direction: string; anchorSequence: number | null }> = [];
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
      decodeTranscriptPage: async (candidate) => candidate === beforeStartPage
        ? { messages: [], nextCursor: null }
        : {
            messages: candidate === historyPage ? [largeOld] : [latest],
            nextCursor: candidate === historyPage ? 'newer' : 'older',
          },
      loadTranscriptPage: async (request) => {
        requests.push({ direction: request.direction, anchorSequence: request.anchorSequence ?? null });
        if (request.direction === 'newer') {
          assert.equal(request.anchorSequence, null);
          return historyPage;
        }
        if (request.anchorSequence === 0) return beforeStartPage;
        assert.equal(request.anchorSequence, 2);
        return latestPage;
      },
      async close() { eventsClosed.resolve(); },
    }) },
    emitSessionsChanged() {},
  });
  const ack = (batch: DesktopTranscriptBatch) => observer.acknowledgeTranscript('consumer-1', batch.generation, batch.deliverySequence, 1);
  await observer.openTranscript('session-1', 'consumer-1', {
    id: 1, once() {}, off() {},
    send(_channel, batch) {
      store.accept(batch);
      if (batch.navigationVersion === 1 && !releaseAcks) {
        blocked.push(batch);
        firstOldBatch.resolve();
      } else queueMicrotask(() => ack(batch));
    },
  });
  const request: DesktopTranscriptRangeRequest = {
    consumerId: 'consumer-1', sessionId: 'session-1', hostEpoch: 'host-1',
    anchorSequence: 0, maxBytes: 128 * 1024, navigationVersion: 1, intent: 'history',
  };
  store.expectNavigation(1);
  const history = observer.loadTranscriptAround(request, 1);
  await firstOldBatch.promise;
  store.expectNavigation(2);
  const following = observer.loadTranscriptAround({ ...request, navigationVersion: 2, intent: 'followTail', anchorSequence: null }, 1);
  releaseAcks = true;
  for (const batch of blocked) ack(batch);
  await Promise.all([history, following]);
  assert.deepEqual(requests, [
    { direction: 'newer', anchorSequence: null },
    { direction: 'older', anchorSequence: 0 },
    { direction: 'older', anchorSequence: 2 },
  ]);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-1']);
  const snapshot = store.snapshot();
  for (const batch of blocked) assert.equal(store.accept(batch), false);
  assert.strictEqual(store.snapshot(), snapshot);
  await observer.close();
});

for (const changedEpoch of [false, true]) {
for (const latest of [false, true]) {
test(`${changedEpoch ? 'cross-epoch' : 'same-Host'} registry recovery admits newer ${latest ? 'latest' : 'Turn reading'} while old replay is pending`, { timeout: 10_000 }, async () => {
  const registry = new RuntimeHostSessionObservationRegistry();
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
  const replayEntered = deferred<void>();
  const replayRelease = deferred<void>();
  const latestEntered = deferred<void>();
  const calls: Array<{ generation: string; request: DesktopTranscriptRangeRequest }> = [];
  const replacementEpoch = changedEpoch ? 'host-2' : 'host-1';
  const makeSource = (generation: string, hostEpoch: string) => ({
    async observe() {}, async unobserve() {}, async closeTranscript() {},
    async openTranscript(sessionId: string) {
      return { sessionId, generation, hostEpoch, readThroughMessageId: null };
    },
    async loadTranscriptBefore() {}, async loadTranscriptAfter() {},
    async loadTranscriptAround(request: DesktopTranscriptRangeRequest) {
      assert.equal(request.hostEpoch, hostEpoch, 'only the successfully opened source epoch is accepted');
      calls.push({ generation, request });
      if (generation === 'generation-2' && request.navigationVersion === 1) {
        replayEntered.resolve();
        await replayRelease.promise;
      }
      const row = record(request.navigationVersion === 2 ? 2 : 0);
      for (const batch of encodeDesktopTranscriptSnapshot({
        ...identity, generation, hostEpoch, navigationVersion: request.navigationVersion,
        durableThrough: 2, durable: [{ sequence: row.identity, message: row.message }],
        overlay: [], hasOlder: false, hasNewer: false,
      })) store.accept(batch);
      if (generation === 'generation-2' && request.navigationVersion === 2) latestEntered.resolve();
    },
  });
  const target = { id: 1, send() {}, once() {}, off() {} };
  const first = makeSource('generation-1', 'host-1');
  await registry.attach(first);
  await registry.openTranscript('session-1', 'consumer-1', target);
  const request: DesktopTranscriptRangeRequest = {
    consumerId: 'consumer-1', sessionId: 'session-1', hostEpoch: 'host-1',
    anchorSequence: 0, maxBytes: 128 * 1024, navigationVersion: 1, intent: 'history',
  };
  store.expectNavigation(1);
  await registry.loadTranscriptAround(request, target.id);
  registry.detach(first);
  await registry.attach(makeSource('generation-2', replacementEpoch));
  await replayEntered.promise;
  store.expectNavigation(2);
  const next = registry.loadTranscriptAround({ ...request, navigationVersion: 2,
    intent: latest ? 'followTail' : 'history', anchorSequence: latest ? null : 2,
    readingTurnId: latest ? undefined : 'turn-2', preserveRange: true,
  }, target.id);
  await latestEntered.promise;
  replayRelease.resolve();
  await next;
  await flush();
  await registry.loadTranscriptAround(request, target.id);
  assert.deepEqual(calls.map(({ generation, request: entry }) => [generation, entry.navigationVersion, entry.intent]), [
    ['generation-1', 1, 'history'], ['generation-2', 1, changedEpoch ? 'followTail' : 'history'],
    ['generation-2', 2, latest ? 'followTail' : 'history'],
  ]);
  assert.equal(calls[2]!.request.hostEpoch, replacementEpoch);
  assert.equal(calls[2]!.request.anchorSequence, latest || changedEpoch ? null : 2);
  assert.equal(calls[2]!.request.readingTurnId, latest ? undefined : 'turn-2');
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['message-2'], 'late replay cannot replace the new navigation');
  await assert.rejects(registry.loadTranscriptAround({ ...request, navigationVersion: 3, hostEpoch: 'unrelated-epoch' }, target.id));
  await registry.close();
});
}
}

const identity = { sessionId: 'session-1', hostEpoch: 'host-1', generation: 'generation-1' };
function acceptSnapshot(store: DesktopTranscriptRangeStore, navigationVersion: number, generation: string, records: Array<ReturnType<typeof record>>) {
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, navigationVersion, generation, durableThrough: 1,
    durable: records.map(({ identity: sequence, message }) => ({ sequence, message })),
    overlay: [], hasOlder: true, hasNewer: false,
  })) store.accept(batch);
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
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
async function flush() { await new Promise<void>((resolve) => setImmediate(resolve)); }
