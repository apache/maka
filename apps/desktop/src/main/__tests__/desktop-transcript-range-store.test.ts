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
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import {
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptPage,
  encodeDesktopTranscriptSnapshot,
} from '../desktop-transcript-ipc.js';
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE,
  DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS,
} from '../../preload/transcript-contract.js';
import {
  createDesktopTranscriptReconnectRecovery,
  createRecoveringDesktopTranscriptRangeController,
  createDesktopTranscriptRangeController,
  DesktopTranscriptRangeStore,
} from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import { TranscriptReadSupersededError } from '../../renderer/features/conversation/index.js';
import { mergeSettledMessages } from '../../renderer/settled-message-merge.js';
import {
  readSettledMessages,
  readSettledMessagesFrom,
} from '../../renderer/platform/desktop/session-message-settlement.js';
import { DesktopTranscriptReplica, type DesktopTranscriptReplicaChange } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

test('merges a settled tail without dropping earlier messages', () => {
  const earlier = assistantMessage('earlier', 'assistant-earlier');
  const current = assistantMessage('partial', 'assistant-current');
  const settled = assistantMessage('complete', current.id);
  const latest = assistantMessage('latest', 'assistant-latest');

  assert.deepEqual(mergeSettledMessages([earlier, current], [settled, latest]), [
    earlier,
    settled,
    latest,
  ]);
});

test('merges an anchored historical range before its overlapping tail', () => {
  const answerA = { ...assistantMessage('answer A', 'assistant-a'), turnId: 'turn-a', ts: 9 };
  const answerB = { ...assistantMessage('answer B', 'assistant-b'), turnId: 'turn-b', ts: 20 };
  const partialC = { ...assistantMessage('partial C', 'assistant-c'), turnId: 'turn-c', ts: 10 };
  const answerC = { ...partialC, text: 'answer C' };

  assert.deepEqual(
    mergeSettledMessages([answerA, partialC], [answerB, answerC]),
    [answerA, answerB, answerC],
  );
});

test('cancels settlement while transcript open is pending', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let cancelled = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      maka: {
        transcripts: {
          open: async (
            _sessionId: string,
            _handler: unknown,
            registerCancellation: (cancel: () => void) => void,
          ) => new Promise<never>((_resolve, reject) => {
            registerCancellation(() => {
              cancelled = true;
              reject(new Error('open cancelled'));
            });
          }),
        },
      },
    },
  });
  const controller = new AbortController();
  try {
    const settling = readSettledMessages(JSON.stringify(['host-1', 'session-1']), {
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(settling, /settlement was cancelled/);
    assert.equal(cancelled, true);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

for (const paged of [false, true]) {
  test(`reads one Host-owned Turn outside the bounded transcript tail${paged ? ' across multiple pages' : ''}`, async () => {
    const sessionKey = JSON.stringify(['host-1', 'session-1']);
    const turnB: StoredMessage[] = [
      userMessage('follow-up one', 'user-b'),
      { ...assistantMessage('answer B', 'assistant-b'), turnId: 'turn-b', ts: 4 },
      {
        type: 'turn_state',
        id: 'complete-b',
        turnId: 'turn-b',
        ts: 5,
        status: 'completed',
      },
    ];
    const turnC: StoredMessage[] = [
      userMessage('follow-up two', 'user-c'),
      { ...assistantMessage('answer C', 'assistant-c'), turnId: 'turn-c', ts: 7 },
      {
        type: 'turn_state',
        id: 'complete-c',
        turnId: 'turn-c',
        ts: 8,
        status: 'completed',
      },
    ];
    const navigations: number[] = [];
    const extensions: number[] = [];
    let deliverySequence = 0;

    const result = await readSettledMessagesFrom(
      {
        sessions: {
          listTurns: async (sessionId) => {
            assert.equal(sessionId, sessionKey);
            return [{ turnId: 'turn-b', firstSequence: 3, status: 'completed' }];
          },
        },
        transcripts: {
          open: async (_sessionId, handler) => {
            for (const batch of encodeDesktopTranscriptSnapshot({
              sessionId: 'session-1',
              generation: 'generation-1',
              hostEpoch: 'host-1',
              durableThrough: 8,
              durable: turnC.map((message, index) => ({ sequence: index + 6, message })),
              overlay: [],
              hasOlder: true,
              hasNewer: false,
            })) handler({ ...batch, deliverySequence: ++deliverySequence });
            return {
              sessionId: sessionKey,
              generation: 'generation-1',
              hostEpoch: 'host-1',
              readThroughMessageId: 'complete-c',
              async acknowledgeTail() { assert.fail('A recovery read must not mark the Session read'); },
              async loadBefore() {},
              async loadAfter(sequence, maxBytes, navigation) {
                assert.equal(maxBytes, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
                assert.equal(sequence, 4);
                extensions.push(sequence);
                for (const batch of encodeDesktopTranscriptPage({
                  sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1', navigation,
                }, {
                  durableThrough: 8,
                  durable: [{ sequence: 5, message: turnB[2]! }],
                  hasNewer: true,
                }, { direction: 'newer', anchor: sequence })) {
                  handler({ ...batch, deliverySequence: ++deliverySequence });
                }
              },
              async loadAround(sequence, maxBytes, navigation) {
                assert.equal(maxBytes, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
                navigations.push(sequence);
                for (const batch of encodeDesktopTranscriptSnapshot({
                  sessionId: 'session-1',
                  generation: 'generation-1',
                  hostEpoch: 'host-1',
                  durableThrough: 8,
                  durable: (paged ? turnB.slice(0, 2) : turnB).map((message, index) => ({ sequence: index + 3, message })),
                  overlay: [],
                  hasOlder: true,
                  hasNewer: true,
                }, navigation)) handler({ ...batch, deliverySequence: ++deliverySequence });
              },
              async loadLatest() {},
              async close() {},
            };
          },
        },
      },
      sessionKey,
      { requiredTurnId: 'turn-b' },
    );

    assert.deepEqual(navigations, [3]);
    assert.deepEqual(extensions, paged ? [4] : []);
    assert.deepEqual(result, { messages: [...turnB, ...turnC], settled: true });
  });
}

for (const hasSequence of [false, true]) {
  test(`does not settle when a targeted Host-owned Turn ${hasSequence ? 'cannot be recovered' : 'has no indexed sequence'}`, async () => {
    const sessionKey = JSON.stringify(['host-1', 'session-1']);
    const tail: StoredMessage[] = [
      { ...assistantMessage('answer C', 'assistant-c'), turnId: 'turn-c', ts: 7 },
      {
        type: 'turn_state',
        id: 'complete-c',
        turnId: 'turn-c',
        ts: 8,
        status: 'completed',
      },
    ];
    let targetedRead = false;
    let deliverySequence = 0;

    const result = await readSettledMessagesFrom(
      {
        sessions: {
          listTurns: async () => [{
            turnId: 'missing-turn', status: 'completed', ...(hasSequence ? { firstSequence: 3 } : {}),
          }],
        },
        transcripts: {
          open: async (_sessionId, handler) => {
            for (const batch of encodeDesktopTranscriptSnapshot({
              sessionId: 'session-1',
              generation: 'generation-1',
              hostEpoch: 'host-1',
              durableThrough: 8,
              durable: tail.map((message, index) => ({ sequence: index + 7, message })),
              overlay: [],
              hasOlder: true,
              hasNewer: false,
            })) handler({ ...batch, deliverySequence: ++deliverySequence });
            return {
              sessionId: sessionKey,
              generation: 'generation-1',
              hostEpoch: 'host-1',
              readThroughMessageId: 'complete-c',
              async acknowledgeTail() {},
              async loadBefore() {},
              async loadAfter() {},
              async loadAround() {
                targetedRead = true;
              },
              async loadLatest() {},
              async close() {},
            };
          },
        },
      },
      sessionKey,
      { requiredTurnId: 'missing-turn' },
    );

    assert.equal(targetedRead, hasSequence);
    assert.deepEqual(result, { messages: tail, settled: false });
  });
}

test('moves a fragmented overlay record to durable storage without duplicating it', () => {
  const message = assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES * 2));
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const store = transcriptStore();
  const snapshot = [...encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: null,
    durable: [],
    overlay: [message],
    hasOlder: false,
    hasNewer: false,
  })];

  assert.ok(snapshot.length > 1);
  for (const [index, batch] of snapshot.entries()) {
    assert.ok(
      batch.fragments.reduce(
        (total, fragment) => total + fragment.data.byteLength,
        0,
      ) <= DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
    );
    assert.equal(store.accept(batch), index === snapshot.length - 1);
  }
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal(store.hasDurableMessage(message.id), false);

  const change = [...encodeDesktopTranscriptChange(identity, {
    coversFrom: null,
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message }],
  })];
  for (const batch of change) store.accept(batch);
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal(store.hasDurableMessage(message.id), true);

  for (const batch of change) assert.equal(store.accept(batch), false);
  assert.deepEqual(store.snapshot().messages, [message]);
});

