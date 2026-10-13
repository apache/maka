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
import { Buffer } from 'node:buffer';
import test from 'node:test';
import { markPersisted } from '@maka/core/persisted-value';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionTranscriptPage,
} from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
  updateSubscriberTranscriptHighWater,
} from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES } from '../../preload/transcript-contract.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';
import { openTranscriptLedger } from './transcript-ledger-test-fixture.js';

const PAGE_BYTES = 128 * 1024;
const HOST_EPOCH = 'transcript-history-host';
const SUBSCRIPTION_ID = 'transcript-history-subscription';

test('keeps both Turns reachable when an oversized ledger Turn is followed by a new durable tail', async () => {
  const source = transcriptFixture();
  assert.ok(source.first.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0)
    > DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES);
  const ledger = await openTranscriptLedger([...source.first, ...source.second]);
  let opened: Awaited<ReturnType<typeof openReplica>> | undefined;
  try {
    const firstThrough = await ledger.appendThrough('completed-a');
    const first = await ledger.durableRecords();
    assertSourcePayloads(first, source.first);
    opened = await openReplica(ledger, firstThrough);
    const { replica, subscription, state } = opened;
    assertTailOf(replica, first);

    const completeThrough = await ledger.appendThrough('completed-b');
    assert.ok(completeThrough !== null);
    const complete = await ledger.durableRecords();
    const second = complete.filter(({ message }) => message.turnId === 'b');
    assertSourcePayloads(second, source.second);
    assert.ok(first.some((record, index) => index > 0 && record.sequence > first[index - 1]!.sequence + 1));
    assert.ok(completeThrough > complete.at(-1)!.sequence, 'the real watermark includes unused event sequence slots');
    assert.equal(updateSubscriberTranscriptHighWater(state, completeThrough), true);
    subscription.accept({
      kind: 'subscription.transcript_advanced', hostEpoch: HOST_EPOCH,
      subscriptionId: SUBSCRIPTION_ID, sequence: 1, sessionId: ledger.sessionId,
      throughSequence: completeThrough,
    });
    assert.equal((await subscription.next()).value?.kind, 'subscription.transcript_advanced');
    await replica.advance();
    assertRecords(replica, second);

    // A history read walks older pages through the watermark without touching
    // Main's tail cache, and returns every row of the oversized Turn.
    const history: { sequence: number; message: StoredMessage }[] = [];
    let cursor: string | null = null;
    do {
      const page = await replica.readOlderPage(completeThrough, cursor);
      history.unshift(...page.durable);
      cursor = page.nextCursor;
    } while (cursor !== null);
    assert.deepEqual(history, complete);
    assertRecords(replica, second);

    for (const [turnId, records] of [['a', first], ['b', second]] as const) {
      assert.deepEqual(
        await replica.readTurn(turnId, extentOf(records), 16 * 1024 * 1024),
        records.map(({ message }) => message),
        'a Turn read stops at the next Turn and keeps the oversized payload whole',
      );
    }
    await assert.rejects(replica.readTurn('a', extentOf(first), PAGE_BYTES), RangeError);
    assertRecords(replica, second);
  } finally {
    opened?.replica.close();
    await opened?.subscription.close();
    await ledger.close();
  }
});

for (const checkpoint of ['running-b', 'result-b'] as const) {
  test(`serves the running second Turn through durable pages at ${checkpoint}`, async () => {
    const source = transcriptFixture();
    const ledger = await openTranscriptLedger([...source.first, ...source.second]);
    let opened: Awaited<ReturnType<typeof openReplica>> | undefined;
    try {
      const firstThrough = await ledger.appendThrough('completed-a');
      const runningThrough = await ledger.appendThrough(checkpoint);
      assert.ok(firstThrough !== null && runningThrough !== null && runningThrough > firstThrough,
        'each committed RuntimeEvent of a running Turn advances the watermark');
      opened = await openReplica(ledger, runningThrough);
      const { replica } = opened;
      const expected = source.second.slice(0, source.second.findIndex(({ id }) => id === checkpoint) + 1)
        .filter((message) => message.type !== 'turn_state').map(({ id }) => id);
      assert.deepEqual(
        replica.snapshot().durable.filter(({ message }) => message.turnId === 'b').map(({ message }) => message.id),
        expected,
      );

      const throughSequence = await ledger.appendThrough('completed-b');
      assert.ok(throughSequence !== null);
      assert.equal(updateSubscriberTranscriptHighWater(opened.state, throughSequence), true);
      opened.subscription.accept({
        kind: 'subscription.transcript_advanced', hostEpoch: HOST_EPOCH,
        subscriptionId: SUBSCRIPTION_ID, sequence: 1, sessionId: ledger.sessionId,
        throughSequence,
      });
      assert.equal((await opened.subscription.next()).value?.kind, 'subscription.transcript_advanced');
      await replica.advance();
      const second = (await ledger.durableRecords()).filter(({ message }) => message.turnId === 'b');
      assertRecords(replica, second);
    } finally {
      opened?.replica.close();
      await opened?.subscription.close();
      await ledger.close();
    }
  });
}

