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
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionTranscriptPage,
} from '@maka/runtime-host/protocol';
import { DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES } from '../../preload/transcript-contract.js';
import {
  createTranscriptRestoreLifecycle,
  restoreSessionTranscriptRange,
} from '../../renderer/features/conversation/testing.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

const PAGE_BYTES = 128 * 1024;

test('a history page reaches an oversized earlier Turn without disturbing the tail', async () => {
  const fixture = await oversizedHistoryFixture();
  try {
    assert.deepEqual(sequences(fixture.replica), [2, 3]);

    const page = await fixture.replica.loadBefore(2, PAGE_BYTES);

    assert.ok(page);
    assert.deepEqual(page.durable.map(({ sequence }) => sequence), [0, 1]);
    assert.equal(page.durable[1]?.message.id, 'assistant-a',
      'the oversized earlier answer reaches the Renderer whole');
    assert.equal(page.hasOlder, false);
    assert.deepEqual(
      sequences(fixture.replica),
      [2, 3],
      'a window read answers the Renderer and leaves the Main tail alone',
    );
  } finally {
    fixture.replica.close();
  }
});

test('tail catch-up evicts only the oldest Turns and always keeps the newest complete', async () => {
  const fixture = await oversizedHistoryFixture();
  try {
    await fixture.replica.advance(4);
    assert.deepEqual(sequences(fixture.replica), [2, 3, 4]);

    await fixture.replica.advance(6);

    assert.deepEqual(
      sequences(fixture.replica),
      [5, 6],
      'the oversized newest Turn stays whole and the older Turn leaves the tail',
    );
    assert.equal(fixture.replica.messages().at(-1)?.id, 'assistant-c');
    assert.equal(fixture.replica.durableThrough, 6);
    assert.equal(fixture.replica.snapshot().hasOlder, true);
  } finally {
    fixture.replica.close();
  }
});

test('a completed resident bookmark does not reload after streaming settlement evicts its Turn', async () => {
  const fixture = await oversizedHistoryFixture({ live: true });
  const lifecycle = createTranscriptRestoreLifecycle();
  let loaded = 0;
  const controller = {
    loadAround: async (sequence: number) => {
      loaded += 1;
      await fixture.replica.loadAround(sequence, PAGE_BYTES);
    },
    store: {
      sessionId: 'session-1',
      range: () => ({ sessionId: 'session-1' }),
      sequenceForTurn: (turnId: string) => fixture.replica.snapshot().durable
        .find(({ message }) => message.turnId === turnId)?.sequence ?? null,
      newestDurableUserSequence: () => 2,
      snapshot: () => ({ messages: fixture.replica.messages() }),
    },
  };
  const restore = () => restoreSessionTranscriptRange({
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a', sequence: 0 },
    controller,
    isCurrent: () => true,
    setReadingAnchor: () => {},
    onError: (error) => assert.fail(String(error)),
  });
  try {
    restore();
    await settleRestore();
    assert.equal(loaded, 0, 'an already resident bookmark completes without a range read');

    await fixture.replica.advance(3);
    restore();
    await settleRestore();
    await fixture.replica.advance(4);
    restore();
    await settleRestore();

    assert.equal(loaded, 0, 'message notifications cannot revive the completed bookmark command');
    assert.deepEqual(sequences(fixture.replica), [2, 3, 4]);
    assert.equal(fixture.replica.messages().at(-1)?.id, 'assistant-b-later');
  } finally {
    fixture.replica.close();
  }
});

test('reopening a bookmark at the current Turn retains content persisted later in that same Turn', async () => {
  const fixture = await oversizedHistoryFixture();
  try {
    assert.deepEqual(sequences(fixture.replica), [2, 3]);
    await fixture.replica.advance(4);
    assert.equal(fixture.replica.durableThrough, 4, 'the Host has persisted the final answer segment');

    // Reopening an observed Session reuses its resident replica. The renderer
    // starts a fresh restore lifecycle, and the bookmark is already resident.
    restoreSessionTranscriptRange({
      lifecycle: createTranscriptRestoreLifecycle(),
      sessionId: 'session-1',
      readingAnchor: { turnId: 'turn-b', sequence: 2 },
      controller: {
        loadAround: async (sequence) => { await fixture.replica.loadAround(sequence, PAGE_BYTES); },
        store: {
          sessionId: 'session-1',
          range: () => ({ sessionId: 'session-1' }),
          sequenceForTurn: (turnId) => fixture.replica.snapshot().durable
            .find(({ message }) => message.turnId === turnId)?.sequence ?? null,
          newestDurableUserSequence: () => 2,
          snapshot: () => ({ messages: fixture.replica.messages() }),
        },
      },
      isCurrent: () => true,
      setReadingAnchor: () => {},
      onError: (error) => assert.fail(String(error)),
    });
    await settleRestore();

    assert.equal(
      fixture.replica.messages().some(({ id }) => id === 'assistant-b-later'),
      true,
      'restoring the visible Turn must not silently omit its later persisted answer segment',
    );
  } finally {
    fixture.replica.close();
  }
});

