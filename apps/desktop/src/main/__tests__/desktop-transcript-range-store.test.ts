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
  encodeDesktopTranscriptSnapshot,
} from '../desktop-transcript-ipc.js';
import {
  DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS,
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES,
} from '../../preload/transcript-contract.js';
import {
  createDesktopTranscriptReconnectRecovery,
  createRecoveringDesktopTranscriptRangeController,
  createDesktopTranscriptRangeController,
  DesktopTranscriptRangeStore,
} from '../../renderer/desktop-transcript-range-store.js';
import { mergeSettledMessages } from '../../renderer/settled-message-merge.js';
import { readSettledMessages } from '../../renderer/session-message-settlement.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
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
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message }],
    evictedDurableSequences: [],
    completedOverlayMessageIds: [message.id],
    hasOlder: true,
    hasNewer: false,
  })];
  for (const batch of change) store.accept(batch);
  assert.deepEqual(store.snapshot().messages, [message]);
  assert.equal(store.hasDurableMessage(message.id), true);

  for (const batch of change) assert.equal(store.accept(batch), false);
  assert.deepEqual(store.snapshot().messages, [message]);
});

test('retains the newest observed durable prompt across eviction', () => {
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
    durableThrough: 4,
    durableUpserts: [{ sequence: 4, message: assistantMessage('latest') }],
    evictedDurableSequences: [3],
    completedOverlayMessageIds: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);
  assert.equal(store.newestDurableUserSequence(), 3);
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
      durableThrough: 3,
      durableUpserts: [{ sequence: 3, message: assistantMessage('stale') }],
      evictedDurableSequences: [],
      completedOverlayMessageIds: [],
      hasOlder: false,
      hasNewer: false,
    },
  )];
  for (const batch of staleChange) assert.equal(store.accept(batch), false);
  assert.deepEqual(store.snapshot().messages, [nextMessage]);
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
    durableThrough: 2,
    durableUpserts: [{ sequence: 2, message: secondMessage }],
    evictedDurableSequences: [],
    completedOverlayMessageIds: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);

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
    DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS,
  );
  assert.equal(
    snapshot.durable[0]?.sequence,
    messages.length - DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS,
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

test('keeps an oversized latest Turn when returning from history to a trailing session note', async () => {
  const older = {
    identity: 0,
    message: { ...assistantMessage('older', 'assistant-older'), turnId: 'turn-older' },
  };
  const latest = {
    identity: 1,
    message: {
      ...assistantMessage('x'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1), 'assistant-latest'),
      turnId: 'turn-latest',
    },
  };
  const trailingNote = {
    identity: 2,
    message: {
      type: 'system_note' as const,
      id: 'mode-change-latest',
      ts: 3,
      kind: 'mode_change' as const,
    },
  };
  const bootstrapPage = {
    ...transcriptPage('older', 'older', trailingNote.identity),
    rangeBoundarySequence: latest.identity,
    protectedTurnSequence: latest.identity,
  };
  const olderPage = {
    ...transcriptPage('older', null, trailingNote.identity),
    rangeBoundarySequence: older.identity,
    protectedTurnSequence: older.identity,
  };
  const latestPage = {
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
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: [latest, trailingNote], nextCursor: 'older' }
      : page === olderPage
        ? { messages: [older], nextCursor: null }
        : { messages: [latest, trailingNote], nextCursor: null },
    loadTranscriptPage: async (input) => input.anchorSequence === latest.identity
      ? olderPage
      : latestPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await replica.loadBefore(latest.identity, 128 * 1024);
  assert.equal(replica.snapshot().hasNewer, true);

  await replica.loadAround(trailingNote.identity, 128 * 1024);

  assert.ok(replica.snapshot().durable.some(({ sequence }) => sequence === latest.identity));
});

