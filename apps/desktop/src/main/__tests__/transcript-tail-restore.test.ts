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
import { DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES } from '../../preload/transcript-contract.js';
import {
  createTranscriptRestoreLifecycle,
  restoreSessionTranscriptRange,
} from '../../renderer/features/conversation/testing.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

test('a history page reaches an oversized earlier Turn without disturbing the tail', async () => {
  const fixture = await oversizedHistoryFixture();
  try {
    assert.deepEqual(sequences(fixture.replica), [2, 3]);

    const page = await fixture.replica.readOlderPage(3, 'more');

    assert.deepEqual(page.durable.map(({ sequence }) => sequence), [0, 1]);
    assert.equal(page.durable[1]?.message.id, 'assistant-a',
      'the oversized earlier answer reaches the Renderer whole');
    assert.equal(page.nextCursor, null);
    assert.deepEqual(
      sequences(fixture.replica),
      [2, 3],
      'a history read answers its consumer and leaves the Main tail alone',
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

test('a completed loaded bookmark does not load earlier history after later notifications', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  const history = restoreHistory([{ turnId: 'turn-a' }]);
  const restore = () => restoreSessionTranscriptRange({
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a' },
    controller: history.controller,
    isCurrent: () => true,
    setReadingAnchor: () => {},
    onError: (error) => assert.fail(String(error)),
  });
  restore();
  await settleRestore();
  history.messages = [{ turnId: 'turn-b' }];
  restore();
  await settleRestore();
  assert.equal(history.loads, 0, 'a loaded bookmark completes without reading history, and stays completed');
});

test('repeated message notifications share one pending restore and cancellation preserves the newer bookmark', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  let finishLoad!: () => void;
  const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
  let anchor: { turnId: string } | undefined = { turnId: 'turn-a' };
  let unavailable: string | undefined;
  const history = restoreHistory([], async () => {
    await loading;
    history.hasOlder = false;
    history.messages = [];
  });
  const options = {
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a' },
    controller: history.controller,
    isCurrent: () => true,
    lookupTurn: history.lookupTurn,
    setReadingAnchor: (_sessionId: string, next: typeof anchor) => { anchor = next; },
    onRestoreUnavailable: (_sessionId: string, turnId: string) => { unavailable = turnId; },
    onError: (error: unknown) => assert.fail(String(error)),
  };
  restoreSessionTranscriptRange(options);
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.equal(history.loads, 1);

  lifecycle.cancel('session-1');
  anchor = { turnId: 'turn-b' };
  finishLoad();
  await settleRestore();
  restoreSessionTranscriptRange(options);
  await settleRestore();

  assert.equal(history.loads, 1, 'cancellation must not recapture the bookmark in the same activation');
  assert.deepEqual(anchor, { turnId: 'turn-b' });
  assert.equal(unavailable, undefined, 'a cancelled restore cannot declare the newer bookmark unavailable');
});

test('switching away and back creates a fresh restore while clearing search does not replay a bookmark', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  const history = restoreHistory([]);
  const options = {
    lifecycle,
    sessionId: 'session-1',
    profileId: 'profile-1',
    readingAnchor: { turnId: 'turn-a' },
    controller: history.controller,
    isCurrent: () => true,
    lookupTurn: history.lookupTurn,
    setReadingAnchor: () => {},
    onError: (error: unknown) => assert.fail(String(error)),
  };
  restoreSessionTranscriptRange(options);
  await settleRestore();
  restoreSessionTranscriptRange({ ...options, searchTarget: { sessionId: 'session-1', turnId: 'turn-b', nonce: 1 } });
  await settleRestore();
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.equal(history.loads, 2);

  restoreSessionTranscriptRange({ ...options, sessionId: 'other-session', controller: undefined });
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.equal(history.loads, 3, 'a later session activation may restore the saved bookmark again');

  restoreSessionTranscriptRange({ ...options, profileId: 'profile-2' });
  await settleRestore();
  assert.equal(history.loads, 4, 'changing Hosts also creates a fresh activation');
});

test('effect teardown followed by setup lets only the replacement restore settle its bookmark', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  const loads: Array<() => void> = [];
  let anchor: { turnId: string } | undefined = { turnId: 'turn-a' };
  let unavailable: string | undefined;
  const history = restoreHistory([], () => new Promise<void>((resolve) => {
    loads.push(() => {
      history.hasOlder = false;
      history.messages = [];
      resolve();
    });
  }));
  const options = {
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a' },
    controller: history.controller,
    isCurrent: () => true,
    lookupTurn: history.lookupTurn,
    setReadingAnchor: (_sessionId: string, next: typeof anchor) => { anchor = next; },
    onRestoreUnavailable: (_sessionId: string, turnId: string) => { unavailable = turnId; },
    onError: (error: unknown) => assert.fail(String(error)),
  };
  restoreSessionTranscriptRange(options);
  lifecycle.deactivate();
  restoreSessionTranscriptRange(options);
  await settleRestore();
  assert.equal(loads.length, 1, 'only the StrictMode replacement reads history');
  assert.deepEqual(anchor, { turnId: 'turn-a' });
  assert.equal(unavailable, undefined);
  loads[0]!();
  await settleRestore();
  assert.equal(anchor, undefined);
  assert.equal(unavailable, 'turn-a', 'only the replacement restore settles its unavailable target');
});

