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
import {
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
} from '@maka/runtime-host/client';
import { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import {
  continuitySnapshot,
  runtimeHostSessionFixture,
  transcriptPage,
} from './runtime-host-session-test-fixture.js';

test('latches a dead transcript page read like a dead subscription', async () => {
  const failure = new RuntimeHostOperationError(
    'session.transcript.page',
    'not_found',
    'subscription transcript context was lost',
  );
  let pageReads = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcriptWatermark: () => 8,
    loadTranscriptPage: async () => {
      pageReads += 1;
      throw failure;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await assert.rejects(replica.advance(), (error) => error === failure);
  await assert.rejects(replica.advance(), (error) => error === failure);
  assert.equal(pageReads, 1);
  assert.equal(replica.resident, false);
  await handle.close();
});

test('latches a dead subscription instead of re-arming the catch-up read', async () => {
  const failure = new RuntimeHostSubscriptionError(
    'connection_closed',
    'Session subscription closed during transcript loading',
  );
  let pageReads = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcriptWatermark: () => 8,
    loadTranscriptPage: async () => {
      pageReads += 1;
      throw failure;
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await assert.rejects(replica.advance(), (error) => error === failure);
  await flushMicrotasks();
  assert.equal(pageReads, 1);

  await assert.rejects(replica.advance(), (error) => error === failure);
  assert.equal(pageReads, 1);
  assert.throws(() => replica.messages(), (error: unknown) => error === failure);
  assert.equal(replica.resident, false);
  await handle.close();
});

test('does not latch a transient operation failure', async () => {
  const failure = new RuntimeHostOperationError(
    'session.transcript.page',
    'internal_failure',
    'transient host failure',
  );
  let pageReads = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcriptWatermark: () => 8,
    loadTranscriptPage: async () => {
      pageReads += 1;
      if (pageReads === 1) throw failure;
      return transcriptPage('newer', 8);
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await assert.rejects(replica.advance(), (error) => error === failure);
  // The same class of failure that kills a subscription is permanent, but a
  // retryable operation failure must keep the replica retryable too.
  await replica.advance();
  assert.equal(pageReads, 2);
  assert.equal(replica.resident, true);
  assert.equal(replica.durableThrough, 8);
  await handle.close();
});

test('follows the subscription watermark rather than an announced frame', async () => {
  let watermark = 4;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcriptWatermark: () => watermark,
    loadTranscriptPage: async (input) => transcriptPage('newer', input.throughSequence),
    decodeTranscriptPage: async (requested) => ({
      messages: [
        {
          identity: requested.throughSequence ?? 0,
          message: {
            type: 'assistant',
            id: `row-${requested.throughSequence}`,
            turnId: 'turn-1',
            ts: 1,
            text: 'done',
            modelId: 'test-model',
          },
        },
      ],
      nextCursor: null,
    }),
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  await replica.advance();
  assert.equal(replica.durableThrough, 4);
  watermark = 9;
  await replica.advance();
  assert.equal(replica.durableThrough, 9);
  await handle.close();
});

test('re-reads the watermark when it moves during a blocked fetch', async () => {
  const fetchGate = deferred<void>();
  let watermark = 4;
  let pageReads = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcriptWatermark: () => watermark,
    loadTranscriptPage: async (input) => {
      pageReads += 1;
      if (pageReads === 1) await fetchGate.promise;
      return transcriptPage('newer', input.throughSequence);
    },
    decodeTranscriptPage: async (requested) => ({
      messages: [
        {
          identity: requested.throughSequence ?? 0,
          message: {
            type: 'assistant',
            id: `row-${requested.throughSequence}`,
            turnId: 'turn-1',
            ts: 1,
            text: 'done',
            modelId: 'test-model',
          },
        },
      ],
      nextCursor: null,
    }),
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  const first = replica.advance();
  watermark = 9;
  const coalesced = replica.advance();
  fetchGate.resolve(undefined);
  await Promise.all([first, coalesced]);
  // The mid-flight advance coalesced, but the catch-up's loop-top re-read and
  // the one post-settle re-arm still carry it to the live watermark.
  await replica.advance();
  assert.equal(replica.durableThrough, 9);
  await handle.close();
});

test('advance resolves quietly without reading once evicted', async () => {
  let pageReads = 0;
  const handle = runtimeHostSessionFixture({
    snapshot: continuitySnapshot(),
    transcriptWatermark: () => 8,
    loadTranscriptPage: async () => {
      pageReads += 1;
      return transcriptPage('newer', 8);
    },
    async close() {},
  });
  const replica = await DesktopTranscriptReplica.prepare(handle);

  replica.discard();
  // An evicted replica must stay inert: a subscription-scoped throw from here
  // would still reach the pump and tear down the live subscription.
  await replica.advance();
  assert.equal(pageReads, 0);
  assert.equal(replica.durableThrough, null);
  assert.throws(() => replica.messages(), /evicted/);
  await handle.close();
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