test('repeated message notifications share one pending restore and cancellation preserves the newer bookmark', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  let finishLoad!: () => void;
  const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
  let reads = 0;
  let anchor: { turnId: string; sequence?: number } | undefined = { turnId: 'turn-a', sequence: 0 };
  let unavailable: string | undefined;
  const options = {
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a', sequence: 0 },
    controller: {
      setReadingAnchor: async () => {},
      loadAround: async () => { reads += 1; await loading; },
      store: {
        sessionId: 'session-1',
        range: () => ({ sessionId: 'session-1' }),
        sequenceForTurn: () => null,
        newestDurableUserSequence: () => 2,
        snapshot: () => ({ messages: ['old restored range'] }),
      },
    },
    isCurrent: () => true,
    setReadingAnchor: (_sessionId: string, next: typeof anchor) => { anchor = next; },
    onRestoreUnavailable: (_sessionId: string, turnId: string) => { unavailable = turnId; },
    onError: (error: unknown) => assert.fail(String(error)),
  };
  restoreSessionTranscriptRange(options);
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.equal(reads, 1);

  lifecycle.cancel('session-1');
  anchor = { turnId: 'turn-b', sequence: 2 };
  finishLoad();
  await settleRestore();
  restoreSessionTranscriptRange(options);
  await settleRestore();

  assert.equal(reads, 1, 'cancellation must not recapture the bookmark in the same activation');
  assert.deepEqual(anchor, { turnId: 'turn-b', sequence: 2 });
  assert.equal(unavailable, undefined, 'a cancelled restore cannot declare the newer bookmark unavailable');
});

test('switching away and back creates a fresh restore while clearing search does not replay a bookmark', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  const reads: number[] = [];
  const options = {
    lifecycle,
    sessionId: 'session-1',
    profileId: 'profile-1',
    readingAnchor: { turnId: 'turn-a', sequence: 0 },
    controller: {
      setReadingAnchor: async () => {},
      loadAround: async (sequence: number) => { reads.push(sequence); },
      store: {
        sessionId: 'session-1',
        range: () => ({ sessionId: 'session-1' }),
        sequenceForTurn: () => null,
        newestDurableUserSequence: () => 2,
        snapshot: () => ({ messages: [] as string[] }),
      },
    },
    isCurrent: () => true,
    setReadingAnchor: () => {},
    onError: (error: unknown) => assert.fail(String(error)),
  };
  restoreSessionTranscriptRange(options);
  await settleRestore();
  restoreSessionTranscriptRange({ ...options, searchTarget: {
    sessionId: 'session-1', turnId: 'turn-b', sequence: 2, nonce: 1,
  } });
  await settleRestore();
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.deepEqual(reads, [0, 2]);

  restoreSessionTranscriptRange({ ...options, sessionId: 'other-session', controller: undefined });
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.deepEqual(reads, [0, 2, 0], 'a later session activation may restore the saved bookmark again');

  restoreSessionTranscriptRange({ ...options, profileId: 'profile-2' });
  await settleRestore();
  assert.deepEqual(reads, [0, 2, 0, 0], 'changing Hosts also creates a fresh activation');
});

test('effect teardown followed by setup lets only the replacement restore settle its bookmark', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  const loads: Array<() => void> = [];
  let anchor: { turnId: string; sequence?: number } | undefined = { turnId: 'turn-a', sequence: 0 };
  let unavailable: string | undefined;
  const options = {
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a', sequence: 0 },
    controller: {
      setReadingAnchor: async () => {},
      loadAround: () => new Promise<void>((resolve) => { loads.push(resolve); }),
      store: {
        sessionId: 'session-1',
        range: () => ({ sessionId: 'session-1' }),
        sequenceForTurn: () => null,
        newestDurableUserSequence: () => 2,
        snapshot: () => ({ messages: ['replacement range'] }),
      },
    },
    isCurrent: () => true,
    setReadingAnchor: (_sessionId: string, next: typeof anchor) => { anchor = next; },
    onRestoreUnavailable: (_sessionId: string, turnId: string) => { unavailable = turnId; },
    onError: (error: unknown) => assert.fail(String(error)),
  };
  restoreSessionTranscriptRange(options);
  assert.equal(loads.length, 1, 'the first command admits its navigation synchronously');
  lifecycle.deactivate();
  restoreSessionTranscriptRange(options);
  assert.equal(loads.length, 2, 'StrictMode replay must admit a replacement navigation');

  loads[0]!();
  await settleRestore();
  assert.deepEqual(anchor, { turnId: 'turn-a', sequence: 0 });
  assert.equal(unavailable, undefined, 'the deactivated command cannot settle after replacement');
  loads[1]!();
  await settleRestore();
  assert.equal(anchor, undefined);
  assert.equal(unavailable, 'turn-a', 'only the replacement restore settles its unavailable target');
});