test('tracks the newest resident durable prompt as the window changes', () => {
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: 3,
    durable: [
      { sequence: 1, message: userMessage('older', 'user-1') },
      { sequence: 2, message: assistantMessage('answer') },
      { sequence: 3, message: userMessage('newer', 'user-3') },
    ],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);
  assert.equal(store.newestDurableUserSequence(), 3);

  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 3,
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message: assistantMessage('latest') }],  })) store.accept(batch);
  assert.equal(store.newestDurableUserSequence(), 3);

  store.retain(2, null);
  assert.equal(store.newestDurableUserSequence(), 3);
  store.retain(4, null);
  assert.equal(store.newestDurableUserSequence(), null);
});

test('drops stale transcript batches after a generation reset', () => {
  const store = transcriptStore();
  const oldBatches = [...encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1',
    generation: 'old',
    hostEpoch: 'host-1',
    durableThrough: 1,
    durable: [{ sequence: 1, message: assistantMessage('old') }],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })];
  const nextMessage = assistantMessage('new');
  const nextBatches = [...encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1',
    generation: 'next',
    hostEpoch: 'host-2',
    durableThrough: 2,
    durable: [{ sequence: 2, message: nextMessage }],
    overlay: [],
    hasOlder: true,
    hasNewer: false,
  })];

  for (const batch of oldBatches) store.accept(batch);
  for (const batch of nextBatches) store.accept(batch);
  const staleChange = [...encodeDesktopTranscriptChange(
    { sessionId: 'session-1', generation: 'old', hostEpoch: 'host-1' },
    {
      coversFrom: 2,
      durableThrough: 3,
      durableUpserts: [{ sequence: 3, message: assistantMessage('stale') }],    },
  )];
  for (const batch of staleChange) assert.equal(store.accept(batch), false);
  assert.deepEqual(store.snapshot().messages, [nextMessage]);
});

