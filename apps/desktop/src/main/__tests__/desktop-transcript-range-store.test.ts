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
import { deferred, waitFor } from '@maka/core/test-only/async-primitives';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import {
  encodeDesktopTranscriptBatches,
  encodeDesktopTranscriptChange,
  encodeDesktopTranscriptSnapshot,
  type TranscriptBatchIdentity,
} from '../desktop-transcript-ipc.js';
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS,
  type DesktopTranscriptHandle,
} from '../../preload/transcript-contract.js';
import {
  createDesktopTranscriptReconnectRecovery,
  createDesktopTranscriptRangeController,
  DesktopTranscriptRangeStore,
} from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
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

test('reads one Host-owned Turn outside the bounded transcript tail', async () => {
  const sessionKey = JSON.stringify(['host-1', 'session-1']);
  const turnB: StoredMessage[] = [
    userMessage('follow-up one', 'user-b'),
    { ...assistantMessage('answer B', 'assistant-b'), turnId: 'turn-b', ts: 4 },
    { type: 'turn_state', id: 'complete-b', turnId: 'turn-b', ts: 5, status: 'completed' },
  ];
  const turnC: StoredMessage[] = [
    userMessage('follow-up two', 'user-c'),
    { ...assistantMessage('answer C', 'assistant-c'), turnId: 'turn-c', ts: 7 },
    { type: 'turn_state', id: 'complete-c', turnId: 'turn-c', ts: 8, status: 'completed' },
  ];
  const turnReads: string[] = [];
  let deliverySequence = 0;

  const result = await readSettledMessagesFrom(
    {
      transcripts: {
        async readTurn(sessionId, turnId) {
          assert.equal(sessionId, sessionKey);
          turnReads.push(turnId);
          return turnB;
        },
        open: async (_sessionId, handler, _registerCancellation, mode) => {
          assert.equal(mode, 'tail');
          for (const batch of encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: true,
            sessionId: 'session-1',
            generation: 'generation-1',
            hostEpoch: 'host-1',
            durableThrough: 8,
            durable: turnC.map((message, index) => ({ sequence: index + 6, message })),
            hasOlder: true,
          })) handler({ ...batch, deliverySequence: ++deliverySequence });
          return transcriptHandle(
            { sessionId: sessionKey, generation: 'generation-1', hostEpoch: 'host-1' },
            {
              readThroughMessageId: 'complete-c',
              async acknowledgeTail() { assert.fail('A recovery read must not mark the Session read'); },
            },
          );
        },
      },
    },
    sessionKey,
    { requiredTurnId: 'turn-b' },
  );

  assert.deepEqual(turnReads, ['turn-b']);
  assert.deepEqual(result, { messages: [...turnB, ...turnC], settled: true });
});

/**
 * A byte-bounded tail can start inside the required Turn: its terminal row is
 * there and its earlier rows are not. A terminal row is evidence about
 * execution, not about how much of the Turn came back, so settling on it alone
 * returns a Turn with a hole in it.
 */
test('reads the required Turn when the tail begins inside it', async () => {
  const sessionKey = JSON.stringify(['host-1', 'session-1']);
  const whole: StoredMessage[] = [
    userMessage('the question', 'user-b'),
    { ...assistantMessage('the intermediate step', 'assistant-b-step'), turnId: 'turn-b', ts: 4 },
    { ...assistantMessage('the final answer', 'assistant-b'), turnId: 'turn-b', ts: 5 },
    { type: 'turn_state', id: 'complete-b', turnId: 'turn-b', ts: 6, status: 'completed' },
  ];
  // What a 16 KiB bootstrap has room for once the final answer is large.
  const tail = whole.slice(2);
  const turnReads: string[] = [];
  let deliverySequence = 0;

  const result = await readSettledMessagesFrom(
    {
      transcripts: {
        async readTurn(_sessionId, turnId) {
          turnReads.push(turnId);
          return whole;
        },
        open: async (_sessionId, handler) => {
          for (const batch of encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: true,
            sessionId: 'session-1',
            generation: 'generation-1',
            hostEpoch: 'host-1',
            durableThrough: 8,
            durable: tail.map((message, index) => ({ sequence: index + 7, message })),
            hasOlder: true,
          })) handler({ ...batch, deliverySequence: ++deliverySequence });
          return transcriptHandle(
            { sessionId: sessionKey, generation: 'generation-1', hostEpoch: 'host-1' },
            { readThroughMessageId: 'complete-b' },
          );
        },
      },
    },
    sessionKey,
    { requiredTurnId: 'turn-b' },
  );

  assert.deepEqual(turnReads, ['turn-b'], 'the terminal row was taken as proof the Turn was whole');
  assert.deepEqual(result.messages, whole);
});