/**
 * The Host writes a nested Turn's rows between its parent's, so the two share a
 * stretch of the Session's ordinals (see `session-transcript-reader.test.ts`,
 * "serves every row of a Turn nested inside another"). A targeted read
 * of the outer Turn has to read through that stretch, not stop at it.
 */
test('reads a Turn through the rows of a nested one', async () => {
  const outer = (id: string, ts: number): StoredMessage =>
    ({ type: 'assistant', id, turnId: 'outer', ts, text: `outer ${id}`, modelId: 'fixture-model' });
  const source: StoredMessage[] = [
    { type: 'user', id: 'user-outer', turnId: 'outer', ts: 1, text: 'Outer question' },
    outer('outer-before', 2),
    { type: 'user', id: 'user-inner', turnId: 'inner', ts: 3, text: 'Inner question' },
    { type: 'assistant', id: 'inner-answer', turnId: 'inner', ts: 4, text: 'inner answer', modelId: 'fixture-model' },
    { type: 'turn_state', id: 'completed-inner', turnId: 'inner', ts: 5, status: 'completed' },
    outer('outer-after', 6),
    { type: 'turn_state', id: 'completed-outer', turnId: 'outer', ts: 7, status: 'completed' },
  ];
  const ledger = await openTranscriptLedger(source);
  let opened: Awaited<ReturnType<typeof openReplica>> | undefined;
  try {
    const throughSequence = await ledger.appendThrough('completed-outer');
    const records = await ledger.durableRecords();
    opened = await openReplica(ledger, throughSequence);
    const read = await opened.replica.readTurn(
      'outer',
      extentOf(records.filter(({ message }) => message.turnId === 'outer')),
      PAGE_BYTES,
    );
    assert.deepEqual(
      read.map(({ id }) => id),
      records.filter(({ message }) => message.turnId === 'outer').map(({ message }) => message.id),
      'the nested Turn ended the read of the Turn around it',
    );
  } finally {
    opened?.replica.close();
    await opened?.subscription.close();
    await ledger.close();
  }
});

test('refuses a Turn read whose continuation never advances', async () => {
  const source = transcriptFixture();
  const ledger = await openTranscriptLedger(source.first);
  let opened: Awaited<ReturnType<typeof openReplica>> | undefined;
  try {
    const throughSequence = await ledger.appendThrough('completed-a');
    const records = await ledger.durableRecords();
    let pages = 0;
    opened = await openReplica(ledger, throughSequence, (request) => {
      pages += 1;
      return {
        kind: 'page', sessionId: ledger.sessionId, direction: request.direction,
        throughSequence: request.throughSequence, rawBytes: 0, fragments: [],
        nextCursor: 'stalled', endsAtTurnBoundary: false,
      };
    });
    await assert.rejects(
      opened.replica.readTurn('a', extentOf(records), PAGE_BYTES),
      /empty continuation/,
    );
    assert.equal(pages, 1);
  } finally {
    opened?.replica.close();
    await opened?.subscription.close();
    await ledger.close();
  }
});