test('cached reload snapshots allow the same live transcript generation to resume', async () => {
  const store = transcriptStore();
  const identity = {
    sessionId: 'session-1',
    generation: 'live-generation',
    hostEpoch: 'host-1',
  };
  let opens = 0;
  const deliveries: Array<{ generation: string; accepted: boolean }> = [];
  const publish = (generation: string, text: string, navigation?: number) => {
    for (const batch of encodeDesktopTranscriptSnapshot({
      ...identity, generation, durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(text) }],
      overlay: [], hasOlder: false, hasNewer: false,
    }, navigation)) deliveries.push({ generation, accepted: store.accept(batch) });
  };
  const controller = createDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    if (opens > 1) {
      publish(`cached:reload-${opens}`, 'cached');
      assert.deepEqual(store.snapshot().messages, [assistantMessage('cached')]);
    }
    // The event subscription keeps the main-process replica alive between opens.
    publish(identity.generation, `live-${opens}`);
    return {
      ...identity, readThroughMessageId: null,
      async acknowledgeTail() {},
      async loadBefore() {},
      async loadAfter() {},
      async loadAround(_sequence, _maxBytes, navigation) {
        publish(identity.generation, `live-${opens}`, navigation);
      },
      async loadLatest(navigation) {
        publish(identity.generation, `live-${opens}`, navigation);
      },
      async close() {},
    };
  });

  try {
    await controller.ready();
    for (let reload = 1; reload <= 2; reload += 1) {
      await controller.reload();
      assert.equal(store.range().generation, identity.generation);
      assert.deepEqual(store.snapshot().messages, [assistantMessage(`live-${reload + 1}`)]);
    }
    assert.equal(opens, 3);
    assert.ok(deliveries.every(({ accepted }) => accepted));

    const updated = assistantMessage('live update', 'assistant-2');
    for (const batch of encodeDesktopTranscriptChange(identity, {
      coversFrom: 1,
      durableThrough: 2,
      durableUpserts: [{ sequence: 2, message: updated }],    })) assert.equal(store.accept(batch), true);
    assert.deepEqual(store.snapshot().messages, [assistantMessage('live-3'), updated]);
  } finally {
    await controller.close();
  }
});

test('a replacement live generation retires the previous replica through cached snapshots', () => {
  for (const cachedGenerations of [[], ['cached:first', 'cached:second']]) {
    const store = transcriptStore();
    const snapshot = (generation: string) => [...encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1', generation, hostEpoch: 'host-1', durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(generation) }],
      overlay: [], hasOlder: false, hasNewer: false,
    })];
    const generations = ['previous-live', ...cachedGenerations, 'replacement-live'];
    for (const generation of generations) {
      for (const batch of snapshot(generation)) assert.equal(store.accept(batch), true);
    }
    const replacement = store.snapshot();
    for (const generation of generations.slice(0, -1)) {
      for (const batch of snapshot(generation)) assert.equal(store.accept(batch), false);
      for (const batch of encodeDesktopTranscriptChange({
        sessionId: 'session-1', generation, hostEpoch: 'host-1',
      }, {
        coversFrom: 1,
        durableThrough: 2,
        durableUpserts: [{ sequence: 2, message: assistantMessage('stale', 'stale') }],      })) assert.equal(store.accept(batch), false);
    }
    assert.strictEqual(store.snapshot(), replacement);
    assert.deepEqual(store.snapshot().messages, [assistantMessage('replacement-live')]);
  }
});

test('keeps unchanged message references stable across immutable range snapshots', () => {
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const firstMessage = userMessage('first', 'user-1');
  const secondMessage = assistantMessage('second', 'assistant-2');
  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: 1,
    durable: [{ sequence: 1, message: firstMessage }],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);

  const first = store.snapshot();
  assert.strictEqual(store.snapshot(), first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.messages));
  assert.ok(Object.isFrozen(first.messages[0]));

  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 1,
    durableThrough: 2,
    durableUpserts: [{ sequence: 2, message: secondMessage }],  })) store.accept(batch);

  const second = store.snapshot();
  assert.notStrictEqual(second, first);
  assert.strictEqual(second.messages[0], first.messages[0]);
  assert.deepEqual(second.messages, [firstMessage, secondMessage]);
});

test('bounds the default active transcript range by Turn identities', async () => {
  const messages = Array.from({ length: 200 }, (_, sequence) => ({
    identity: sequence,
    message: {
      ...assistantMessage(String(sequence), `assistant-${sequence}`),
      turnId: `turn-${sequence}`,
    },
  }));
  const bootstrapPage = transcriptPage('older', null, messages.length - 1);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: messages.length - 1,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, messages.length - 1), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async () => ({ messages, nextCursor: null }),
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle);

  const snapshot = replica.snapshot();
  assert.equal(
    new Set(snapshot.durable.map(({ message }) => message.turnId)).size,
    DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS,
  );
  assert.equal(
    snapshot.durable[0]?.sequence,
    messages.length - DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS,
  );
  assert.equal(snapshot.durable.at(-1)?.sequence, 199);
  assert.equal(snapshot.hasOlder, true);
  assert.equal(snapshot.hasNewer, false);
});

test('bounds the default active transcript range by presentation bytes', async () => {
  const messages = syntheticLargeTranscript();
  const bootstrapPage = transcriptPage('older', null, messages.length - 1);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: messages.length - 1,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, messages.length - 1), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async () => ({ messages, nextCursor: null }),
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle);

  const snapshot = replica.snapshot();
  const bytes = snapshot.durable.reduce(
    (total, { message }) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
    0,
  );
  assert.ok(bytes <= DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
  assert.deepEqual(snapshot.durable.map(({ sequence }) => sequence), [12, 13, 14, 15]);
  assert.equal(snapshot.hasOlder, true);
  assert.equal(snapshot.hasNewer, false);
});

test('keeps an oversized latest Turn visible after bootstrap eviction', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-0'), turnId: 'turn-0' },
  };
  const latest = {
    identity: 1,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1), 'assistant-1'),
  };
  const bootstrapPage = transcriptPage('older', null, latest.identity);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: latest.identity,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, latest.identity), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async () => ({ messages: [older, latest], nextCursor: null }),
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle);

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [latest.identity]);
  assert.equal(replica.snapshot().hasOlder, true);
});