/**
 * Side Chat reseeding asks for the Session, not for a Turn — it has no way to
 * know which Turn a byte-bounded tail stopped inside. The tail says, so the
 * caller does not have to remember to ask.
 */
test('reads the Turn the tail begins inside when the caller names none', async () => {
  const sessionKey = JSON.stringify(['host-1', 'session-1']);
  const whole: StoredMessage[] = [
    userMessage('the question', 'user-b'),
    { ...assistantMessage('the intermediate step', 'assistant-b-step'), turnId: 'turn-b', ts: 4 },
    { ...assistantMessage('the final answer', 'assistant-b'), turnId: 'turn-b', ts: 5 },
    { type: 'turn_state', id: 'complete-b', turnId: 'turn-b', ts: 6, status: 'completed' },
  ];
  const tail = whole.slice(2);
  const turnReads: string[] = [];
  let deliverySequence = 0;

  const result = await readSettledMessagesFrom(
    {
      transcripts: {
        async readTurn(_sessionId, turnId) {
          turnReads.push(turnId);
          return whole;
        },
        open: async (_sessionId, handler) => {
          for (const batch of encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: false,
            sessionId: 'session-1',
            generation: 'generation-1',
            hostEpoch: 'host-1',
            durableThrough: 8,
            durable: tail.map((message, index) => ({ sequence: index + 7, message })),
            hasOlder: true,
          })) handler({ ...batch, deliverySequence: ++deliverySequence });
          return transcriptHandle(
            { sessionId: sessionKey, generation: 'generation-1', hostEpoch: 'host-1' },
            { readThroughMessageId: 'complete-b' },
          );
        },
      },
    },
    sessionKey,
  );

  assert.deepEqual(turnReads, ['turn-b']);
  assert.deepEqual(result, { messages: whole, settled: true });
});

test('settles on a tail that begins between two Turns without reading one', async () => {
  const sessionKey = JSON.stringify(['host-1', 'session-1']);
  const tail: StoredMessage[] = [
    userMessage('the question', 'user-b'),
    { ...assistantMessage('the answer', 'assistant-b'), turnId: 'turn-b', ts: 4 },
    { type: 'turn_state', id: 'complete-b', turnId: 'turn-b', ts: 5, status: 'completed' },
  ];
  let deliverySequence = 0;

  const result = await readSettledMessagesFrom(
    {
      transcripts: {
        async readTurn() { assert.fail('a whole tail needs no Turn read'); },
        open: async (_sessionId, handler) => {
          for (const batch of encodeDesktopTranscriptSnapshot({
            beginsAtTurnBoundary: true,
            sessionId: 'session-1',
            generation: 'generation-1',
            hostEpoch: 'host-1',
            durableThrough: 8,
            durable: tail.map((message, index) => ({ sequence: index + 6, message })),
            hasOlder: true,
          })) handler({ ...batch, deliverySequence: ++deliverySequence });
          return transcriptHandle(
            { sessionId: sessionKey, generation: 'generation-1', hostEpoch: 'host-1' },
            { readThroughMessageId: 'complete-b' },
          );
        },
      },
    },
    sessionKey,
  );

  assert.deepEqual(result, { messages: tail, settled: true });
});

for (const failure of ['is empty', 'fails'] as const) {
  test(`does not settle when the targeted Host-owned Turn read ${failure}`, async () => {
    const sessionKey = JSON.stringify(['host-1', 'session-1']);
    const tail: StoredMessage[] = [
      { ...assistantMessage('answer C', 'assistant-c'), turnId: 'turn-c', ts: 7 },
      { type: 'turn_state', id: 'complete-c', turnId: 'turn-c', ts: 8, status: 'completed' },
    ];
    let deliverySequence = 0;

    const result = await readSettledMessagesFrom(
      {
        transcripts: {
          async readTurn() {
            if (failure === 'fails') throw new Error('Turn read failed');
            return [];
          },
          open: async (_sessionId, handler) => {
            for (const batch of encodeDesktopTranscriptSnapshot({
              beginsAtTurnBoundary: true,
              sessionId: 'session-1',
              generation: 'generation-1',
              hostEpoch: 'host-1',
              durableThrough: 8,
              durable: tail.map((message, index) => ({ sequence: index + 7, message })),
              hasOlder: true,
            })) handler({ ...batch, deliverySequence: ++deliverySequence });
            return transcriptHandle(
              { sessionId: sessionKey, generation: 'generation-1', hostEpoch: 'host-1' },
              { readThroughMessageId: 'complete-c' },
            );
          },
        },
      },
      sessionKey,
      { requiredTurnId: 'missing-turn' },
    );

    assert.deepEqual(result, { messages: tail, settled: false });
  });
}