type Ledger = Awaited<ReturnType<typeof openTranscriptLedger>>;
async function openReplica(
  ledger: Ledger,
  throughSequence: number | null,
  hostPage?: (request: Parameters<ClientSessionSubscription['loadTranscriptPage']>[0]) => SessionTranscriptPage,
) {
  const { reader, sessionId } = ledger;
  const opened = await createSessionTranscriptBootstrap({
    reader, sessionId, subscriptionId: SUBSCRIPTION_ID, throughSequence,
    maxBytes: 16 * 1024, projection: 'owner',
  });
  const subscription = new ClientSessionSubscription({
    hostEpoch: HOST_EPOCH, subscriptionId: SUBSCRIPTION_ID, nextSequence: 1,
    activeAssistantStreams: [], transcript: opened.bootstrap,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: { sessionId, metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
      projectionRevision: 1, rootTurn: null, goal: null,
      queue: { hostEpoch: HOST_EPOCH, queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
  }, async () => undefined, (request) => readSessionTranscriptPage({ reader, state: opened.state, request }), async () => undefined);
  const decodeMessage = (value: unknown) => decodeStoredMessage(markPersisted<StoredMessage>(value));
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: subscription.snapshot, events: subscription,
    transcriptBootstrap: opened.bootstrap,
    transcriptWatermark: () => subscription.transcriptWatermark,
    decodeTranscriptPage: (page, maxBytes, accountBytes) => subscription.decodeTranscriptPage(page, decodeMessage, maxBytes, accountBytes),
    loadTranscriptPage: (request) =>
      hostPage ? Promise.resolve(hostPage(request)) : subscription.loadTranscriptPage(request),
    close: () => subscription.close(),
  }));
  return { replica, subscription, state: opened.state };
}

/** The bootstrap page is byte-bounded, so the tail cache may start inside the oversized Turn. */
function assertTailOf(replica: DesktopTranscriptReplica, records: readonly { sequence: number; message: StoredMessage }[]) {
  const { durable, hasOlder } = replica.snapshot();
  assert.ok(durable.length > 0);
  assert.deepEqual(durable, records.slice(records.length - durable.length));
  assert.equal(hasOlder, durable.length < records.length, 'older history is reported exactly when rows are missing');
}

function extentOf(records: readonly { sequence: number }[]) {
  return { sequence: records[0]!.sequence, lastSequence: records.at(-1)!.sequence };
}

function assertRecords(replica: DesktopTranscriptReplica, records: readonly { sequence: number; message: StoredMessage }[]) {
  assert.deepEqual(replica.snapshot().durable, records, 'every selected Turn row and its full payload survives paging');
}

function assertSourcePayloads(
  records: readonly { message: StoredMessage }[],
  source: readonly StoredMessage[],
) {
  // Running status is projected separately; every content row survives.
  const expected = source.filter((message) => message.type !== 'turn_state' || message.status !== 'running');
  assert.deepEqual(new Set(records.map(({ message }) => message.id)), new Set(expected.map(({ id }) => id)));
  for (const message of expected) {
    const projected = records.find((record) => record.message.id === message.id)!.message;
    if (message.type === 'tool_result') {
      assert.equal(projected.type, 'tool_result');
      if (projected.type === 'tool_result') assert.deepEqual(projected.content, message.content);
    }
    if (message.type === 'assistant') {
      assert.equal(projected.type, 'assistant');
      if (projected.type === 'assistant') {
        assert.equal(projected.text, message.text);
        assert.equal(projected.thinking?.text, message.thinking?.text);
      }
    }
  }
}

function transcriptFixture() {
  const turn = (turnId: string, resultBytes: number): StoredMessage[] => [
    { type: 'user', id: `user-${turnId}`, turnId, ts: 1, text: `Question ${turnId}` },
    { type: 'turn_state', id: `running-${turnId}`, turnId, ts: 2, status: 'running' },
    { type: 'assistant', id: `step-${turnId}`, turnId, ts: 3, text: 'Checking the source.', modelId: 'fixture-model' },
    {
      type: 'tool_call', id: `tool-${turnId}`, turnId, ts: 4, stepId: `step-${turnId}`,
      toolName: 'fixture_lookup', args: { query: turnId }, origin: 'provider', modelVisibility: 'visible',
    },
    {
      type: 'tool_result', id: `result-${turnId}`, turnId, ts: 5, toolUseId: `tool-${turnId}`,
      isError: false, content: { kind: 'json', value: { payload: 'x'.repeat(resultBytes) } },
      origin: 'provider', modelVisibility: 'visible',
    },
    {
      type: 'assistant', id: `answer-${turnId}`, turnId, ts: 6, text: `Complete answer ${turnId}`,
      thinking: { text: 'Retained reasoning.' }, modelId: 'fixture-model',
    },
    { type: 'turn_state', id: `completed-${turnId}`, turnId, ts: 7, status: 'completed' },
  ];
  // One complete tool payload crosses both page and resident-range budgets.
  // The record count is incidental; the next Turn starts live and ends durably.
  return { first: turn('a', DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES + PAGE_BYTES), second: turn('b', 256) };
}