test('keeps an oversized latest Turn visible before a trailing session note', async () => {
  const latest = {
    identity: 0,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1), 'assistant-0'),
  };
  const trailingNote = {
    identity: 1,
    message: {
      type: 'system_note' as const,
      id: 'mode-change-1',
      ts: 2,
      kind: 'mode_change' as const,
    },
  };
  const bootstrapPage = {
    ...transcriptPage('older', null, trailingNote.identity),
    rangeBoundarySequence: latest.identity,
    protectedTurnSequence: latest.identity,
  };
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: trailingNote.identity,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: {
        ...bootstrapPage,
        source: 'overlay',
        rangeBoundarySequence: null,
        protectedTurnSequence: null,
      },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async () => ({ messages: [latest, trailingNote], nextCursor: null }),
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle);

  assert.ok(replica.snapshot().durable.some(({ sequence }) => sequence === latest.identity));
});

test('advances a projected transcript across hidden durable records', async () => {
  const visible = (sequence: number) => ({
    identity: sequence,
    message: userMessage(`Visible ${sequence}`, `user-${sequence}`),
  });
  const bootstrapPage = transcriptPage('older', null, 1);
  const visibleAdvancePage = transcriptPage('newer', null, 5);
  const hiddenAdvancePage = transcriptPage('newer', null, 6);
  const changes: { durableUpserts: readonly { sequence: number }[] }[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 1,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 1), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (page) => ({
      messages:
        page === bootstrapPage
          ? [visible(0)]
          : page === visibleAdvancePage
            ? [visible(3), visible(4)]
            : [],
      nextCursor: null,
    }),
    loadTranscriptPage: async ({ throughSequence }) =>
      throughSequence === 5 ? visibleAdvancePage : hiddenAdvancePage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    onChange: (_replica, change) => changes.push(change),
  });

  // Sequences 1, 2, 5, and 6 are valid Host-private records omitted from the
  // Guest projection. The physical watermark still advances across them.
  await replica.advance(5);
  await replica.advance(6);

  assert.equal(replica.durableThrough, 6);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [0, 3, 4]);
  assert.deepEqual(
    changes.flatMap((change) => change.durableUpserts.map(({ sequence }) => sequence)),
    [3, 4],
  );
});

test('keeps an oversized streaming Turn visible when its overlay settles', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-0'), turnId: 'turn-0' },
  };
  const latest = {
    identity: 1,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1), 'assistant-1'),
  };
  const bootstrapPage = transcriptPage('older', null, older.identity);
  const newerPage = {
    ...transcriptPage('newer', null, latest.identity),
    rangeBoundarySequence: latest.identity,
    protectedTurnSequence: latest.identity,
  };
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: older.identity,
      overlayMessageCount: 1,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, older.identity), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [latest.message],
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: [older], nextCursor: null }
      : { messages: [latest], nextCursor: null },
    loadTranscriptPage: async () => newerPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);
  assert.deepEqual(replica.snapshot().overlay.map(({ id }) => id), [latest.message.id]);

  await replica.advance(latest.identity);

  const snapshot = replica.snapshot();
  assert.deepEqual(snapshot.durable.map(({ sequence }) => sequence), [latest.identity]);
  assert.deepEqual(snapshot.overlay, []);
});

test('keeps an oversized settled Turn visible before a trailing session note', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-0'), turnId: 'turn-0' },
  };
  const latest = {
    identity: 1,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1), 'assistant-1'),
  };
  const trailingNote = {
    identity: 2,
    message: {
      type: 'system_note' as const,
      id: 'mode-change-2',
      ts: 3,
      kind: 'mode_change' as const,
    },
  };
  const bootstrapPage = transcriptPage('older', null, older.identity);
  const newerPage = {
    ...transcriptPage('newer', null, trailingNote.identity),
    rangeBoundarySequence: trailingNote.identity,
    protectedTurnSequence: latest.identity,
  };
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: older.identity,
      overlayMessageCount: 1,
      durable: bootstrapPage,
      overlay: { ...bootstrapPage, source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [latest.message],
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: [older], nextCursor: null }
      : { messages: [latest, trailingNote], nextCursor: null },
    loadTranscriptPage: async () => newerPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await replica.advance(trailingNote.identity);

  const snapshot = replica.snapshot();
  assert.ok(snapshot.durable.some(({ sequence }) => sequence === latest.identity));
  assert.deepEqual(snapshot.overlay, []);
});