test('keeps a bounded contiguous window while moving between history and the tail', async () => {
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: {
      ...assistantMessage(String(sequence), `assistant-${sequence}`),
      turnId: `turn-${sequence}`,
    },
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
  const olderPage = page('older');
  const latestPage = page(null);
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
      ? { messages: messages.slice(3), nextCursor: 'older' }
      : candidate === olderPage
        ? { messages: messages.slice(1, 3), nextCursor: 'older' }
        : { messages: messages.slice(4), nextCursor: null },
    loadTranscriptPage: async (input) => input.anchorSequence === 3 ? olderPage : latestPage,
    async close() {},
  });
  const maxResidentBytes = (
    Buffer.byteLength(JSON.stringify(messages[0]!.message), 'utf8')
    + Buffer.byteLength(JSON.stringify(messages[1]!.message), 'utf8')
    + 1
  );
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes,
  });

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [3, 4]);
  await replica.loadBefore(3, 128 * 1024);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [2, 3]);
  assert.equal(replica.snapshot().hasNewer, true);

  await replica.loadAround(4, 128 * 1024);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [4]);
  assert.equal(replica.snapshot().hasNewer, false);
  assert.ok(replica.residentBytes <= maxResidentBytes);
});

test('retains the reading anchor while an older page replaces the far edges', async () => {
  const messages = Array.from({ length: 8 }, (_, sequence) => ({
    identity: sequence,
    message: {
      ...assistantMessage(String(sequence), `assistant-${sequence}`),
      turnId: `turn-${sequence}`,
    },
  }));
  const bootstrapPage = transcriptPage('older', 'older', 7);
  const olderPage = transcriptPage('older', null, 7);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 7,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 7), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (page) => ({
      messages: page === bootstrapPage ? messages.slice(4) : messages.slice(0, 4),
      nextCursor: page === bootstrapPage ? 'older' : null,
    }),
    loadTranscriptPage: async () => olderPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1024 * 1024,
    maxResidentTurns: 4,
  });

  await replica.loadBefore(4, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);

  const snapshot = replica.snapshot();
  assert.deepEqual(snapshot.durable.map(({ sequence }) => sequence), [2, 3, 4, 5]);
  assert.equal(snapshot.hasOlder, true);
  assert.equal(snapshot.hasNewer, true);
});