test('assembles a fragmented durable record once and ignores its replay', () => {
  const message = assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES * 2));
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...identity,
    durableThrough: null,
    durable: [],
    hasOlder: false,
  })) store.accept(batch);

  const change = [...encodeDesktopTranscriptChange(identity, {
    coversFrom: null,
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message }],
  })];
  assert.ok(change.length > 1);
  for (const [index, batch] of change.entries()) {
    assert.ok(
      batch.fragments.reduce(
        (total, fragment) => total + fragment.data.byteLength,
        0,
      ) <= DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
    );
    assert.equal(store.accept(batch), index === change.length - 1);
  }
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal(store.hasDurableMessage(message.id), true);

  for (const batch of change) store.accept(batch);
  assert.deepEqual(store.snapshot().messages, [message]);
});

test('drops stale transcript batches after a generation reset', () => {
  const store = transcriptStore();
  const oldBatches = [...encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    sessionId: 'session-1',
    generation: 'old',
    hostEpoch: 'host-1',
    durableThrough: 1,
    durable: [{ sequence: 1, message: assistantMessage('old') }],
    hasOlder: false,
  })];
  const nextMessage = assistantMessage('new');
  const nextBatches = [...encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    sessionId: 'session-1',
    generation: 'next',
    hostEpoch: 'host-2',
    durableThrough: 2,
    durable: [{ sequence: 2, message: nextMessage }],
    hasOlder: true,
  })];

  for (const batch of oldBatches) store.accept(batch);
  for (const batch of nextBatches) store.accept(batch);
  const staleChange = [...encodeDesktopTranscriptChange(
    { sessionId: 'session-1', generation: 'old', hostEpoch: 'host-1' },
    {
      coversFrom: 2,
      durableThrough: 3,
      durableUpserts: [{ sequence: 3, message: assistantMessage('stale') }],
    },
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
  const errors: unknown[] = [];
  const deliveries: Array<{ generation: string; accepted: boolean }> = [];
  const publish = (generation: string, text: string) => {
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity, generation, durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(text) }],
      hasOlder: false,
    })) deliveries.push({ generation, accepted: store.accept(batch) });
  };
  const controller = createDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    if (opens > 1) {
      publish(`cached:reload-${opens}`, 'cached');
      assert.deepEqual(store.snapshot().messages, [assistantMessage('cached')]);
    }
    // The event subscription keeps the main-process replica alive between opens.
    publish(identity.generation, `live-${opens}`);
    return transcriptHandle(identity);
  }, { onError: (error) => errors.push(error) });

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
      durableUpserts: [{ sequence: 2, message: updated }],
    })) assert.equal(store.accept(batch), true);
    assert.deepEqual(store.snapshot().messages, [assistantMessage('live-3'), updated]);
    assert.deepEqual(errors, []);
  } finally {
    await controller.close();
  }
});

test('a replacement live generation retires the previous replica through cached snapshots', () => {
  for (const cachedGenerations of [[], ['cached:first', 'cached:second']]) {
    const store = transcriptStore();
    const snapshot = (generation: string) => [...encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      sessionId: 'session-1', generation, hostEpoch: 'host-1', durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(generation) }],
      hasOlder: false,
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
        durableUpserts: [{ sequence: 2, message: assistantMessage('stale', 'stale') }],
      })) assert.equal(store.accept(batch), false);
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
    beginsAtTurnBoundary: true,
    ...identity,
    durableThrough: 1,
    durable: [{ sequence: 1, message: firstMessage }],
    hasOlder: false,
  })) store.accept(batch);

  const first = store.snapshot();
  assert.strictEqual(store.snapshot(), first);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.messages));
  assert.ok(Object.isFrozen(first.messages[0]));

  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 1,
    durableThrough: 2,
    durableUpserts: [{ sequence: 2, message: secondMessage }],
  })) store.accept(batch);

  const second = store.snapshot();
  assert.notStrictEqual(second, first);
  assert.strictEqual(second.messages[0], first.messages[0]);
  assert.deepEqual(second.messages, [firstMessage, secondMessage]);
});