for (const direction of ['older', 'newer'] as const) {
  test(`does not resurrect a discarded replica when ${direction} history load is in flight`, async () => {
    // A pending page must not repopulate or publish a reclaimed replica.
    const messages = [0, 1, 2, 3, 4].map((sequence) => ({
      identity: sequence,
      message: assistantMessage(String(sequence), `assistant-${sequence}`),
    }));
    const page = (nextCursor: string | null) => ({
      kind: 'page' as const,
      sessionId: 'session-1',
      source: 'durable' as const,
      direction: 'older' as const,
      throughSequence: 4,
      rawBytes: 1,
      fragments: [],
      rangeBoundarySequence: null,
      protectedTurnSequence: null,
      nextCursor,
    });
    const bootstrapPage = page('older');
    const adjacentPage = { ...page(null), direction };
    let releasePage: () => void = () => {};
    const pageGate = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    let signalEntered: () => void = () => {};
    const pageEntered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const changes: { durableUpserts: readonly { sequence: number }[] }[] = [];
    const handle = runtimeHostSessionFixture({
      snapshot: continuitySnapshot(),
      transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() {} },
      transcriptBootstrap: {
        throughSequence: 4,
        overlayMessageCount: 0,
        durable: bootstrapPage,
        overlay: { ...page(null), source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
        ? { messages: direction === 'older' ? messages.slice(4) : messages.slice(0, 1), nextCursor: 'older' }
        : { messages: messages.slice(2, 4), nextCursor: null },
      loadTranscriptPage: async () => {
        signalEntered();
        await pageGate;
        return adjacentPage;
      },
      async close() {},
    });
    const replica = await DesktopTranscriptReplica.prepare(handle, {
      maxResidentBytes: 1024 * 1024,
      onChange: (_replica, change) => changes.push(change),
    });

    // Reclaim memory while an adjacent history page is pending.
    const loading = direction === 'older'
      ? replica.loadBefore(4, 128 * 1024)
      : replica.loadAfter(1, 128 * 1024);
    await pageEntered;
    replica.discard();
    assert.equal(replica.resident, false);
    releasePage();
    await loading;

    assert.equal(changes.length, 0, 'a discarded replica must not publish an in-flight history page');
    assert.equal(replica.resident, false);
    assert.equal(replica.residentBytes, 0);
  });
}

test('does not drive a discarded replica terminal when a contiguous catch-up is in flight', async () => {
  // Same post-await `#resident` invariant on the ordinary contiguous catch-up
  // path: another observed session's LRU `discard()` reclaims this replica while
  // a `direction: 'newer'` page is pending. The per-page callback already returns
  // early, but without the post-loop guard the watermark check would throw
  // `correlation_changed` and drive the session terminal. A discarded replica has
  // no watermark to meet — catch-up must return cleanly, not reject.
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const appended = { identity: 5, message: assistantMessage('5', 'assistant-5') };
  const page = (nextCursor: string | null, throughSequence: number) => ({
    kind: 'page' as const,
    sessionId: 'session-1',
    source: 'durable' as const,
    direction: 'newer' as const,
    throughSequence,
    rawBytes: 1,
    fragments: [],
    rangeBoundarySequence: null,
    protectedTurnSequence: null,
    nextCursor,
  });
  const bootstrapPage = page(null, 4);
  const newerPage = page(null, 5);
  let releaseNewer: () => void = () => {};
  const newerGate = new Promise<void>((resolve) => {
    releaseNewer = resolve;
  });
  let signalEntered: () => void = () => {};
  const newerEntered = new Promise<void>((resolve) => {
    signalEntered = resolve;
  });
  const changes: { durableUpserts: readonly { sequence: number }[] }[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 4,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...page(null, 4), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
      ? { messages, nextCursor: null }
      : { messages: [appended], nextCursor: null },
    loadTranscriptPage: async () => {
      // Park catch-up inside the contiguous newer-page await so the test can
      // reclaim memory at exactly that point.
      signalEntered();
      await newerGate;
      return newerPage;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1024 * 1024,
    onChange: (_replica, change) => changes.push(change),
  });
  // A large budget keeps the whole bootstrap resident, so the tail is contiguous
  // (`hasNewer` false) and `advance` takes the paged catch-up, not the re-anchor.
  assert.equal(replica.snapshot().hasNewer, false);

  // Advance the watermark contiguously; reclaim memory while the newer page is
  // pending. Before the fix `advancing` rejects with `correlation_changed`.
  const advancing = replica.advance(5);
  await newerEntered;
  replica.discard();
  assert.equal(replica.resident, false);
  releaseNewer();
  await advancing;

  const upserts = changes.flatMap((change) => change.durableUpserts.map(({ sequence }) => sequence));
  assert.ok(!upserts.includes(5), 'a discarded replica must not be repopulated by an in-flight catch-up');
  assert.equal(replica.resident, false);
  assert.equal(replica.residentBytes, 0);
});

test('a window opened between catch-up pages can join the change that follows', async () => {
  const bootstrap = [0, 1, 2].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const firstPage = [3, 4, 5].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const secondPage = [{ identity: 6, message: assistantMessage('6', 'assistant-6') }];
  const page = (nextCursor: string | null, throughSequence: number) => ({
    kind: 'page' as const,
    sessionId: 'session-1',
    source: 'durable' as const,
    direction: 'newer' as const,
    throughSequence,
    rawBytes: 1,
    fragments: [],
    rangeBoundarySequence: null,
    protectedTurnSequence: null,
    nextCursor,
  });
  const bootstrapPage = page(null, 2);
  const first = page('more', 6);
  const second = page(null, 6);
  let releaseSecond: () => void = () => {};
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  let signalSecond: () => void = () => {};
  const secondEntered = new Promise<void>((resolve) => { signalSecond = resolve; });
  const changes: DesktopTranscriptReplicaChange[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 2,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...page(null, 2), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
      ? { messages: bootstrap, nextCursor: null }
      : candidate === first
        ? { messages: firstPage, nextCursor: 'more' }
        : { messages: secondPage, nextCursor: null },
    loadTranscriptPage: async (request) => {
      if (request.cursor === null) return first;
      signalSecond();
      await secondGate;
      return second;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1024 * 1024,
    onChange: (_replica, change) => changes.push(change),
  });

  const advancing = replica.advance(6);
  await secondEntered;
  // The first page is installed; the second is pending. A window opening now
  // must be told the watermark its rows actually reach.
  const opened = replica.snapshot();
  assert.deepEqual(opened.durable.map(({ sequence }) => sequence), [0, 1, 2, 3, 4, 5]);
  assert.equal(opened.durableThrough, 5);
  releaseSecond();
  await advancing;

  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot(opened)) store.accept(batch);
  const identity = { sessionId: replica.sessionId, generation: replica.generation, hostEpoch: replica.hostEpoch };
  for (const change of changes.slice(1)) {
    for (const batch of encodeDesktopTranscriptChange(identity, change)) store.accept(batch);
  }
  assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(store.range().hasNewer, false);
});

