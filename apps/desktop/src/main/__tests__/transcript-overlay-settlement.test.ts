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
import { markPersisted } from '@maka/core/persisted-value';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionTranscriptPage,
  type SessionTranscriptPageInput,
} from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
  updateSubscriberTranscriptHighWater,
} from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import {
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptPage,
  encodeDesktopTranscriptSnapshot,
} from '../desktop-transcript-ipc.js';
import { DesktopTranscriptReplica, type DesktopTranscriptReplicaChange } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';
import { openTranscriptNavigationLedger } from './transcript-navigation-test-fixture.js';

const HOST_EPOCH = 'host-1';
const SUBSCRIPTION_ID = 'overlay-settlement-subscription';
const PAGE_BYTES = 128 * 1024;
const BOOTSTRAP_THROUGH = 'running-b';
const B_STEERING_THROUGH = 'steering-b';
const B_COMPLETED_THROUGH = 'completed-b';
const C_COMPLETED_THROUGH = 'completed-c';

for (const coalesced of [false, true]) {
  test(`settles a bootstrap overlay through ${coalesced ? 'a coalesced B+C watermark' : 'separate B and C watermarks'}`, async () => {
    const fixture = await openFixture();
    try {
      const { replica, renderer } = fixture;
      assert.equal(replica.snapshot().overlay.find(({ id }) => id === 'answer-b')?.id, 'answer-b');

      if (!coalesced) {
        await fixture.advance(B_COMPLETED_THROUGH);
        assert.deepEqual(replica.snapshot().overlay, []);
      }
      await fixture.advance(C_COMPLETED_THROUGH);
      assert.equal(replica.durableThrough, fixture.watermark(C_COMPLETED_THROUGH));
      assert.deepEqual(replica.snapshot().overlay, []);
      assert.deepEqual(replica.snapshot().durable.map(({ message }) => message.id),
        ['user-c', 'answer-c', 'completed-c']);
      assert.equal(
        renderer.snapshot().messages.some((message) => message.type === 'assistant' && message.text === 'B partial'),
        false,
        'the durable row replaced the partial overlay answer',
      );
      assert.ok(renderer.snapshot().messages.some(({ id }) => id === 'answer-c'));
    } finally {
      await fixture.close();
    }
  });
}

test('a window parked off the tail reads the completed Turn back through its own edge', async () => {
  const fixture = await openFixture();
  try {
    const { replica, renderer } = fixture;
    // Reading history: the window dropped the newest rows to meet its budget,
    // so its newer edge is a gap and tail growth is no longer its business.
    const oldest = renderer.range().oldestSequence;
    assert.ok(oldest !== null);
    renderer.retain(oldest, oldest);
    assert.equal(renderer.range().hasNewer, true);
    assert.equal(
      renderer.snapshot().messages.some(({ id }) => id === 'answer-b'), false,
      'the overlay is a fact about the tail, and this window no longer reaches it',
    );

    await fixture.advance(B_COMPLETED_THROUGH);
    await fixture.advance(C_COMPLETED_THROUGH);

    assert.deepEqual(
      renderer.durableEntries().map(({ sequence }) => sequence), [oldest],
      'tail growth has nothing to join onto, so the window stays the range it was trimmed to',
    );
    assert.equal(renderer.range().hasNewer, true);

    // Paging back: each read is anchored on the edge the last one left, which
    // is the only thing that makes the rows spliceable.
    for (let read = 0; read < 8 && renderer.range().hasNewer; read += 1) {
      const anchor = renderer.range().newestSequence;
      const page = await replica.loadAfter(anchor, PAGE_BYTES);
      assert.ok(page);
      for (const batch of encodeDesktopTranscriptPage({
        sessionId: replica.sessionId,
        generation: replica.generation,
        hostEpoch: replica.hostEpoch,
      }, page, { direction: 'newer', anchor })) renderer.accept(batch);
    }

    assert.deepEqual(
      renderer.snapshot().messages.flatMap((message) =>
        message.type === 'assistant' && message.turnId === 'b' ? [message.text] : []),
      ['B partial and completed answer'],
      'reading forward from the edge brings the completed body back',
    );
    assert.equal(replica.snapshot().overlay.length, 0);
  } finally {
    await fixture.close();
  }
});

test('a completed live answer remains unique after a fresh transcript subscription', async () => {
  const fixture = await openFixture();
  let reopened: Awaited<ReturnType<typeof openSettledReplica>> | undefined;
  const assertAnswer = (messages: readonly StoredMessage[]) => {
    const answers = messages.flatMap((message) => message.type === 'assistant' && message.turnId === 'b'
      ? [{ id: message.id, text: message.text }] : []);
    assert.deepEqual(answers, [
      { id: 'answer-b', text: 'B partial and completed answer' },
    ]);
  };
  try {
    await fixture.advance(B_COMPLETED_THROUGH);
    assert.deepEqual(fixture.replica.snapshot().overlay, []);
    assertAnswer(fixture.renderer.snapshot().messages);
    assertAnswer((await fixture.ledger.durableRecords()).map(({ message }) => message));

    reopened = await openSettledReplica(fixture.ledger);
    const renderer = new DesktopTranscriptRangeStore(JSON.stringify(['local', fixture.ledger.sessionId]));
    for (const batch of encodeDesktopTranscriptSnapshot(reopened.replica.snapshot())) renderer.accept(batch);
    assert.deepEqual(reopened.replica.snapshot().overlay, []);
    assertAnswer(renderer.snapshot().messages);
  } finally {
    await reopened?.close();
    await fixture.close();
  }
});