test('a reset spanning several batches publishes once, when it is ready', () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...identity, durableThrough: 1, durable: [{ sequence: 1, message: assistantMessage('old') }],
    hasOlder: false,
  })) store.accept(batch);
  const installed = store.snapshot();
  let commits = 0;
  store.subscribe(() => { commits += 1; });

  const next = { ...identity, generation: 'generation-2' };
  const newest = assistantMessage('x'.repeat(300 * 1024), 'assistant-3');
  const older = assistantMessage('older', 'assistant-2');
  const running = assistantMessage('streaming', 'assistant-4');
  const batches = [
    ...encodeDesktopTranscriptBatches(next, {
      durableThrough: 4, durable: [{ sequence: 4, message: running }, { sequence: 3, message: newest }],
      hasOlder: true, reset: true, ready: false,
    }),
    ...encodeDesktopTranscriptBatches(next, {
      durableThrough: 4, durable: [{ sequence: 2, message: older }],
      hasOlder: false, reset: false, ready: true,
    }),
  ];
  assert.ok(batches.length > 2, 'the reset has to span several batches');
  for (const batch of batches.slice(0, -1)) {
    assert.equal(store.accept(batch), false);
    assert.strictEqual(store.snapshot(), installed);
  }
  assert.equal(commits, 0);

  assert.equal(store.accept(batches.at(-1)!), true);
  assert.equal(commits, 1);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['assistant-2', 'assistant-3', 'assistant-4']);
  assert.equal(store.range().generation, 'generation-2');
  assert.equal(store.range().hasOlder, false);
});

test('earlier history installs only below the oldest row it was read for', () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...identity, durableThrough: 6, hasOlder: true,
    durable: [5, 6].map((sequence) => ({ sequence, message: assistantMessage(`${sequence}`, `assistant-${sequence}`) })),
  })) store.accept(batch);
  const ids = () => store.snapshot().messages.map(({ id }) => id);

  for (const batch of earlierBatches(identity, 6, [4], false)) assert.equal(store.accept(batch), false);
  assert.deepEqual(ids(), ['assistant-5', 'assistant-6']);

  for (const batch of earlierBatches(identity, 5, [3, 4], true)) assert.equal(store.accept(batch), true);
  assert.deepEqual(ids(), ['assistant-3', 'assistant-4', 'assistant-5', 'assistant-6']);
  assert.equal(store.range().hasOlder, true);
  assert.equal(store.range().durableThrough, 6);

  for (const batch of earlierBatches(identity, 5, [2], false)) assert.equal(store.accept(batch), false);
  assert.deepEqual(ids(), ['assistant-3', 'assistant-4', 'assistant-5', 'assistant-6']);
  assert.equal(store.range().hasOlder, true);
  assert.equal(store.needsReload(), false);

  for (const batch of earlierBatches(identity, 3, [2], false)) assert.equal(store.accept(batch), true);
  assert.deepEqual(ids(), ['assistant-2', 'assistant-3', 'assistant-4', 'assistant-5', 'assistant-6']);
  assert.equal(store.range().hasOlder, false);
});

test('a tail change that does not continue the held rows reopens the transcript', async () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  const row = (sequence: number) => ({ sequence, message: assistantMessage(`${sequence}`, `assistant-${sequence}`) });
  const errors: unknown[] = [];
  let opens = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    const durable = opens === 1 ? [row(1)] : [row(1), row(2), row(9)];
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity, durableThrough: durable.at(-1)!.sequence, durable, hasOlder: false,
    })) store.accept(batch);
    return transcriptHandle(identity);
  }, { onError: (error) => errors.push(error) });
  const ids = () => store.snapshot().messages.map(({ id }) => id);
  try {
    await controller.ready();

    for (const batch of encodeDesktopTranscriptChange(identity, {
      coversFrom: 1, durableThrough: 2, durableUpserts: [row(2)],
    })) assert.equal(store.accept(batch), true);
    assert.deepEqual(ids(), ['assistant-1', 'assistant-2']);
    assert.equal(store.range().durableThrough, 2);
    assert.equal(store.needsReload(), false);

    for (const batch of encodeDesktopTranscriptChange(identity, {
      coversFrom: 7, durableThrough: 9, durableUpserts: [row(9)],
    })) store.accept(batch);
    assert.deepEqual(ids(), ['assistant-1', 'assistant-2'], 'nothing proves 9 adjacent to what is held');
    assert.equal(store.range().durableThrough, 2);
    assert.equal(store.needsReload(), true);

    await waitFor(() => opens === 2 && !store.needsReload(), { timeoutMs: 5_000 });
    assert.deepEqual(ids(), ['assistant-1', 'assistant-2', 'assistant-9']);
    assert.equal(store.range().durableThrough, 9);
    assert.deepEqual(errors, []);
  } finally {
    await controller.close();
  }
});