async function settleRestore(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('a live second Turn remains reachable after persistence evicts the oversized first Turn', async () => {
  const fixture = await oversizedHistoryFixture({ live: true });
  try {
    assert.deepEqual(sequences(fixture.replica), [0, 1]);
    assert.deepEqual(fixture.replica.snapshot().overlay.map(({ id }) => id), ['user-b', 'assistant-b']);

    await fixture.replica.advance(3);

    assert.deepEqual(sequences(fixture.replica), [2, 3]);
    assert.deepEqual(fixture.replica.snapshot().overlay, []);
    assert.equal(fixture.replica.messages().filter(({ id }) => id === 'assistant-b').length, 1);
    const answer = fixture.replica.messages().at(-1);
    assert.equal(answer?.type, 'assistant');
    assert.equal(answer?.type === 'assistant' ? answer.text : undefined, 'Second answer, persisted completely.');
    assert.equal(fixture.replica.snapshot().hasOlder, true);
    assert.equal(fixture.replica.snapshot().hasNewer, false);
  } finally {
    fixture.replica.close();
  }
});

function sequences(replica: DesktopTranscriptReplica): number[] {
  return replica.snapshot().durable.map(({ sequence }) => sequence);
}

async function oversizedHistoryFixture(options: { live?: boolean } = {}) {
  const records = [
    message('user', 'user-a', 'turn-a', 'First question.'),
    message('assistant', 'assistant-a', 'turn-a', 'A'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1)),
    message('user', 'user-b', 'turn-b', 'Second question.'),
    message('assistant', 'assistant-b', 'turn-b', 'Second answer, persisted completely.'),
    message('assistant', 'assistant-b-later', 'turn-b', 'A later durable answer segment.'),
    message('user', 'user-c', 'turn-c', 'Third question while the reader stays in the second Turn.'),
    message('assistant', 'assistant-c', 'turn-c', 'C'.repeat(DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + 1)),
  ].map((message, identity) => ({ identity, message }));
  const decodedPages = new Map<SessionTranscriptPage, { messages: typeof records; nextCursor: string | null }>();
  const page = (input: {
    direction: 'older' | 'newer';
    through: number;
    records: typeof records;
    hasMore: boolean;
    protectedSequence: number | null;
  }): SessionTranscriptPage => {
    const result: SessionTranscriptPage = {
      kind: 'page',
      sessionId: 'session-1',
      source: 'durable',
      direction: input.direction,
      throughSequence: input.through,
      rawBytes: input.records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record.message)), 0),
      fragments: [],
      rangeBoundarySequence: input.direction === 'older'
        ? input.records[0]?.identity ?? null
        : input.records.at(-1)?.identity ?? null,
      protectedTurnSequence: input.protectedSequence,
      nextCursor: input.hasMore ? 'more' : null,
    };
    decodedPages.set(result, { messages: input.records, nextCursor: result.nextCursor });
    return result;
  };
  const through = options.live ? 1 : 3;
  const bootstrapPage = page({
    direction: 'older',
    through,
    records: options.live ? records.slice(0, 2) : records.slice(2, 4),
    hasMore: !options.live,
    protectedSequence: options.live ? 0 : 2,
  });
  const requests: Array<{ direction: string; anchorSequence: number | null; throughSequence: number | null }> = [];
  const handle = runtimeHostSessionFixture({
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: {
        sessionId: 'session-1', metadataRevision: 1, status: 'running', createdAt: 1, isArchived: false,
      },
      projectionRevision: 1,
      rootTurn: null,
      goal: null,
      queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
    transcript: Promise.resolve([]),
    events: { async *[Symbol.asyncIterator]() {} },
    transcriptBootstrap: {
      throughSequence: through,
      overlayMessageCount: options.live ? 2 : 0,
      durable: bootstrapPage,
      overlay: { ...bootstrapPage, source: 'overlay', nextCursor: null },
    },
    loadTranscriptOverlay: async () => options.live ? records.slice(2, 4).map(({ message }) => message) : [],
    decodeTranscriptPage: async (candidate) => {
      const decoded = decodedPages.get(candidate);
      assert.ok(decoded, 'the replica must decode the page returned by its Host request');
      return decoded;
    },
    loadTranscriptPage: async (request) => {
      const through = request.throughSequence ?? 4;
      const anchor = request.anchorSequence ?? null;
      requests.push({ direction: request.direction, anchorSequence: anchor, throughSequence: through });
      const history = request.direction === 'older' ? anchor === 2 : anchor === null;
      return page({
        direction: request.direction,
        through,
        records: history ? records.slice(0, 2)
          : request.direction === 'older' ? records.slice(2, through + 1)
            : records.slice((anchor ?? -1) + 1, through + 1),
        hasMore: history ? request.direction === 'newer' : request.direction === 'older',
        protectedSequence: history ? 0 : through >= 5 ? 5 : 2,
      });
    },
    async close() {},
  });
  return { replica: await DesktopTranscriptReplica.prepare(handle), requests };
}

function message(
  type: 'user' | 'assistant',
  id: string,
  turnId: string,
  text: string,
): StoredMessage {
  const common = { id, turnId, ts: 1, text };
  return type === 'user' ? { type, ...common } : { type, ...common, modelId: 'fixture-model' };
}