test('rejects an overlay that exceeds its cache budget', async () => {
  const messages = [
    assistantMessage('x'.repeat(700), 'overlay-1'),
    assistantMessage('y'.repeat(700), 'overlay-2'),
  ];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    loadTranscriptOverlay: async () => messages,
    async close() {},
  });

  await assert.rejects(
    DesktopTranscriptReplica.prepare(handle, {
      maxResidentBytes: 1_024,
      maxOverlayBytes: 1_024,
      maxMessageBytes: 1_024,
    }),
    /overlay exceeds the session cache limit/,
  );
});

test('transfers prepared transcript bytes into active replica accounting', async () => {
  const message = assistantMessage('prepared', 'overlay-1');
  const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  let accountedBytes = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    loadTranscriptOverlay: async (_maxMessageBytes, accountAssemblyBytes) => {
      accountAssemblyBytes?.(messageBytes);
      accountAssemblyBytes?.(-messageBytes);
      return [message];
    },
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle, {
    accountPreparationBytes: (deltaBytes) => {
      accountedBytes += deltaBytes;
    },
  });
  assert.equal(accountedBytes, messageBytes);
  replica.adoptResidentAccounting();
  assert.equal(accountedBytes, 0);
  replica.close();
  assert.equal(accountedBytes, 0);
});

test('does not release resident bytes when preparation accounting rejects them', async () => {
  const message = assistantMessage('prepared', 'overlay-1');
  const deltas: number[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    loadTranscriptOverlay: async () => [message],
    async close() {},
  });

  await assert.rejects(
    DesktopTranscriptReplica.prepare(handle, {
      accountPreparationBytes: (deltaBytes) => {
        deltas.push(deltaBytes);
        if (deltaBytes > 0) throw new RangeError('capacity reached');
      },
    }),
    /capacity reached/,
  );
  assert.deepEqual(deltas.filter((deltaBytes) => deltaBytes < 0), []);
});

test('reopens a failed transcript range with a fresh generation', async () => {
  const store = transcriptStore();
  let attempts = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('open failed');
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: 'session-1',
      generation: 'reloaded',
      hostEpoch: 'host-2',
      durableThrough: null,
      durable: [],
      overlay: [],
      hasOlder: false,
      hasNewer: false,
    }))
      store.accept(batch);
    return {
      sessionId: 'session-1',
      generation: 'reloaded',
      hostEpoch: 'host-2',
      readThroughMessageId: null,
      async acknowledgeTail() {},
      async loadBefore() {},
      async loadAfter() {},
      async loadAround() {},
      async loadLatest() {},
      async close() {},
    };
  });

  await assert.rejects(() => controller.ready(), /open failed/);
  await controller.reload();
  assert.equal(store.range().generation, 'reloaded');
  await controller.close();
});

test('retries a failed transcript recovery after a newer observation becomes ready', async () => {
  let rejectFirstReload!: (error: Error) => void;
  const firstReload = new Promise<void>((_resolve, reject) => {
    rejectFirstReload = reject;
  });
  let resolveSecondReload!: () => void;
  const secondReload = new Promise<void>((resolve) => {
    resolveSecondReload = resolve;
  });
  const reloads: Promise<void>[] = [firstReload, secondReload];
  const errors: string[] = [];
  const recovery = createDesktopTranscriptReconnectRecovery({
    reload: () => {
      const reload = reloads.shift();
      if (!reload) throw new Error('unexpected transcript reload');
      return reload;
    },
    onError(error) {
      errors.push(error instanceof Error ? error.message : String(error));
    },
  });

  recovery.transcriptFailed(new Error('initial open failed'));
  recovery.observationChanged('ready');
  await Promise.resolve();
  recovery.observationChanged('pending');
  recovery.observationChanged('ready');
  rejectFirstReload(new Error('replaced transcript failed'));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(reloads.length, 0, 'the newer ready signal starts one trailing reload');
  resolveSecondReload();
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(errors, ['initial open failed', 'replaced transcript failed']);
  recovery.close();
});

test('forwards a larger logical history range without changing batch size', async () => {
  const store = transcriptStore();
  // Rows below an open newer edge only install as a command's answer, so this
  // snapshot has to be one: it is the window a navigation asked for.
  for (const batch of encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
    durableThrough: 4,
    durable: [
      { sequence: 1, message: assistantMessage('earlier') },
      {
        sequence: 2,
        message: { ...assistantMessage('latest', 'assistant-2'), turnId: 'turn-2' },
      },
      {
        sequence: 3,
        message: { ...assistantMessage('more', 'assistant-3'), turnId: 'turn-2' },
      },
    ],
    overlay: [],
    hasOlder: true,
    hasNewer: true,
  }, store.navigate())) store.accept(batch);
  let request: { anchorSequence: number | null; maxBytes?: number } | undefined;
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
    readThroughMessageId: 'assistant-1',
    async acknowledgeTail() {},
    async loadBefore(anchorSequence, maxBytes) {
      request = { anchorSequence, maxBytes };
    },
    async loadAfter(anchorSequence, maxBytes) {
      request = { anchorSequence, maxBytes };
    },
    async loadAround() {},
    async loadLatest() {},
    async close() {},
  }));

  await controller.loadBefore(512 * 1024);

  assert.deepEqual(request, { anchorSequence: 1, maxBytes: 512 * 1024 },
    'backward reads start at the oldest record the window holds');
  await controller.loadAfter(512 * 1024);
  assert.deepEqual(request, { anchorSequence: 3, maxBytes: 512 * 1024 },
    'forward reads start at the newest record the window holds');
  await controller.close();
});