test('loadEarlier shares one in-flight read and reports its failure', async () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  const failure = new Error('earlier read failed');
  const gate = deferred<void>();
  const errors: unknown[] = [];
  let reads = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity, durableThrough: 5, hasOlder: true,
      durable: [{ sequence: 5, message: assistantMessage('5', 'assistant-5') }],
    })) store.accept(batch);
    return transcriptHandle(identity, {
      async loadEarlier() {
        reads += 1;
        await gate.promise;
        throw failure;
      },
    });
  }, { onError: (error) => errors.push(error) });
  try {
    await controller.ready();
    const first = controller.loadEarlier();
    assert.strictEqual(controller.loadEarlier(), first);
    gate.resolve();
    await first;
    assert.equal(reads, 1);
    assert.deepEqual(errors, [failure]);

    await controller.loadEarlier();
    assert.equal(reads, 2, 'a settled read does not block the next one');

    for (const batch of earlierBatches(identity, 5, [4], false)) store.accept(batch);
    await controller.loadEarlier();
    assert.equal(reads, 2, 'nothing is read once no earlier history remains');
  } finally {
    await controller.close();
  }
});

test('a read down to a sequence waits out a pending read, skips held history, and a reopen resumes from the oldest held row', async () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  const gate = deferred<void>();
  const reads: (number | undefined)[] = [];
  const resumes: (number | undefined)[] = [];
  const controller = createDesktopTranscriptRangeController(store, async (_signal, resumeFrom) => {
    resumes.push(resumeFrom);
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity, durableThrough: 9, hasOlder: true,
      durable: [{ sequence: 9, message: assistantMessage('9', 'assistant-9') }],
    })) store.accept(batch);
    return transcriptHandle(identity, {
      async loadEarlier(throughSequence) {
        reads.push(throughSequence);
        if (throughSequence === undefined) {
          await gate.promise;
          for (const batch of earlierBatches(identity, 9, [7], true)) store.accept(batch);
        } else {
          for (const batch of earlierBatches(identity, 7, [3, 5], true)) store.accept(batch);
        }
      },
    });
  }, { onError: (error) => assert.fail(String(error)) });
  try {
    await controller.ready();
    const pending = controller.loadEarlier();
    const targeted = controller.loadEarlier(3);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(reads, [undefined]);
    gate.resolve();
    await Promise.all([pending, targeted]);
    assert.deepEqual(reads, [undefined, 3]);
    assert.equal(store.range().oldestSequence, 3);

    await controller.loadEarlier(5);
    assert.deepEqual(reads, [undefined, 3], 'a Turn already held is not read again');

    await controller.reload();
    assert.deepEqual(resumes, [undefined, 3]);
  } finally {
    await controller.close();
  }
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
    transcriptBootstrap: { durable: bootstrapPage },
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
});

test('bounds the default active transcript range by presentation bytes', async () => {
  const messages = syntheticLargeTranscript();
  const bootstrapPage = transcriptPage('older', null, messages.length - 1);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async () => ({ messages, nextCursor: null }),
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle);

  const snapshot = replica.snapshot();
  const bytes = snapshot.durable.reduce(
    (total, { message }) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
    0,
  );
  assert.ok(bytes <= DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES);
  assert.deepEqual(snapshot.durable.map(({ sequence }) => sequence), [12, 13, 14, 15]);
  assert.equal(snapshot.hasOlder, true);
});

test('keeps an oversized latest Turn visible after bootstrap eviction', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-0'), turnId: 'turn-0' },
  };
  const latest = {
    identity: 1,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + 1), 'assistant-1'),
  };
  const bootstrapPage = transcriptPage('older', null, latest.identity);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async () => ({ messages: [older, latest], nextCursor: null }),
    async close() {},
  });

  const replica = await DesktopTranscriptReplica.prepare(handle);

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [latest.identity]);
  assert.equal(replica.snapshot().hasOlder, true);
  // Eviction drops rows by their owner, which is not where a Turn ends when
  // another Turn's rows are written between them.
  assert.equal(replica.snapshot().beginsAtTurnBoundary, false);
});

