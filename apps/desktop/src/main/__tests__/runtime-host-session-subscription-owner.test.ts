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
import { deferred, waitFor as pollFor } from '@maka/core/test-only/async-primitives';
import type { SubscriptionFrame } from '@maka/runtime-host/protocol';
import type { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import { RuntimeHostSessionSubscriptionOwner } from '../runtime-host-session-subscription-owner.js';
import {
  AsyncFrameQueue,
  continuitySnapshot,
  runtimeHostSessionFixture,
  transcriptPage,
} from './runtime-host-session-test-fixture.js';

test('dispatches a frame failure before the subscription iterator finishes closing', async () => {
  const returnGate = deferred<void>();
  const events = new BlockingReturnQueue(returnGate.promise);
  let terminal: Error | undefined;
  const injected = new Error('frame handling failed');
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          async close() {},
        }),
    },
    sessionId: 'session-1',
    now: Date.now,
    prepareActivation: async () => () => {},
    acceptFrame: () => {
      throw injected;
    },
    recoveryStarted: () => {},
    recoveryCompleted: () => {},
    recoveryFailed: () => {},
    terminalFailure: (error) => {
      terminal = error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  events.push(transcriptFrame(1));
  // Leaving the iterator awaits its return(), which is still blocked — the
  // failure must already be on its way to teardown, not queued behind it.
  await pollFor(() => terminal === injected, {
    attempts: 50,
    message: 'frame failure did not reach terminal handling',
  });

  returnGate.resolve(undefined);
  await owner.close();
});

test('reseeds an evicted replica on the same live subscription', async () => {
  const events = new AsyncFrameQueue();
  let watermark = 2;
  let replica!: DesktopTranscriptReplica;
  let opens = 0;
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => watermark,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(page.throughSequence),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async (input) =>
            transcriptPage(input.direction, input.direction === 'older' ? 5 : 6),
          async close() {
            events.end();
          },
        });
      },
    },
    sessionId: 'session-1',
    now: () => 0,
    prepareActivation: async (subscription) => {
      replica = subscription.replica;
      return () => {};
    },
    acceptFrame: () => {},
    recoveryStarted: () => {},
    recoveryCompleted: () => {},
    recoveryFailed: () => {},
    terminalFailure: (error) => {
      throw error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  replica.discard();
  watermark = 6;
  const reseeded = await owner.reseedTranscriptReplica();

  assert.equal(opens, 1, 'reseed must reuse the live subscription');
  assert.ok(reseeded);
  assert.notEqual(reseeded, replica);
  assert.throws(() => replica.messages(), /is closed/);
  assert.equal(reseeded.resident, true);
  assert.equal(reseeded.durableThrough, 6);
  assert.deepEqual(
    reseeded.messages().map((message) => message.id),
    ['row-3', 'row-4', 'row-5', 'row-6'],
  );
  await owner.close();
});

test('a reseed superseded by subscription recovery does not displace the new replica', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const reseedFetch = deferred<void>();
  let opens = 0;
  const replicas: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        const events = opens === 1 ? firstEvents : secondEvents;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => 2,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(page.throughSequence),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async () => {
            await reseedFetch.promise;
            return transcriptPage('older', 2);
          },
          async close() {
            events.end();
          },
        });
      },
    },
    sessionId: 'session-1',
    now: () => 0,
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    acceptFrame: () => {},
    recoveryStarted: () => {},
    recoveryCompleted: () => {},
    recoveryFailed: () => {},
    terminalFailure: (error) => {
      throw error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  replicas[0]!.discard();
  const reseeding = owner.reseedTranscriptReplica();
  firstEvents.push({
    kind: 'subscription.closed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-1',
    sequence: 1,
    reason: 'slow_consumer',
  });
  await pollFor(() => opens === 2);
  reseedFetch.resolve(undefined);

  assert.equal(await reseeding, undefined);
  await owner.waitUntilReady();
  assert.equal(replicas.length, 2);
  await owner.close();
});

function rowsThrough(
  throughSequence: number | null,
): { identity: number; message: StoredMessage }[] {
  const first = throughSequence === 5 ? 3 : (throughSequence ?? 0);
  const rows: { identity: number; message: StoredMessage }[] = [];
  for (let identity = first; identity <= (throughSequence ?? 0); identity += 1) {
    rows.push({
      identity,
      message: {
        type: 'assistant',
        id: `row-${identity}`,
        turnId: 'turn-1',
        ts: 1,
        text: `row-${identity}`,
        modelId: 'test-model',
      },
    });
  }
  return rows;
}

class BlockingReturnQueue implements AsyncIterable<SubscriptionFrame> {
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<SubscriptionFrame>) => void> = [];

  constructor(private readonly returnGate: Promise<void>) {}

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return {
      next: () => {
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: async () => {
        await this.returnGate;
        return { value: undefined, done: true };
      },
    };
  }
}

function transcriptFrame(sequence: number): SubscriptionFrame {
  return {
    kind: 'subscription.transcript_advanced',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence,
    throughSequence: sequence,
  };
}