test('waits for the required durable message on the current transcript generation', async () => {
  const store = transcriptStore();
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity,
    durableThrough: null,
    durable: [],
    overlay: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);
  const waiting = store.waitForDurableMessage('assistant-1', 100);
  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: null,
    durableThrough: 0,
    durableUpserts: [{ sequence: 0, message: assistantMessage('complete') }],  })) store.accept(batch);

  assert.equal(await waiting, true);
});

test('the window does not change while an answer is still being assembled', () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 1, durable: [{ sequence: 1, message: assistantMessage('first') }],
    overlay: [], hasOlder: false, hasNewer: false,
  })) store.accept(batch);
  const installed = store.snapshot();

  const change = [...encodeDesktopTranscriptChange(identity, {
    coversFrom: 1, durableThrough: 2,
    durableUpserts: [{
      sequence: 2,
      message: assistantMessage('x'.repeat(300 * 1024), 'assistant-2'),
    }],
  })];
  assert.ok(change.length > 1, 'the answer has to span more than one batch');
  for (const batch of change.slice(0, -1)) assert.equal(store.accept(batch), false);
  assert.strictEqual(store.snapshot(), installed, 'the screen is never a half-installed answer');

  assert.equal(store.accept(change.at(-1)!), true);
  assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [1, 2]);
});

for (const coversFrom of [7, undefined]) {
  test(`tail rows a window cannot join are dropped, and its ${coversFrom === undefined ? 'uncovered' : 'mismatched'} watermark still moves`, () => {
    const store = transcriptStore();
    const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
    for (const batch of encodeDesktopTranscriptSnapshot({
      ...identity, durableThrough: 1, durable: [{ sequence: 1, message: assistantMessage('first') }],
      overlay: [], hasOlder: false, hasNewer: false,
    })) store.accept(batch);
    assert.equal(store.range().hasNewer, false);

    for (const batch of encodeDesktopTranscriptChange(identity, {
      coversFrom, durableThrough: 9,
      durableUpserts: [{ sequence: 9, message: assistantMessage('stranded', 'assistant-9') }],
    })) store.accept(batch);

    assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [1],
      'nothing proves 9 adjacent to what the window holds');
    assert.equal(store.range().durableThrough, 9);
    assert.equal(store.range().hasNewer, true, 'so the window knows to read forward itself');
  });
}

test('a reset the reader has navigated past moves the watermark and nothing else', () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 1, durable: [{ sequence: 1, message: assistantMessage('first') }],
    overlay: [], hasOlder: false, hasNewer: false,
  })) store.accept(batch);

  const answer = [...encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 6,
    durable: [
      { sequence: 5, message: assistantMessage('x'.repeat(300 * 1024), 'assistant-5') },
      { sequence: 6, message: assistantMessage('jumped', 'assistant-6') },
    ],
    overlay: [], hasOlder: true, hasNewer: false,
  }, store.navigate())];
  assert.ok(answer.length > 1);
  store.accept(answer[0]!);
  // The reader asked to be somewhere else before the first answer finished.
  store.navigate();
  for (const batch of answer.slice(1)) store.accept(batch);

  assert.deepEqual(store.durableEntries().map(({ sequence }) => sequence), [1]);
  assert.equal(store.range().durableThrough, 6);
  assert.equal(store.pendingNavigation(), 2, 'the jump the reader is waiting for still stands');
});

test('a fill is issued once per window and again as soon as the window moves', async () => {
  const store = transcriptStore();
  let reads = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
    readThroughMessageId: null,
    async acknowledgeTail() {},
    async loadBefore() { reads += 1; },
    async loadAfter() {}, async loadAround() {}, async loadLatest() {}, async close() {},
  }));
  for (const batch of encodeDesktopTranscriptSnapshot({
    sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1',
    durableThrough: 2, hasOlder: true, hasNewer: false, overlay: [],
    durable: [
      { sequence: 1, message: assistantMessage('first') },
      { sequence: 2, message: assistantMessage('second', 'assistant-2') },
    ],
  })) store.accept(batch);

  assert.equal(await controller.loadBefore(), true);
  assert.equal(await controller.loadBefore(), false, 'the same window answers the same way');
  assert.equal(reads, 1);

  assert.equal(store.retain(2, 2), true);
  assert.equal(await controller.loadBefore(), true);
  assert.equal(reads, 2);
  await controller.close();
});

test('reports each tail the window reaches once, and none while it is parked', async () => {
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  const store = transcriptStore();
  const acknowledged: number[] = [];
  // The visible reader path: only a controller that acknowledges reports a tail.
  const controller = createRecoveringDesktopTranscriptRangeController(store, async () => ({
    ...identity, readThroughMessageId: null,
    async acknowledgeTail(through) { acknowledged.push(through); },
    async loadBefore() {}, async loadAfter() {}, async loadAround() {},
    async loadLatest() {}, async close() {},
  }), { onError() {} });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  // Opening a Session at the tail: the read marker still moves on open.
  for (const batch of encodeDesktopTranscriptSnapshot({
    ...identity, durableThrough: 1, hasOlder: true, hasNewer: false, overlay: [],
    durable: [{ sequence: 1, message: assistantMessage('first') }],
  })) store.accept(batch);
  await settle();
  assert.deepEqual(acknowledged, [1]);

  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 1, durableThrough: 2,
    durableUpserts: [{ sequence: 2, message: assistantMessage('second', 'assistant-2') }],
  })) store.accept(batch);
  await settle();
  assert.deepEqual(acknowledged, [1, 2], 'a window that joined the tail reports it once');

  // A trim reopens the newer edge, so the next change cannot join the window.
  assert.equal(store.retain(1, 1), true);
  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 2, durableThrough: 3,
    durableUpserts: [{ sequence: 3, message: assistantMessage('third', 'assistant-3') }],
  })) store.accept(batch);
  await settle();
  assert.deepEqual(acknowledged, [1, 2], 'a parked window reports no tail');
  await controller.close();
});