test('keeps an oversized latest Turn visible before a trailing session note', async () => {
  const latest = {
    identity: 0,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + 1), 'assistant-0'),
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
  const bootstrapPage = transcriptPage('older', null, trailingNote.identity);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
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
    transcriptBootstrap: { durable: bootstrapPage },
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

test('keeps an oversized Turn visible when the watermark advances onto it', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-0'), turnId: 'turn-0' },
  };
  const latest = {
    identity: 1,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + 1), 'assistant-1'),
  };
  const bootstrapPage = transcriptPage('older', null, older.identity);
  const newerPage = transcriptPage('newer', null, latest.identity);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: [older], nextCursor: null }
      : { messages: [latest], nextCursor: null },
    loadTranscriptPage: async () => newerPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await replica.advance(latest.identity);

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [latest.identity]);
});

test('keeps an oversized settled Turn visible before a trailing session note', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-0'), turnId: 'turn-0' },
  };
  const latest = {
    identity: 1,
    message: assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + 1), 'assistant-1'),
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
  const newerPage = transcriptPage('newer', null, trailingNote.identity);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: [older], nextCursor: null }
      : { messages: [latest, trailingNote], nextCursor: null },
    loadTranscriptPage: async () => newerPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await replica.advance(trailingNote.identity);

  assert.ok(replica.snapshot().durable.some(({ sequence }) => sequence === latest.identity));
});

test('does not resurrect a discarded replica when a history page read is in flight', async () => {
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const bootstrapPage = transcriptPage('older', 'older', 4);
  const olderPage = transcriptPage('older', null, 4);
  const pageGate = deferred<void>();
  const pageEntered = deferred<void>();
  const changes: DesktopTranscriptReplicaChange[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
      ? { messages: messages.slice(4), nextCursor: 'older' }
      : { messages: messages.slice(2, 4), nextCursor: null },
    loadTranscriptPage: async () => {
      pageEntered.resolve();
      await pageGate.promise;
      return olderPage;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1024 * 1024,
    onChange: (_replica, change) => changes.push(change),
  });

  const reading = replica.readOlderPage(4, 'older');
  await pageEntered.promise;
  replica.discard();
  pageGate.resolve();
  await assert.rejects(reading, /evicted/);

  assert.equal(changes.length, 0, 'a discarded replica must not publish an in-flight history page');
  assert.equal(replica.resident, false);
  assert.equal(replica.residentBytes, 0);
});

test('does not drive a discarded replica terminal when a contiguous catch-up is in flight', async () => {
  // Another observed Session's LRU `discard()` reclaims this replica while a
  // newer page is pending. A discarded replica has no watermark to meet, so
  // catch-up must return cleanly rather than reject with `correlation_changed`.
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const appended = { identity: 5, message: assistantMessage('5', 'assistant-5') };
  const bootstrapPage = transcriptPage('newer', null, 4);
  const newerPage = transcriptPage('newer', null, 5);
  const newerGate = deferred<void>();
  const newerEntered = deferred<void>();
  const changes: DesktopTranscriptReplicaChange[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
      ? { messages, nextCursor: null }
      : { messages: [appended], nextCursor: null },
    loadTranscriptPage: async () => {
      newerEntered.resolve();
      await newerGate.promise;
      return newerPage;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1024 * 1024,
    onChange: (_replica, change) => changes.push(change),
  });

  const advancing = replica.advance(5);
  await newerEntered.promise;
  replica.discard();
  assert.equal(replica.resident, false);
  newerGate.resolve();
  await advancing;

  const upserts = changes.flatMap((change) => change.durableUpserts.map(({ sequence }) => sequence));
  assert.ok(!upserts.includes(5), 'a discarded replica must not be repopulated by an in-flight catch-up');
  assert.equal(replica.resident, false);
  assert.equal(replica.residentBytes, 0);
});