for (const { stride, textBytes } of [1, 3].flatMap((stride) =>
  [0, 300 * 1024, 600 * 1024].map((textBytes) => ({ stride, textBytes })),
)) {
  test(`scrolls both ways through bounded stride-${stride} history with ${textBytes}-byte Turns`, async () => {
    const messages = Array.from({ length: 40 }, (_, index) => ({
      identity: index * stride,
      message: { ...assistantMessage('x'.repeat(textBytes), `assistant-${index}`), turnId: `turn-${index}` },
    }));
    const largestTurnBytes = Math.max(...messages.map(({ message }) =>
      Buffer.byteLength(JSON.stringify(message), 'utf8'),
    ));
    const maxNavigationBytes = Math.max(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES, 2 * largestTurnBytes);
    const pageTurns = textBytes === 0 ? 10 : 1;
    const through = 39 * stride;
    const pages = new Map<object, { messages: typeof messages; nextCursor: string | null }>();
    const makePage = (direction: 'older' | 'newer', anchor: number | null) => {
      const candidates = messages.filter(({ identity }) => anchor === null
        || (direction === 'older' ? identity < anchor : identity > anchor));
      const nextCursor = candidates.length > pageTurns ? 'more' : null;
      const page = transcriptPage(direction, nextCursor, through);
      pages.set(page, {
        messages: direction === 'older' ? candidates.slice(-pageTurns) : candidates.slice(0, pageTurns),
        nextCursor,
      });
      return page;
    };
    const handle = runtimeHostSessionFixture({
      snapshot: continuitySnapshot(),
      transcript: Promise.resolve([]),
      events: { async *[Symbol.asyncIterator]() {} },
      async close() {},
      transcriptBootstrap: {
        throughSequence: through,
        overlayMessageCount: 0,
        durable: makePage('older', null),
        overlay: { ...transcriptPage('older', null, through), source: 'overlay' },
      },
      loadTranscriptOverlay: async () => [],
      decodeTranscriptPage: async (page) => pages.get(page)!,
      loadTranscriptPage: async (input) => makePage(input.direction, input.anchorSequence),
    });
    const store = transcriptStore();
    const replica = await DesktopTranscriptReplica.prepare(handle, {
      generation: 'generation-1',
      onChange: (current, change) => {
        for (const batch of encodeDesktopTranscriptChange(current.snapshot(), change)) store.accept(batch);
      },
    });
    for (const batch of encodeDesktopTranscriptSnapshot(replica.snapshot())) store.accept(batch);
    const controller = createDesktopTranscriptRangeController(store, async () => ({
      sessionId: replica.sessionId, generation: replica.generation, hostEpoch: replica.hostEpoch,
      readThroughMessageId: null,
      loadBefore: (anchor, maxBytes) => replica.loadBefore(anchor, maxBytes!),
      loadAfter: (anchor, maxBytes) => replica.loadAfter(anchor, maxBytes!),
      loadAround: async () => { throw new Error('ordinary scrolling must not replace the range'); },
      close: async () => replica.close(),
    }));
    for (const direction of ['older', 'newer', 'older', 'newer'] as const) {
      let steps = 0;
      while (direction === 'older' ? store.range().hasOlder : store.range().hasNewer) {
        assert.ok(++steps <= 40, 'paging must make progress');
        const before = replica.snapshot();
        const anchor = (direction === 'older' ? before.durable[0] : before.durable.at(-1))!;
        await (direction === 'older'
          ? controller.loadBefore(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES, anchor.message.turnId)
          : controller.loadAfter(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES, anchor.message.turnId));
        const after = replica.snapshot();
        assert.ok(after.durable.some(({ sequence }) => sequence === anchor.sequence));
        assert.ok(after.durable.length <= DESKTOP_TRANSCRIPT_ACTIVE_RANGE_MAX_TURNS);
        assert.ok(replica.residentBytes <= maxNavigationBytes,
          'only the reading Turn and one adjacent Turn may exceed the soft range budget');
        assert.ok(direction === 'older'
          ? after.durable[0]!.sequence < before.durable[0]!.sequence
          : after.durable.at(-1)!.sequence > before.durable.at(-1)!.sequence,
          'every adjacent edge load must make progress');
        for (let i = 1; i < after.durable.length; i++) {
          assert.equal(after.durable[i]!.sequence - after.durable[i - 1]!.sequence, stride);
        }
      }
      assert.equal(direction === 'older' ? store.range().oldestSequence : store.range().newestSequence,
        direction === 'older' ? 0 : through);
    }
    // Global pressure may reclaim the range even after navigation used the
    // atomic-Turn exception; the protection is local to that operation.
    replica.trimDurable(128 * 1024);
    assert.ok(replica.residentBytes <= 128 * 1024);
    await controller.close();
  });
}

test('delivers a mid-session tail append even while a history window is resident', async () => {
  // Reproduces the "active session does not show the newest message until you
  // switch away and back" bug. Once the resident window has been trimmed off
  // the tail (hasNewer === true, e.g. after loading older history), a Host
  // `transcript_advanced` for a freshly persisted message must still reach an
  // already-open consumer. Before the fix, `advance()` short-circuited on
  // hasNewer and published an empty change, so the append was silently dropped
  // and only a fresh subscription (session switch) re-read it.
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: {
      ...assistantMessage(String(sequence), `assistant-${sequence}`),
      turnId: `turn-${sequence}`,
    },
  }));
  const appended = { identity: 5, message: assistantMessage('5', 'assistant-5') };
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
  const olderPage = page('older');
  // The tail reload after the append: a fresh newest window ending at seq 5,
  // with older history still available below it.
  const tailPage = { ...page('older'), throughSequence: 5 };
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
      ? { messages: messages.slice(3), nextCursor: 'older' }
      : candidate === tailPage
        ? { messages: [appended], nextCursor: 'older' }
        : { messages: messages.slice(1, 3), nextCursor: 'older' },
    loadTranscriptPage: async (input) => input.throughSequence === 5 ? tailPage : olderPage,
    async close() {},
  });
  const maxResidentBytes = (
    Buffer.byteLength(JSON.stringify(messages[0]!.message), 'utf8')
    + Buffer.byteLength(JSON.stringify(messages[1]!.message), 'utf8')
    + 1
  );
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes,
    onChange: (_replica, change) => changes.push(change),
  });

  await replica.loadBefore(3, 128 * 1024);
  assert.equal(replica.snapshot().hasNewer, true);
  changes.splice(0);

  // The Host persists a new assistant message (sequence 5) and advances.
  await replica.advance(5);

  const upserts = changes.flatMap((change) => change.durableUpserts.map(({ sequence }) => sequence));
  assert.ok(upserts.includes(5), 'the tail append must be delivered to open consumers');
  assert.equal(replica.durableThrough, 5);
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