test('retains an unfinished overlay through runtime checkpoints', async () => {
  const fixture = await openFixture();
  try {
    const { replica, renderer } = fixture;
    await fixture.advance(B_STEERING_THROUGH);
    assert.equal(replica.durableThrough, fixture.bootstrapThrough, 'running B has no durable ending yet');
    const unfinished = replica.snapshot().overlay.find(({ id }) => id === 'answer-b');
    assert.equal(unfinished?.type === 'assistant' ? unfinished.text : undefined, 'B partial');

    await fixture.advance(B_COMPLETED_THROUGH);
    assert.deepEqual(
      replica.snapshot().overlay,
      [],
      'the Turn ending retires exactly the overlay rows it made durable',
    );
    assert.deepEqual(
      renderer.snapshot().messages.flatMap((message) =>
        message.type === 'assistant' && message.turnId === 'b' ? [message.text] : []),
      ['B partial and completed answer'],
    );
  } finally {
    await fixture.close();
  }
});

test('catch-up retires the completed overlay in one notification', async () => {
  const fixture = await openFixture();
  try {
    const { replica, changes, requests } = fixture;
    const before = requests.length;
    await fixture.advance(B_COMPLETED_THROUGH);
    const settled = changes.filter((change) =>
      change.durableUpserts.some(({ message }) => message.id === 'answer-b'));
    assert.equal(settled.length, 1);
    const answer = replica.messages().find(({ id }) => id === 'answer-b');
    assert.equal(answer?.type === 'assistant' ? answer.text : undefined, 'B partial and completed answer');
    assert.equal(requests.length - before, 1, 'catch-up settles through the same page it installs');
    assert.deepEqual(replica.snapshot().overlay, []);
  } finally {
    await fixture.close();
  }
});

test('a window page read retires the tail overlay copy without notifying other windows', async () => {
  const older: StoredMessage = {
    type: 'assistant', id: 'answer-older', turnId: 'older', ts: 1,
    text: 'Older answer', modelId: 'fixture-model',
  };
  const newest: StoredMessage = {
    type: 'assistant', id: 'answer-newest', turnId: 'newest', ts: 2,
    text: 'Newest answer', modelId: 'fixture-model',
  };
  const durablePage = (): SessionTranscriptPage => ({
    kind: 'page', sessionId: 'session-1', source: 'durable', direction: 'older',
    throughSequence: 2, rawBytes: 1, fragments: [], rangeBoundarySequence: null,
    protectedTurnSequence: null, nextCursor: null,
  });
  const bootstrap = durablePage();
  const decoded = new Map<SessionTranscriptPage, {
    messages: Array<{ identity: number; message: StoredMessage }>;
    nextCursor: string | null;
  }>([[bootstrap, { messages: [{ identity: 2, message: newest }], nextCursor: null }]]);
  const changes: DesktopTranscriptReplicaChange[] = [];
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: { sessionId: 'session-1', metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
      projectionRevision: 1, rootTurn: null, goal: null,
      queue: { hostEpoch: HOST_EPOCH, queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 2, overlayMessageCount: 1,
      durable: bootstrap, overlay: { ...bootstrap, source: 'overlay' },
    },
    // The Host was still streaming the older answer when the subscription
    // opened, so bootstrap holds an overlay copy of an already durable row.
    loadTranscriptOverlay: async () => [older],
    loadTranscriptPage: async () => {
      const page = durablePage();
      decoded.set(page, { messages: [{ identity: 1, message: older }], nextCursor: null });
      return page;
    },
    decodeTranscriptPage: async (page) => decoded.get(page)!,
    async close() {},
  }), { onChange: (_replica, change) => changes.push(change) });
  try {
    assert.deepEqual(replica.snapshot().overlay.map(({ id }) => id), ['answer-older']);

    const page = await replica.loadBefore(2, PAGE_BYTES);

    assert.ok(page);
    assert.deepEqual(page.durable.map(({ message }) => message.id), ['answer-older']);
    assert.deepEqual(replica.snapshot().overlay, [], 'the durable row retires the tail overlay copy');
    assert.deepEqual(changes, [], 'a window page changes nothing another window holds');
    assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [2]);
  } finally {
    replica.close();
  }
});

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
      // Tail growth is broadcast to every consumer and carries no navigation.
      const identity = {
        sessionId: current.sessionId,
        generation: current.generation,
        hostEpoch: current.hostEpoch,
      };
      for (const batch of encodeDesktopTranscriptChange(identity, change)) renderer.accept(batch);
    },
  });
  for (const batch of encodeDesktopTranscriptSnapshot(replica.snapshot())) renderer.accept(batch);
  const watermarks = new Map<string, number>();
  let frameSequence = 0;
  const announce = async (checkpoint: string) => {
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
    watermark: (checkpoint: string) => {
      const value = watermarks.get(checkpoint);
      assert.notEqual(value, undefined);
      return value!;
    },
    async advance(messageId: string) {
      await announce(messageId);
      await replica.advance(watermarks.get(messageId) ?? bootstrapThrough);
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