test('a transcript opened between catch-up pages can join the change that follows', async () => {
  const bootstrap = [0, 1, 2].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const firstPage = [3, 4, 5].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const secondPage = [{ identity: 6, message: assistantMessage('6', 'assistant-6') }];
  const bootstrapPage = transcriptPage('newer', null, 2);
  const first = transcriptPage('newer', 'more', 6);
  const second = transcriptPage('newer', null, 6);
  const secondGate = deferred<void>();
  const secondEntered = deferred<void>();
  const changes: DesktopTranscriptReplicaChange[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async (candidate) => candidate === bootstrapPage
      ? { messages: bootstrap, nextCursor: null }
      : candidate === first
        ? { messages: firstPage, nextCursor: 'more' }
        : { messages: secondPage, nextCursor: null },
    loadTranscriptPage: async (request) => {
      if (request.cursor === null) return first;
      secondEntered.resolve();
      await secondGate.promise;
      return second;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1024 * 1024,
    onChange: (_replica, change) => changes.push(change),
  });

  const advancing = replica.advance(6);
  await secondEntered.promise;
  // The first page is installed; the second is pending. A transcript opening
  // now must be told the watermark its rows actually reach.
  const opened = replica.snapshot();
  assert.deepEqual(opened.durable.map(({ sequence }) => sequence), [0, 1, 2, 3, 4, 5]);
  assert.equal(opened.durableThrough, 5);
  secondGate.resolve();
  await advancing;

  const store = transcriptStore();
  for (const batch of encodeDesktopTranscriptSnapshot(opened)) store.accept(batch);
  const identity = { sessionId: replica.sessionId, generation: replica.generation, hostEpoch: replica.hostEpoch };
  for (const change of changes.slice(1)) {
    for (const batch of encodeDesktopTranscriptChange(identity, change)) store.accept(batch);
  }
  assert.deepEqual(
    store.snapshot().messages.map(({ id }) => id),
    [0, 1, 2, 3, 4, 5, 6].map((sequence) => `assistant-${sequence}`),
  );
  assert.equal(store.needsReload(), false);
});

test('transfers prepared transcript bytes into active replica accounting', async () => {
  const message = assistantMessage('prepared', 'assistant-1');
  const messageBytes = Buffer.byteLength(JSON.stringify(message), 'utf8');
  let accountedBytes = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    decodeTranscriptPage: async (_page, _maxMessageBytes, accountAssemblyBytes) => {
      accountAssemblyBytes?.(messageBytes);
      accountAssemblyBytes?.(-messageBytes);
      return { messages: [{ identity: 0, message }], nextCursor: null };
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
  const message = assistantMessage('prepared', 'assistant-1');
  const deltas: number[] = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([message]),
    events: { async *[Symbol.asyncIterator]() {} },
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
  const identity = { sessionId: 'session-1', generation: 'reloaded', hostEpoch: 'host-2' };
  let attempts = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('open failed');
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity,
      durableThrough: null,
      durable: [],
      hasOlder: false,
    })) store.accept(batch);
    return transcriptHandle(identity);
  }, { onError() {} });

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

test('waits for the required durable message on the current transcript generation', async () => {
  const store = transcriptStore();
  const identity = {
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
  };
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...identity,
    durableThrough: null,
    durable: [],
    hasOlder: false,
  })) store.accept(batch);
  const waiting = store.waitForDurableMessage('assistant-1', 100);
  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: null,
    durableThrough: 0,
    durableUpserts: [{ sequence: 0, message: assistantMessage('complete') }],
  })) store.accept(batch);

  assert.equal(await waiting, true);
});

test('the transcript does not change while a tail change is still being assembled', () => {
  const store = transcriptStore();
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...identity, durableThrough: 1, durable: [{ sequence: 1, message: assistantMessage('first') }],
    hasOlder: false,
  })) store.accept(batch);
  const installed = store.snapshot();

  const change = [...encodeDesktopTranscriptChange(identity, {
    coversFrom: 1, durableThrough: 2,
    durableUpserts: [{
      sequence: 2,
      message: assistantMessage('x'.repeat(300 * 1024), 'assistant-2'),
    }],
  })];
  assert.ok(change.length > 1, 'the change has to span more than one batch');
  for (const batch of change.slice(0, -1)) assert.equal(store.accept(batch), false);
  assert.strictEqual(store.snapshot(), installed, 'the screen is never a half-installed change');

  assert.equal(store.accept(change.at(-1)!), true);
  assert.deepEqual(store.snapshot().messages.map(({ id }) => id), ['assistant-1', 'assistant-2']);
});