test('does not resurrect a discarded replica when a tail re-anchor is in flight', async () => {
  // Guards the concurrency edge introduced by re-anchoring on `hasNewer`: the
  // re-anchor now awaits a page load, and `discard()` (memory reclaim for a
  // non-visible session) can run during that await. When the page resolves the
  // replica must stay non-resident and empty — repopulating durable state here
  // would undo the eviction and blow the memory bound.
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: {
      ...assistantMessage(String(sequence), `assistant-${sequence}`),
      turnId: `turn-${sequence}`,
    },
  }));
  const appended = { identity: 5, message: assistantMessage('5', 'assistant-5') };
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
  const olderPage = page('older');
  const tailPage = { ...page('older'), throughSequence: 5 };
  let releaseTail: () => void = () => {};
  const tailGate = new Promise<void>((resolve) => {
    releaseTail = resolve;
  });
  let signalTailEntered: () => void = () => {};
  const tailEntered = new Promise<void>((resolve) => {
    signalTailEntered = resolve;
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
      ? { messages: messages.slice(3), nextCursor: 'older' }
      : candidate === tailPage
        ? { messages: [appended], nextCursor: 'older' }
        : { messages: messages.slice(1, 3), nextCursor: 'older' },
    loadTranscriptPage: async (input) => {
      if (input.throughSequence === 5) {
        // Signal that catch-up is now parked inside the re-anchor's page await,
        // so the test can `discard()` at exactly that point.
        signalTailEntered();
        await tailGate;
        return tailPage;
      }
      return olderPage;
    },
    async close() {},
  });
  const maxResidentBytes = (
    Buffer.byteLength(JSON.stringify(messages[0]!.message), 'utf8')
    + Buffer.byteLength(JSON.stringify(messages[1]!.message), 'utf8')
    + 1
  );
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes,
    onChange: (_replica, change) => changes.push(change),
  });

  await replica.loadBefore(3, 128 * 1024);
  assert.equal(replica.snapshot().hasNewer, true);
  changes.splice(0);

  // Start the tail re-anchor; wait until catch-up is parked inside its page
  // await, then reclaim memory before the page resolves.
  const advancing = replica.advance(5);
  await tailEntered;
  replica.discard();
  assert.equal(replica.resident, false);
  releaseTail();
  await advancing;

  const upserts = changes.flatMap((change) => change.durableUpserts.map(({ sequence }) => sequence));
  assert.ok(!upserts.includes(5), 'a discarded replica must not be repopulated by an in-flight re-anchor');
  assert.equal(replica.resident, false);
  assert.equal(replica.residentBytes, 0);
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

test('loads a history target with newer messages available below it', async () => {
  const messages = [0, 1, 2, 3, 4].map((sequence) => ({
    identity: sequence,
    message: assistantMessage(String(sequence), `assistant-${sequence}`),
  }));
  const bootstrapPage = transcriptPage('older', null, 4);
  const aroundPage = transcriptPage('newer', 'newer', 4);
  const inputs: Array<{ direction: string; anchorSequence: number | null }> = [];
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 4,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 4), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (page) => page === bootstrapPage
      ? { messages: messages.slice(4), nextCursor: null }
      : { messages: messages.slice(0, 3), nextCursor: 'newer' },
    loadTranscriptPage: async (input) => {
      inputs.push(input);
      return input.direction === 'older' ? olderProbePage(0, false) : aroundPage;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 128 * 1024,
  });

  await replica.loadAround(0, 128 * 1024);

  assert.deepEqual(
    inputs.map(({ direction, anchorSequence }) => ({ direction, anchorSequence })),
    [
      { direction: 'newer', anchorSequence: null },
      // Nothing older than the anchor exists, and only this read can say so.
      { direction: 'older', anchorSequence: 0 },
    ],
  );
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [0, 1, 2]);
  assert.equal(replica.snapshot().hasOlder, false);
  assert.equal(replica.snapshot().hasNewer, true);
});

