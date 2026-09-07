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
import { markPersisted } from '@maka/core/persisted-value';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionTranscriptPageInput,
} from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
  updateSubscriberTranscriptHighWater,
} from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/desktop-transcript-range-store.js';
import type { DesktopTranscriptNavigation } from '../../preload/transcript-contract.js';
import { encodeDesktopTranscriptChange, encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';
import { DesktopTranscriptReplica, type DesktopTranscriptReplicaChange } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';
import { openTranscriptNavigationLedger } from './transcript-navigation-test-fixture.js';

const HOST_EPOCH = 'host-1';
const SUBSCRIPTION_ID = 'overlay-settlement-subscription';
const PAGE_BYTES = 128 * 1024;
const BOOTSTRAP_THROUGH = 4;
const B_STEERING_THROUGH = 5;
const B_COMPLETED_THROUGH = 7;
const C_COMPLETED_THROUGH = 11;

for (const coalesced of [false, true]) {
  test(`settles a bootstrap overlay outside history through ${coalesced ? 'a coalesced B+C watermark' : 'separate B and C watermarks'}`, async () => {
    const fixture = await openFixture();
    try {
      const { replica, renderer, changes } = fixture;
      assert.equal(replica.snapshot().overlay.find(({ id }) => id === 'answer-b')?.id, 'answer-b');
      await replica.loadAround(fixture.history[0]!.sequence, PAGE_BYTES);
      assertHistoryRange(fixture);
      const before = changes.length;

      if (!coalesced) {
        await fixture.advance(B_COMPLETED_THROUGH);
        assertHistoryRange(fixture);
        assert.deepEqual(replica.snapshot().overlay, []);
      }
      await fixture.advance(C_COMPLETED_THROUGH);
      assertHistoryRange(fixture);
      assert.equal(replica.durableThrough, fixture.watermark(C_COMPLETED_THROUGH));
      assert.deepEqual(replica.snapshot().overlay, []);
      assert.deepEqual(changes.slice(before).flatMap((change) => change.completedOverlayMessageIds), ['user-b', 'answer-b']);
      assert.ok(changes.slice(before).every((change) => change.durableUpserts.length === 0));
      assert.deepEqual(renderer.snapshot().messages.map(({ id }) => id), ['user-a', 'answer-a', 'completed-a']);

      await replica.followLatest(PAGE_BYTES);
      assert.deepEqual(replica.snapshot().durable.map(({ message }) => message.id), ['user-c', 'answer-c', 'completed-c']);
      assert.equal(replica.snapshot().hasNewer, false);
      assert.deepEqual(renderer.snapshot().messages.map(({ id }) => id), ['user-c', 'answer-c', 'completed-c']);
    } finally {
      await fixture.close();
    }
  });
}

test('retains an unfinished overlay through runtime checkpoints and skips scans after settlement', async () => {
  const fixture = await openFixture();
  try {
    const { replica, changes, requests } = fixture;
    await replica.loadAround(fixture.history[0]!.sequence, PAGE_BYTES);
    await fixture.advance(B_STEERING_THROUGH);
    assert.equal(replica.durableThrough, fixture.bootstrapThrough, 'running B has no durable ending yet');
    assertHistoryRange(fixture);
    const unfinished = replica.snapshot().overlay.find(({ id }) => id === 'answer-b');
    assert.equal(unfinished?.type === 'assistant' ? unfinished.text : undefined, 'B partial');
    assert.deepEqual(changes.flatMap((change) => change.completedOverlayMessageIds), []);

    await fixture.advance(B_COMPLETED_THROUGH);
    assert.deepEqual(replica.snapshot().overlay, []);
    const before = requests.length;
    await fixture.advance(C_COMPLETED_THROUGH);
    assert.equal(requests.length, before, 'history with no pending overlay needs no durable page read');
    assertHistoryRange(fixture);
  } finally {
    await fixture.close();
  }
});

test('a latest range jump settles skipped overlays without waiting for another advance', async () => {
  const fixture = await openFixture();
  try {
    const { replica } = fixture;
    await replica.loadAround(fixture.history[0]!.sequence, PAGE_BYTES);
    await fixture.announce(C_COMPLETED_THROUGH);
    // Both commands are queued synchronously. The range jump owns the newer
    // navigation before the queued catch-up starts handling the watermark.
    const latest = replica.followLatest(PAGE_BYTES);
    const advance = replica.advance(fixture.watermark(C_COMPLETED_THROUGH));
    await latest;
    assert.deepEqual(replica.snapshot().overlay, []);
    assert.deepEqual(replica.snapshot().durable.map(({ message }) => message.id), ['user-c', 'answer-c', 'completed-c']);
    await advance;
  } finally {
    await fixture.close();
  }
});

for (const intent of ['followTail', 'history'] as const) {
  test(`the ${intent} range retires the completed overlay in one notification`, async () => {
    const fixture = await openFixture();
    try {
      const { replica, changes, requests } = fixture;
      if (intent === 'history') await replica.readAt(fixture.history[0]!.sequence);
      const before = requests.length;
      await fixture.advance(B_COMPLETED_THROUGH);
      const settled = changes.filter((change) => change.completedOverlayMessageIds.includes('answer-b'));
      assert.equal(settled.length, 1);
      if (intent === 'followTail') {
        assert.ok(settled[0]!.durableUpserts.some(({ message }) => message.id === 'answer-b'));
        const answer = replica.messages().find(({ id }) => id === 'answer-b');
        assert.equal(answer?.type === 'assistant' ? answer.text : undefined, 'B partial and completed answer');
      } else {
        assertHistoryRange(fixture);
        assert.equal(settled[0]!.durableUpserts.length, 0, 'settlement preserves the selected oversized history Turn');
      }
      assert.equal(requests.length - before, 1, 'normal catch-up settles through the same page it installs');
      assert.deepEqual(replica.snapshot().overlay, []);
    } finally {
      await fixture.close();
    }
  });
}

for (const coalesced of [false, true]) {
  test(`reading an overlay-only B survives ${coalesced ? 'coalesced B+C completion' : 'B completion followed by oversized C'}`, async () => {
    const fixture = await openFixture();
    const { replica, renderer } = fixture;
    const navigations: Array<{ anchor: number | null; navigation: DesktopTranscriptNavigation }> = [];
    // Only the process boundary is in-process here: controller invalidation,
    // replica ownership, Host cursors, SQLite ledger, and renderer batches all
    // use their production implementations.
    const controller = createDesktopTranscriptRangeController(renderer, async () => ({
      sessionId: replica.sessionId, generation: replica.generation,
      hostEpoch: replica.hostEpoch, readThroughMessageId: null,
      async loadBefore(anchor, maxBytes = PAGE_BYTES, navigation) {
        assert.ok(navigation);
        fixture.acceptNavigation(navigation);
        await replica.loadBefore(anchor, maxBytes, replica.setNavigation(navigation.intent));
      },
      async loadAfter(anchor, maxBytes = PAGE_BYTES, navigation) {
        assert.ok(navigation);
        fixture.acceptNavigation(navigation);
        await replica.loadAfter(anchor, maxBytes, replica.setNavigation(navigation.intent));
      },
      async loadAround(anchor, maxBytes = PAGE_BYTES, navigation) {
        assert.ok(navigation);
        navigations.push({ anchor, navigation });
        fixture.acceptNavigation(navigation);
        const token = replica.setNavigation(navigation.intent);
        if (navigation.preserveRange) await replica.readAt(anchor, token, navigation.readingTurnId);
        else if (navigation.intent === 'followTail') await replica.followLatest(maxBytes, token);
        else {
          assert.notEqual(anchor, null);
          await replica.loadAround(anchor!, maxBytes, token);
        }
      },
      async close() {},
    }));
    try {
      await controller.ready();
      assert.equal(renderer.sequenceForTurn('b'), null,
        'a running ledger invocation has no durable user sequence to use as a bookmark');
      assert.ok(renderer.snapshot().messages.some(({ id }) => id === 'answer-b'));
      await controller.setReadingAnchor(renderer.sequenceForTurn('b'), 'b');
      assert.equal(navigations[0]?.anchor, null, 'the old A sequence cannot impersonate B');
      assert.equal(navigations[0]?.navigation.readingTurnId, 'b');
      assert.equal(navigations[0]?.navigation.intent, 'history');

      const expectedB = ['user-b', 'steering-b', 'answer-b', 'completed-b'];
      if (!coalesced) {
        await fixture.advance(B_COMPLETED_THROUGH);
        assert.deepEqual(replica.snapshot().durable.map(({ message }) => message.id), expectedB);
        assert.ok(renderer.sequenceForTurn('b') !== null, 'the selected Turn now resolves to its own durable sequence');
      }
      await fixture.advance(C_COMPLETED_THROUGH);
      assert.deepEqual(replica.snapshot().durable.map(({ message }) => message.id), expectedB);
      assert.deepEqual(replica.snapshot().overlay, []);
      assert.equal(replica.snapshot().hasNewer, true);
      assert.deepEqual(renderer.snapshot().messages.map(({ id }) => id), expectedB);
      const answer = renderer.snapshot().messages.find(({ id }) => id === 'answer-b');
      assert.equal(answer?.type === 'assistant' ? answer.text : undefined, 'B partial and completed answer');
      assert.equal(renderer.snapshot().messages.some(({ turnId }) => turnId === 'c'), false,
        'finishing C cannot replace the reader-selected B range');

      await controller.loadLatest();
      assert.deepEqual(renderer.snapshot().messages.map(({ id }) => id), ['user-c', 'answer-c', 'completed-c']);
      assert.equal(replica.snapshot().hasNewer, false);
    } finally {
      await controller.close();
      await fixture.close();
    }
  });
}

test('a fresh replica restores B from an overlay-only bookmark after oversized C owns the tail', async () => {
  const fixture = await openFixture();
  let reopened: Awaited<ReturnType<typeof openSettledReplica>> | undefined;
  try {
    const bookmark = { turnId: 'b', sequence: fixture.renderer.sequenceForTurn('b') };
    assert.equal(bookmark.sequence, null);
    await fixture.replica.readAt(bookmark.sequence, undefined, bookmark.turnId);
    await fixture.advance(B_COMPLETED_THROUGH);
    await fixture.advance(C_COMPLETED_THROUGH);

    reopened = await openSettledReplica(fixture.ledger);
    assert.deepEqual(reopened.replica.snapshot().durable.map(({ message }) => message.id),
      ['user-c', 'answer-c', 'completed-c']);
    assert.deepEqual(reopened.replica.snapshot().overlay, []);
    const before = reopened.requests.length;
    await reopened.replica.readAt(bookmark.sequence, undefined, bookmark.turnId);
    assert.deepEqual(reopened.replica.snapshot().durable.map(({ message }) => message.id),
      ['user-b', 'steering-b', 'answer-b', 'completed-b']);
    assert.ok(reopened.requests.slice(before).some((request) => request.direction === 'older'),
      'a no-sequence bookmark finds its durable Turn through the real bounded pager');
    assert.ok(reopened.requests.slice(before).every((request) => request.maxBytes <= 512 * 1024));
    assert.equal(reopened.replica.snapshot().hasNewer, true);
    await reopened.replica.advance(fixture.watermark(C_COMPLETED_THROUGH));
    assert.deepEqual(new Set(reopened.replica.snapshot().durable.map(({ message }) => message.turnId)), new Set(['b']));
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test('superseded settlement pages cannot retire overlays or skip the current navigation retry', async () => {
  const firstStarted = deferred<void>();
  const releaseFirst = deferred<void>();
  const secondStarted = deferred<void>();
  const releaseSecond = deferred<void>();
  let settlementReads = 0;
  const fixture = await openFixture(async (request) => {
    if (request.direction !== 'newer' || request.anchorSequence !== fixture.bootstrapThrough) return;
    settlementReads += 1;
    if (settlementReads === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    } else if (settlementReads === 2) {
      secondStarted.resolve();
      await releaseSecond.promise;
    }
  });
  try {
    const { replica, changes } = fixture;
    await replica.loadAround(fixture.history[0]!.sequence, PAGE_BYTES);
    const advance = fixture.advance(C_COMPLETED_THROUGH);
    await firstStarted.promise;
    const latest = replica.followLatest(PAGE_BYTES);
    releaseFirst.resolve();
    await secondStarted.promise;
    assert.equal(replica.snapshot().overlay.find(({ id }) => id === 'answer-b')?.id, 'answer-b');
    assert.deepEqual(changes.flatMap((change) => change.completedOverlayMessageIds), []);
    releaseSecond.resolve();
    await latest;
    await advance;
    assert.equal(settlementReads, 2, 'the new command retries from the last actually checked overlay watermark');
    assert.deepEqual(replica.snapshot().overlay, []);
    assert.deepEqual(replica.snapshot().durable.map(({ message }) => message.id), ['user-c', 'answer-c', 'completed-c']);
    assert.deepEqual(changes.flatMap((change) => change.completedOverlayMessageIds), ['user-b', 'answer-b']);
  } finally {
    releaseFirst.resolve();
    releaseSecond.resolve();
    await fixture.close();
  }
});

function assertHistoryRange(fixture: Awaited<ReturnType<typeof openFixture>>): void {
  assert.deepEqual(fixture.replica.snapshot().durable, fixture.history);
  assert.equal(fixture.replica.snapshot().hasNewer, fixture.replica.durableThrough! > fixture.bootstrapThrough);
}

async function openFixture(beforePage?: (request: SessionTranscriptPageInput) => Promise<void>) {
  const messages: StoredMessage[] = [
    user('a'), assistant('a', 'A'.repeat(600 * 1024)), turnState('a', 'completed'),
    user('b'), turnState('b', 'running'),
    { ...user('b'), id: 'steering-b', steeringEventId: 'steering-event-b', text: 'Continue B' },
    assistant('b', 'B partial and completed answer'), turnState('b', 'completed'),
    user('c'), turnState('c', 'running'), assistant('c', 'C'.repeat(600 * 1024)), turnState('c', 'completed'),
  ];
  const ledger = await openTranscriptNavigationLedger(messages);
  const { reader, sessionId } = ledger;
  const bootstrapThrough = await ledger.appendThrough(BOOTSTRAP_THROUGH);
  assert.ok(bootstrapThrough !== null);
  const history = await ledger.durableRecords();
  await ledger.appendPartialAssistant('b', 'answer-b', 'B partial');
  const rootTurn = { sessionId, turnId: 'b', runId: 'run-b', status: 'running' as const };
  const activeAssistantStreams = [{ turnId: 'b', messageId: 'answer-b', kind: 'text' as const, text: 'B partial' }];
  const opened = await createSessionTranscriptBootstrap({
    reader, sessionId, subscriptionId: SUBSCRIPTION_ID,
    throughSequence: bootstrapThrough, rootTurn, activeAssistantStreams,
    maxBytes: 16 * 1024, projection: 'owner',
  });
  const requests: SessionTranscriptPageInput[] = [];
  const subscription = new ClientSessionSubscription({
    hostEpoch: HOST_EPOCH, subscriptionId: SUBSCRIPTION_ID, nextSequence: 1,
    activeAssistantStreams, transcript: opened.bootstrap,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: { sessionId, metadataRevision: 1, status: 'running', createdAt: 1, isArchived: false },
      projectionRevision: 1, rootTurn, goal: null,
      queue: { hostEpoch: HOST_EPOCH, queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
  }, async () => undefined, async (request) => {
    requests.push(request);
    await beforePage?.(request);
    return readSessionTranscriptPage({ reader, state: opened.state, request });
  });
  const decodeMessage = (value: unknown) => decodeStoredMessage(markPersisted<StoredMessage>(value));
  const changes: DesktopTranscriptReplicaChange[] = [];
  let navigationVersion = 0;
  const renderer = new DesktopTranscriptRangeStore(JSON.stringify(['local', sessionId]));
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: subscription.snapshot, activeAssistantStreams, events: subscription,
    transcript: Promise.resolve([]), transcriptBootstrap: opened.bootstrap,
    loadTranscriptOverlay: (maxMessageBytes, accountAssemblyBytes) =>
      subscription.loadTranscriptOverlay(decodeMessage, maxMessageBytes, accountAssemblyBytes),
    decodeTranscriptPage: (page, maxMessageBytes, accountAssemblyBytes) =>
      subscription.decodeTranscriptPage(page, decodeMessage, maxMessageBytes, accountAssemblyBytes),
    loadTranscriptPage: (request) => subscription.loadTranscriptPage(request),
    close: () => subscription.close(),
  }), {
    onChange: (current, change) => {
      changes.push(change);
      for (const batch of encodeDesktopTranscriptChange({ ...current.snapshot(), navigationVersion }, change)) renderer.accept(batch);
    },
  });
  for (const batch of encodeDesktopTranscriptSnapshot(replica.snapshot())) renderer.accept(batch);
  const watermarks = new Map<number, number>();
  let frameSequence = 0;
  const announce = async (checkpoint: number) => {
    const throughSequence = await ledger.appendThrough(checkpoint);
    assert.ok(throughSequence !== null);
    watermarks.set(checkpoint, throughSequence);
    const advanced = updateSubscriberTranscriptHighWater(opened.state, throughSequence);
    if (checkpoint === B_STEERING_THROUGH) {
      assert.equal(advanced, false, 'persisting a running Turn does not publish durable rows');
      return;
    }
    assert.equal(advanced, true);
    subscription.accept({
      kind: 'subscription.transcript_advanced', hostEpoch: HOST_EPOCH,
      subscriptionId: SUBSCRIPTION_ID, sequence: ++frameSequence, sessionId, throughSequence,
    });
    const frame = await subscription.next();
    assert.equal(frame.done, false);
    assert.equal(frame.value?.kind, 'subscription.transcript_advanced');
  };
  return {
    replica, renderer, changes, requests, announce, history, bootstrapThrough, ledger,
    acceptNavigation: (navigation: DesktopTranscriptNavigation) => { navigationVersion = navigation.navigationVersion; },
    watermark: (checkpoint: number) => {
      const value = watermarks.get(checkpoint);
      assert.notEqual(value, undefined);
      return value!;
    },
    async advance(throughSequence: number) {
      await announce(throughSequence);
      await replica.advance(watermarks.get(throughSequence)!);
    },
    async close() {
      replica.close();
      await subscription.close();
      await ledger.close();
    },
  };
}

async function openSettledReplica(ledger: Awaited<ReturnType<typeof openTranscriptNavigationLedger>>) {
  const { sessionId, reader } = ledger;
  const opened = await createSessionTranscriptBootstrap({
    reader, sessionId, subscriptionId: `${SUBSCRIPTION_ID}-reopened`,
    throughSequence: await reader.readDurableHighWater(sessionId), rootTurn: null,
    activeAssistantStreams: [], maxBytes: 16 * 1024, projection: 'owner',
  });
  const requests: SessionTranscriptPageInput[] = [];
  const subscription = new ClientSessionSubscription({
    hostEpoch: HOST_EPOCH, subscriptionId: `${SUBSCRIPTION_ID}-reopened`, nextSequence: 1,
    activeAssistantStreams: [], transcript: opened.bootstrap,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: { sessionId, metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
      projectionRevision: 1, rootTurn: null, goal: null,
      queue: { hostEpoch: HOST_EPOCH, queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
  }, async () => undefined, (request) => {
    requests.push(request);
    return readSessionTranscriptPage({ reader, state: opened.state, request });
  });
  const decodeMessage = (value: unknown) => decodeStoredMessage(markPersisted<StoredMessage>(value));
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: subscription.snapshot, events: subscription, transcript: Promise.resolve([]),
    transcriptBootstrap: opened.bootstrap,
    loadTranscriptOverlay: (maxBytes, accountBytes) => subscription.loadTranscriptOverlay(decodeMessage, maxBytes, accountBytes),
    decodeTranscriptPage: (page, maxBytes, accountBytes) => subscription.decodeTranscriptPage(page, decodeMessage, maxBytes, accountBytes),
    loadTranscriptPage: (request) => subscription.loadTranscriptPage(request),
    close: () => subscription.close(),
  }));
  return { replica, requests, async close() { replica.close(); await subscription.close(); } };
}

function user(turnId: string): Extract<StoredMessage, { type: 'user' }> {
  return { type: 'user', id: `user-${turnId}`, turnId, text: turnId, ts: 1 };
}

function assistant(turnId: string, text: string): Extract<StoredMessage, { type: 'assistant' }> {
  return { type: 'assistant', id: `answer-${turnId}`, turnId, text, ts: 1, modelId: 'fixture-model' };
}

function turnState(turnId: string, status: 'running' | 'completed'): StoredMessage {
  return { type: 'turn_state', id: `${status}-${turnId}`, turnId, ts: 1, status };
}