test('reports each tail watermark the reader reaches once', async () => {
  const identity = { sessionId: 'session-1', generation: 'generation-1', hostEpoch: 'host-1' };
  const store = transcriptStore();
  const acknowledged: number[] = [];
  const controller = createDesktopTranscriptRangeController(store, async () => transcriptHandle(identity, {
    async acknowledgeTail(through) { acknowledged.push(through); },
  }), { onError() {} });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  for (const batch of encodeDesktopTranscriptSnapshot({
    beginsAtTurnBoundary: true,
    ...identity, durableThrough: 1, hasOlder: true,
    durable: [{ sequence: 1, message: assistantMessage('first') }],
  })) store.accept(batch);
  await settle();
  assert.deepEqual(acknowledged, [1]);

  for (const batch of encodeDesktopTranscriptChange(identity, {
    coversFrom: 1, durableThrough: 2,
    durableUpserts: [{ sequence: 2, message: assistantMessage('second', 'assistant-2') }],
  })) store.accept(batch);
  await settle();
  assert.deepEqual(acknowledged, [1, 2]);

  for (const batch of earlierBatches(identity, 1, [0], false)) assert.equal(store.accept(batch), true);
  await settle();
  assert.deepEqual(acknowledged, [1, 2], 'earlier history moves no tail watermark');
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
    { onError() {} },
  );

  await controller.close();
  assert.equal(openSignal?.aborted, true);
});

test('cached fallback remains readable and retries once per observation generation until live', async () => {
  const store = transcriptStore();
  const errors: unknown[] = [];
  let opens = 0;
  let online = false;
  let earlierReads = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    const identity = {
      sessionId: 'session-1',
      generation: online ? 'live-generation' : 'cached:generation',
      hostEpoch: 'host-1',
    };
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity, durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(online ? 'live' : 'cached') }],
      hasOlder: true,
    })) store.accept(batch);
    return transcriptHandle(identity, { async loadEarlier() { earlierReads += 1; } });
  }, { onError: (error) => errors.push(error) });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await controller.ready();
  await settle();
  assert.equal(opens, 1);
  assert.equal(store.range().generation, 'cached:generation');
  await controller.loadEarlier();
  assert.equal(earlierReads, 0, 'a cached transcript has no Host to read earlier history from');
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

test('a reload that lands on the cached transcript recovers once the Host is back', async () => {
  const store = transcriptStore();
  let online = true;
  let opens = 0;
  const controller = createDesktopTranscriptRangeController(store, async () => {
    opens += 1;
    const identity = {
      sessionId: 'session-1',
      generation: online ? `live-${opens}` : `cached:${opens}`,
      hostEpoch: 'host-1',
    };
    for (const batch of encodeDesktopTranscriptSnapshot({
      beginsAtTurnBoundary: true,
      ...identity, durableThrough: 1,
      durable: [{ sequence: 1, message: assistantMessage(identity.generation) }],
      hasOlder: false,
    })) store.accept(batch);
    return transcriptHandle(identity);
  }, { onError: () => {} });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  await controller.ready();
  controller.observationChanged('ready');
  online = false;
  await assert.rejects(controller.reload(), /waiting for Host reconnection/);
  await settle();
  assert.match(store.range().generation, /^cached:/);
  online = true;
  controller.observationChanged('pending');
  controller.observationChanged('ready');
  await settle();
  await settle();
  assert.match(store.range().generation, /^live-/);
  assert.ok(opens >= 3);
  await controller.close();
});

test('live transcript open failures without cache still report the original error', async () => {
  const failure = new Error('no Host and no cache');
  const errors: unknown[] = [];
  const controller = createDesktopTranscriptRangeController(
    transcriptStore(), async () => { throw failure; },
    { onError: (error) => errors.push(error) },
  );
  await assert.rejects(controller.ready(), /no Host and no cache/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [failure]);
  await controller.close();
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

function transcriptHandle(
  identity: TranscriptBatchIdentity,
  overrides: Partial<DesktopTranscriptHandle> = {},
): DesktopTranscriptHandle {
  return {
    ...identity,
    readThroughMessageId: null,
    async acknowledgeTail() {},
    async loadEarlier() {},
    async close() {},
    ...overrides,
  };
}

function earlierBatches(
  identity: TranscriptBatchIdentity,
  earlierThan: number,
  sequences: readonly number[],
  hasOlder: boolean,
) {
  return encodeDesktopTranscriptBatches(identity, {
    durableThrough: null,
    durable: sequences.map((sequence) => ({
      sequence,
      message: assistantMessage(`${sequence}`, `assistant-${sequence}`),
    })),
    earlierThan,
    hasOlder,
    reset: false,
    ready: true,
  });
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
    nextCursor,
    endsAtTurnBoundary: true,
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