test('keeps an oversized transcript sparse while moving between indexed prompts', async () => {
  const messages = syntheticLargeTranscript();
  const totalBytes = messages.reduce(
    (total, entry) => total + Buffer.byteLength(JSON.stringify(entry.message), 'utf8'),
    0,
  );
  assert.ok(totalBytes > DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES * 2);

  const bootstrapPage = transcriptPage('older', 'older', 15);
  const historicalPage = transcriptPage('newer', 'newer', 15);
  const intermediatePage = transcriptPage('newer', 'newer', 15);
  const latestPage = transcriptPage('older', 'older', 15);
  const requests: Array<{
    direction: 'older' | 'newer';
    anchorSequence: number | null;
    maxBytes: number;
  }> = [];
  const rendererStore = transcriptStore();
  const generation = 'oversized-range';
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 15,
      overlayMessageCount: 0,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 15), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [],
    decodeTranscriptPage: async (page) => page === bootstrapPage || page === latestPage
      ? { messages: messages.slice(12, 16), nextCursor: 'older' }
      : page === historicalPage
        ? { messages: messages.slice(0, 5), nextCursor: 'newer' }
        : { messages: messages.slice(6, 11), nextCursor: 'newer' },
    loadTranscriptPage: async (input) => {
      requests.push({
        direction: input.direction,
        anchorSequence: input.anchorSequence,
        maxBytes: input.maxBytes,
      });
      if (input.direction === 'older') {
        if (input.maxBytes > 1) return latestPage;
        return olderProbePage(input.anchorSequence!, input.anchorSequence !== 0);
      }
      return input.anchorSequence === null ? historicalPage : intermediatePage;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    generation,
    onChange: (_current, change) => {
      for (const batch of encodeDesktopTranscriptChange({
        sessionId: 'session-1',
        generation,
        hostEpoch: 'host-1',
      }, change)) rendererStore.accept(batch);
    },
  });
  for (const batch of encodeDesktopTranscriptSnapshot(replica.snapshot())) {
    rendererStore.accept(batch);
  }

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [12, 13, 14, 15]);
  assert.deepEqual(renderedUserPrompts(rendererStore), ['Prompt 7', 'Prompt 8']);
  assert.equal(rendererStore.range().hasNewer, false);
  assertRangeFitsBudget(rendererStore);

  await replica.loadAround(0, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [0, 1, 2, 3, 4]);
  assert.deepEqual(renderedUserPrompts(rendererStore), ['Prompt 1', 'Prompt 2', 'Prompt 3']);
  assert.equal(rendererStore.range().hasOlder, false);
  assert.equal(rendererStore.range().hasNewer, true);
  assertRangeFitsBudget(rendererStore);

  await replica.loadAround(6, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [6, 7, 8, 9, 10]);
  assert.deepEqual(renderedUserPrompts(rendererStore), ['Prompt 4', 'Prompt 5', 'Prompt 6']);
  assert.equal(rendererStore.range().hasOlder, true);
  assert.equal(rendererStore.range().hasNewer, true);
  assertRangeFitsBudget(rendererStore);

  await replica.loadAround(15, DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [12, 13, 14, 15]);
  assert.deepEqual(renderedUserPrompts(rendererStore), ['Prompt 7', 'Prompt 8']);
  assert.equal(rendererStore.range().hasOlder, true);
  assert.equal(rendererStore.range().hasNewer, false);
  assertRangeFitsBudget(rendererStore);

  // Every jump that is not to the tail pays one extra single-byte read, the
  // only thing that can say whether the anchor has anything older than it.
  assert.deepEqual(requests, [
    { direction: 'newer', anchorSequence: null, maxBytes: DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES },
    { direction: 'older', anchorSequence: 0, maxBytes: 1 },
    { direction: 'newer', anchorSequence: 5, maxBytes: DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES },
    { direction: 'older', anchorSequence: 6, maxBytes: 1 },
    { direction: 'older', anchorSequence: 16, maxBytes: DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES },
  ]);
  replica.close();
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

