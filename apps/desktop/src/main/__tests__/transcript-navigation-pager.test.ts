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
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import {
  createSessionTranscriptBootstrap,
  readSessionTranscriptPage,
  updateSubscriberTranscriptHighWater,
} from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES } from '../../preload/transcript-contract.js';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';
import { openTranscriptNavigationLedger } from './transcript-navigation-test-fixture.js';

const PAGE_BYTES = 128 * 1024;
const HOST_EPOCH = 'transcript-navigation-host';
const SUBSCRIPTION_ID = 'transcript-navigation-subscription';

test('keeps both Turns reachable when an oversized ledger Turn is followed by a new durable tail', async () => {
  const source = transcriptFixture();
  assert.ok(source.first.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)), 0)
    > DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES);
  const ledger = await openTranscriptNavigationLedger([...source.first, ...source.second]);
  let opened: Awaited<ReturnType<typeof openReplica>> | undefined;
  try {
    const firstThrough = await ledger.appendThrough('completed-a');
    const first = await ledger.durableRecords();
    assertSourcePayloads(first, source.first);
    opened = await openReplica(ledger, firstThrough);
    const { replica, subscription, state } = opened;
    assertRecords(replica, first);
    assert.equal(replica.snapshot().hasOlder, false, 'sparse first-row sequence does not imply older history');
    assert.equal(replica.snapshot().hasNewer, false, 'unused low watermark bits do not imply a newer row');

    // RuntimeEvent transcripts publish a Turn durably only after it ends. The
    // running checkpoints below stay in the overlay, then this terminal event
    // advances the actual Host watermark and exercises live-to-durable eviction.
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
    await replica.advance(completeThrough);
    assertRecords(replica, second);

    // A window read answers the Renderer without touching Main's tail cache.
    const older = await replica.loadBefore(second[0]!.sequence, PAGE_BYTES);
    assert.ok(older);
    assert.deepEqual(older.durable, first,
      'older paging returns the complete oversized Turn adjacent to the anchor');
    assert.equal(older.hasOlder, false);
    assert.equal(older.hasNewer, undefined, 'an older page establishes only its older edge');
    assertRecords(replica, second);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      // An oversized Turn fills a client range on its own, so a reset anchored
      // on the oldest row ends at that range boundary rather than at the tail.
      // Reachability is carried by the newer edge and the page behind it.
      const around = await replica.loadAround(first[0]!.sequence, PAGE_BYTES);
      assert.ok(around);
      assert.deepEqual(around.durable, first);
      assert.equal(around.hasOlder, false);
      assert.equal(around.hasNewer, true);
      const newer = await replica.loadAfter(first.at(-1)!.sequence, PAGE_BYTES);
      assert.ok(newer);
      assert.deepEqual(newer.durable, second, 'the page past the boundary reaches the current tail');
      assert.equal(newer.hasNewer, false);
      assertRecords(replica, second);
    }
  } finally {
    opened?.replica.close();
    await opened?.subscription.close();
    await ledger.close();
  }
});

for (const checkpoint of ['running-b', 'result-b'] as const) {
  test(`retains the full oversized durable Turn while the running second Turn reaches ${checkpoint}`, async () => {
    const source = transcriptFixture();
    const ledger = await openTranscriptNavigationLedger([...source.first, ...source.second]);
    let opened: Awaited<ReturnType<typeof openReplica>> | undefined;
    try {
      const firstThrough = await ledger.appendThrough('completed-a');
      const first = await ledger.durableRecords();
      assert.equal(await ledger.appendThrough(checkpoint), firstThrough,
        'a running invocation changes its overlay, not the durable watermark');
      const rootTurn = {
        sessionId: ledger.sessionId, turnId: 'b',
        runId: 'run-b', status: 'running' as const,
      };
      opened = await openReplica(ledger, firstThrough, rootTurn);
      const { replica } = opened;
      assertRecords(replica, first);
      const expected = source.second.slice(0, source.second.findIndex(({ id }) => id === checkpoint) + 1)
        .filter((message) => message.type !== 'turn_state').map(({ id }) => id);
      assert.deepEqual(replica.snapshot().overlay.map(({ id }) => id), expected);
      assert.ok(replica.messages().some(({ id }) => id === expected.at(-1)), 'the running Turn remains reachable');

      const throughSequence = await ledger.appendThrough('completed-b');
      assert.ok(throughSequence !== null);
      assert.equal(updateSubscriberTranscriptHighWater(opened.state, throughSequence), true);
      opened.subscription.accept({
        kind: 'subscription.transcript_advanced', hostEpoch: HOST_EPOCH,
        subscriptionId: SUBSCRIPTION_ID, sequence: 1, sessionId: ledger.sessionId,
        throughSequence,
      });
      assert.equal((await opened.subscription.next()).value?.kind, 'subscription.transcript_advanced');
      await replica.advance(throughSequence);
      assert.deepEqual(replica.snapshot().overlay, []);
      const second = (await ledger.durableRecords()).filter(({ message }) => message.turnId === rootTurn.turnId);
      assertRecords(replica, second);
      assert.equal(replica.snapshot().hasNewer, false);
    } finally {
      opened?.replica.close();
      await opened?.subscription.close();
      await ledger.close();
    }
  });
}

type Ledger = Awaited<ReturnType<typeof openTranscriptNavigationLedger>>;
async function openReplica(
  ledger: Ledger,
  throughSequence: number | null,
  rootTurn: { sessionId: string; turnId: string; runId: string; status: 'running' } | null = null,
) {
  const { reader, sessionId } = ledger;
  const opened = await createSessionTranscriptBootstrap({
    reader, sessionId, subscriptionId: SUBSCRIPTION_ID, throughSequence, rootTurn,
    activeAssistantStreams: [], maxBytes: 16 * 1024, projection: 'owner',
  });
  const subscription = new ClientSessionSubscription({
    hostEpoch: HOST_EPOCH, subscriptionId: SUBSCRIPTION_ID, nextSequence: 1,
    activeAssistantStreams: [], transcript: opened.bootstrap,
    snapshot: {
      schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
      session: { sessionId, metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
      projectionRevision: 1, rootTurn, goal: null,
      queue: { hostEpoch: HOST_EPOCH, queueRevision: 0, steering: [], followup: [] },
      interactions: { pending: [] },
    },
  }, async () => undefined, (request) => readSessionTranscriptPage({ reader, state: opened.state, request }));
  const decodeMessage = (value: unknown) => decodeStoredMessage(markPersisted<StoredMessage>(value));
  const replica = await DesktopTranscriptReplica.prepare(runtimeHostSessionFixture({
    snapshot: subscription.snapshot, transcript: Promise.resolve([]), events: subscription,
    transcriptBootstrap: opened.bootstrap,
    loadTranscriptOverlay: (maxBytes, accountBytes) => subscription.loadTranscriptOverlay(decodeMessage, maxBytes, accountBytes),
    decodeTranscriptPage: (page, maxBytes, accountBytes) => subscription.decodeTranscriptPage(page, decodeMessage, maxBytes, accountBytes),
    loadTranscriptPage: (request) => subscription.loadTranscriptPage(request),
    close: () => subscription.close(),
  }));
  return { replica, subscription, state: opened.state };
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
  return { first: turn('a', DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES + PAGE_BYTES), second: turn('b', 256) };
}