test('a bookmark read down to across a reopen is looked up again rather than declared unavailable', async () => {
  const lifecycle = createTranscriptRestoreLifecycle();
  let anchor: { turnId: string } | undefined = { turnId: 'turn-a' };
  let unavailable: string | undefined;
  const history = restoreHistory([], async () => {
    // The first answer lands on a range that reopened, which drops it.
    if (history.loads === 1) history.generation = 'generation-2';
    else history.messages = [{ turnId: 'turn-a' }];
  });
  restoreSessionTranscriptRange({
    lifecycle,
    sessionId: 'session-1',
    readingAnchor: { turnId: 'turn-a' },
    controller: history.controller,
    isCurrent: () => true,
    lookupTurn: history.lookupTurn,
    setReadingAnchor: (_sessionId, next) => { anchor = next; },
    onRestoreUnavailable: (_sessionId, turnId) => { unavailable = turnId; },
    onError: (error) => assert.fail(String(error)),
  });
  await settleRestore();
  await settleRestore();

  assert.equal(history.loads, 2);
  assert.equal(unavailable, undefined);
  assert.deepEqual(anchor, { turnId: 'turn-a' });
});

test('a second Turn reached by advancing evicts the oversized first Turn', async () => {
  const fixture = await oversizedHistoryFixture({ live: true });
  try {
    assert.deepEqual(sequences(fixture.replica), [0, 1]);

    await fixture.replica.advance(3);

    assert.deepEqual(sequences(fixture.replica), [2, 3]);
    const answer = fixture.replica.messages().at(-1);
    assert.equal(answer?.type, 'assistant');
    assert.equal(answer?.type === 'assistant' ? answer.text : undefined, 'Second answer, persisted completely.');
    assert.equal(fixture.replica.snapshot().hasOlder, true);
  } finally {
    fixture.replica.close();
  }
});

async function settleRestore(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** A loaded transcript whose earlier history is read by `load`; every read changes the snapshot. */
function restoreHistory(initial: Array<{ turnId: string }>, load: () => Promise<void> = async () => {}) {
  let snapshot = { messages: initial };
  const history = {
    loads: 0,
    hasOlder: true,
    generation: 'generation-1',
    lookupTurn: async () => 0,
    get messages() { return snapshot.messages; },
    set messages(messages: Array<{ turnId: string }>) { snapshot = { messages }; },
    controller: {
      store: {
        range: () => ({
          sessionId: 'session-1',
          hasOlder: history.hasOlder,
          ready: true,
          generation: history.generation,
        }),
        snapshot: () => snapshot,
      },
      loadEarlier: async () => {
        history.loads += 1;
        await load();
      },
    },
  };
  return history;
}

function sequences(replica: DesktopTranscriptReplica): number[] {
  return replica.snapshot().durable.map(({ sequence }) => sequence);
}

async function oversizedHistoryFixture(options: { live?: boolean } = {}) {
  const records = [
    message('user', 'user-a', 'turn-a', 'First question.'),
    message('assistant', 'assistant-a', 'turn-a', 'A'.repeat(DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + 1)),
    message('user', 'user-b', 'turn-b', 'Second question.'),
    message('assistant', 'assistant-b', 'turn-b', 'Second answer, persisted completely.'),
    message('assistant', 'assistant-b-later', 'turn-b', 'A later durable answer segment.'),
    message('user', 'user-c', 'turn-c', 'Third question while the reader stays in the second Turn.'),
    message('assistant', 'assistant-c', 'turn-c', 'C'.repeat(DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + 1)),
  ].map((message, identity) => ({ identity, message }));
  const decodedPages = new Map<SessionTranscriptPage, { messages: typeof records; nextCursor: string | null }>();
  const page = (input: {
    direction: 'older' | 'newer';
    through: number;
    records: typeof records;
    hasMore: boolean;
  }): SessionTranscriptPage => {
    const result: SessionTranscriptPage = {
      kind: 'page',
      sessionId: 'session-1',
      direction: input.direction,
      throughSequence: input.through,
      rawBytes: input.records.reduce((bytes, record) => bytes + Buffer.byteLength(JSON.stringify(record.message)), 0),
      fragments: [],
      nextCursor: input.hasMore ? 'more' : null,
      endsAtTurnBoundary: true,
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
  });
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
    transcriptBootstrap: { durable: bootstrapPage },
    decodeTranscriptPage: async (candidate) => {
      const decoded = decodedPages.get(candidate);
      assert.ok(decoded, 'the replica must decode the page returned by its Host request');
      return decoded;
    },
    loadTranscriptPage: async (request) => {
      const through = request.throughSequence ?? 4;
      if (request.direction === 'older') {
        return request.cursor === null
          ? page({ direction: 'older', through, records: records.slice(2, through + 1), hasMore: true })
          : page({ direction: 'older', through, records: records.slice(0, 2), hasMore: false });
      }
      const anchor = request.anchorSequence ?? -1;
      return page({ direction: 'newer', through, records: records.slice(anchor + 1, through + 1), hasMore: false });
    },
    async close() {},
  });
  return { replica: await DesktopTranscriptReplica.prepare(handle) };
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