test('keeps history resident when an active overlay uses its own cache budget', async () => {
  const overlay = assistantMessage('o'.repeat(700), 'overlay-1');
  const historical = assistantMessage('h'.repeat(700), 'history-1');
  const bootstrapPage = transcriptPage('older', 'older', 1);
  const olderPage = transcriptPage('older', null, 1);
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: 1,
      overlayMessageCount: 1,
      durable: bootstrapPage,
      overlay: { ...transcriptPage('older', null, 1), source: 'overlay' },
    },
    loadTranscriptOverlay: async () => [overlay],
    decodeTranscriptPage: async (page) => page === olderPage
      ? { messages: [{ identity: 0, message: historical }], nextCursor: null }
      : { messages: [], nextCursor: 'older' },
    loadTranscriptPage: async () => olderPage,
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle, {
    maxResidentBytes: 1_024,
    maxOverlayBytes: 1_024,
    maxMessageBytes: 1_024,
  });

  await replica.loadBefore(null, 128 * 1024);

  assert.deepEqual(replica.snapshot().durable.map(({ sequence }) => sequence), [0]);
  assert.equal(replica.snapshot().hasOlder, false);
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
      async loadBefore() {},
      async loadAfter() {},
      async loadAround() {},
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
  })) store.accept(batch);
  let request: { anchorSequence: number | null; maxBytes?: number } | undefined;
  const controller = createDesktopTranscriptRangeController(store, async () => ({
    sessionId: 'session-1',
    generation: 'generation-1',
    hostEpoch: 'host-1',
    readThroughMessageId: 'assistant-1',
    async loadBefore(anchorSequence, maxBytes) {
      request = { anchorSequence, maxBytes };
    },
    async loadAfter(anchorSequence, maxBytes) {
      request = { anchorSequence, maxBytes };
    },
    async loadAround() {},
    async close() {},
  }));

  await controller.loadBefore(512 * 1024, 'turn-2');

  assert.deepEqual(request, { anchorSequence: 2, maxBytes: 512 * 1024 });
  await controller.loadAfter(512 * 1024, 'turn-2');
  assert.deepEqual(request, { anchorSequence: 3, maxBytes: 512 * 1024 },
    'forward reads start after the last resident record of the visible turn');
  await controller.loadAfter(512 * 1024, 'evicted-turn');
  assert.deepEqual(request, { anchorSequence: 3, maxBytes: 512 * 1024 });
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
    durableThrough: 0,
    durableUpserts: [{ sequence: 0, message: assistantMessage('complete') }],
    evictedDurableSequences: [],
    completedOverlayMessageIds: [],
    hasOlder: false,
    hasNewer: false,
  })) store.accept(batch);

  assert.equal(await waiting, true);
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

/** The one-byte read `loadAround` uses to ask whether `sequence` has anything
 *  older than it: only the presence of a fragment answers, not its content. */
function olderProbePage(sequence: number, exists: boolean) {
  return {
    ...transcriptPage('older', null, sequence),
    fragments: exists
      ? [
          {
            kind: 'durable' as const,
            sequence,
            byteOffset: 0,
            totalBytes: 1,
            payloadDigest: null,
            data: '',
          },
        ]
      : [],
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

function renderedUserPrompts(store: DesktopTranscriptRangeStore): string[] {
  return store.snapshot().messages.flatMap((message) =>
    message.type === 'user' ? [message.text] : [],
  );
}

function assertRangeFitsBudget(store: DesktopTranscriptRangeStore): void {
  const bytes = store.snapshot().messages.reduce(
    (total, message) => total + Buffer.byteLength(JSON.stringify(message), 'utf8'),
    0,
  );
  assert.ok(bytes <= DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
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
      loadBefore: async () => {}, loadAfter: async () => {}, loadAround: async () => {},
      close: async () => {},
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