test('cancels a transcript open that is still waiting for a Host', async () => {
  const store = transcriptStore();
  let openSignal: AbortSignal | undefined;
  const controller = createDesktopTranscriptRangeController(
    store,
    (signal) =>
      new Promise((_resolve, reject) => {
        openSignal = signal;
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
  );

  await controller.close();
  assert.equal(openSignal?.aborted, true);
});

function assistantMessage(
  text: string,
  id = 'assistant-1',
): Extract<StoredMessage, { type: 'assistant' }> {
  return {
    type: 'assistant',
    id,
    turnId: 'turn-1',
    ts: 1,
    text,
    modelId: 'model-1',
  };
}

function transcriptStore(): DesktopTranscriptRangeStore {
  return new DesktopTranscriptRangeStore(JSON.stringify(['host-1', 'session-1']));
}

function userMessage(
  text: string,
  id: string,
): Extract<StoredMessage, { type: 'user' }> {
  return {
    type: 'user',
    id,
    turnId: id.replace('user-', 'turn-'),
    ts: 1,
    text,
  };
}

function transcriptPage(
  direction: 'older' | 'newer',
  nextCursor: string | null,
  throughSequence: number,
) {
  return {
    kind: 'page' as const,
    sessionId: 'session-1',
    source: 'durable' as const,
    direction,
    throughSequence,
    rawBytes: 1,
    fragments: [],
    rangeBoundarySequence: null,
    protectedTurnSequence: null,
    nextCursor,
  };
}

function syntheticLargeTranscript(): Array<{ identity: number; message: StoredMessage }> {
  return Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    const turnId = `turn-${number}`;
    return [
      {
        identity: index * 2,
        message: {
          ...userMessage(`Prompt ${number}`, `user-${number}`),
          turnId,
        },
      },
      {
        identity: index * 2 + 1,
        message: {
          ...assistantMessage('x'.repeat(180 * 1024), `assistant-${number}`),
          turnId,
        },
      },
    ];
  }).flat();
}

function continuitySnapshot() {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running' as const,
      createdAt: 1,
      isArchived: false,
    },
    projectionRevision: 1,
    rootTurn: null,
    goal: null,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
  };
}

test('cached fallback remains readable and retries once per observation generation until live', async () => {
  const store = transcriptStore();
  const errors: unknown[] = [];
  let opens = 0;
  let online = false;
  const controller = createRecoveringDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    const identity = {
      sessionId: 'session-1',
      generation: online ? 'live-generation' : 'cached:generation',
      hostEpoch: 'host-1',
    };
    for (const batch of encodeDesktopTranscriptSnapshot({
      ...identity, durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(online ? 'live' : 'cached') }],
      overlay: [], hasOlder: false, hasNewer: false,
    })) store.accept(batch);
    return {
      ...identity, readThroughMessageId: null,
      acknowledgeTail: async () => {},
      loadBefore: async () => {}, loadAfter: async () => {}, loadAround: async () => {},
      loadLatest: async () => {}, close: async () => {},
    };
  }, { onError: (error) => errors.push(error) });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await controller.ready();
  await settle();
  assert.equal(opens, 1);
  assert.equal(store.range().generation, 'cached:generation');
  controller.observationChanged('ready');
  await settle();
  assert.equal(opens, 2);
  controller.observationChanged('ready');
  await settle();
  assert.equal(opens, 2);
  online = true;
  controller.observationChanged('pending');
  controller.observationChanged('ready');
  await settle();
  assert.equal(opens, 3);
  assert.equal(store.range().generation, 'live-generation');
  assert.deepEqual(errors, []);
  await controller.close();
});

test('a read refused for a Host epoch that moved is superseded, not failed', async () => {
  const store = transcriptStore();
  const errors: unknown[] = [];
  let opens = 0;
  const otherFailure = new Error('the older page failed');
  const controller = createRecoveringDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    const identity = { sessionId: 'session-1', generation: 'live-generation', hostEpoch: 'host-1' };
    for (const batch of encodeDesktopTranscriptSnapshot({
      ...identity, durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage('live') }],
      overlay: [], hasOlder: true, hasNewer: false,
    })) store.accept(batch);
    return {
      ...identity, readThroughMessageId: null,
      acknowledgeTail: async () => {},
      loadBefore: async () => { throw otherFailure; },
      loadAfter: async () => {},
      loadAround: async () => {
        throw new Error(`Error invoking remote method 'sessions:transcript:load-around': Error: ${DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE}: Desktop transcript host epoch changed; reopen the transcript`);
      },
      loadLatest: async () => {}, close: async () => {},
    };
  }, { onError: (error) => errors.push(error) });
  try {
    await controller.ready();
    await assert.rejects(controller.loadAround(1), TranscriptReadSupersededError);
    await assert.rejects(controller.loadBefore(), (error) => error === otherFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, [], 'a superseded read must not reach the error surface');
    assert.equal(opens, 1, 'the replacement reset carries the new epoch, so nothing is reopened');
  } finally {
    await controller.close();
  }
});

test('live transcript open failures without cache still report the original error', async () => {
  const failure = new Error('no Host and no cache');
  const errors: unknown[] = [];
  const controller = createRecoveringDesktopTranscriptRangeController(
    transcriptStore(), async () => { throw failure; },
    { onError: (error) => errors.push(error) },
  );
  await assert.rejects(controller.ready(), /no Host and no cache/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
  await controller.close();
});
