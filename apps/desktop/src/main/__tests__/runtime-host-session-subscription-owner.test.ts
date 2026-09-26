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
  type Deferred,
  deferred,
  waitFor as pollFor,
} from '@maka/core/test-only/async-primitives';
import {
  RuntimeHostOperationError,
  RuntimeHostSubscriptionError,
  SessionRemovedSubscriptionError,
} from '@maka/runtime-host/client';
import type { SubscriptionFrame } from '@maka/runtime-host/protocol';
import type { DesktopTranscriptReplica } from '../desktop-transcript-replica.js';
import {
  RuntimeHostSessionSubscriptionOwner,
} from '../runtime-host-session-subscription-owner.js';
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
  const injected = new RuntimeHostSubscriptionError(
    'connection_closed',
    'frame handling failed',
  );
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
    prepareActivation: async () => () => {},
    installReseededReplica: () => {},
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

test('a committed frame failure is terminal, not absorbed', async () => {
  const events = new AsyncFrameQueue();
  let terminal: Error | undefined;
  const injected = new Error('committed frame failure');
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
    prepareActivation: async () => () => {},
    installReseededReplica: () => {},
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

  // A non-transcript frame's acceptFrame may have committed a mutation that
  // will not be replayed, so its unclassified failure dies loudly instead of
  // being absorbed like a transcript read failure.
  events.push({
    kind: 'subscription.session_domain_changed',
    hostEpoch: 'host-1',
    subscriptionId: 'subscription-session-1',
    sessionId: 'session-1',
    sequence: 1,
    domain: 'usage',
  });
  await pollFor(() => terminal !== undefined, {
    attempts: 50,
    message: 'committed frame failure was absorbed instead of terminating',
  });
  assert.equal(terminal, injected);
  await owner.close();
});

test('reseeds an evicted replica on the same live subscription', async () => {
  const events = new AsyncFrameQueue();
  let watermark = 2;
  let replica!: DesktopTranscriptReplica;
  let prepBytes = 0;
  const installs: DesktopTranscriptReplica[] = [];
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
    transcriptReplicaOptions: {
      accountPreparationBytes: (deltaBytes) => {
        prepBytes += deltaBytes;
      },
    },
    prepareActivation: async (subscription) => {
      replica = subscription.replica;
      return () => {};
    },
    installReseededReplica: (reseeded) => {
      // The commit runs before the evicted replica closes: at install time it
      // must still fail as evicted, not as closed.
      assert.throws(() => replica.messages(), /was evicted/);
      installs.push(reseeded);
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
  await owner.reseedTranscriptReplica();

  assert.equal(opens, 1, 'reseed must reuse the live subscription');
  assert.equal(installs.length, 1);
  const reseeded = installs[0]!;
  assert.notEqual(reseeded, replica);
  assert.throws(() => replica.messages(), /is closed/);
  assert.equal(reseeded.resident, true);
  assert.equal(reseeded.durableThrough, 6);
  assert.equal(prepBytes, reseeded.residentBytes);
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
  let prepBytes = 0;
  const replicas: DesktopTranscriptReplica[] = [];
  const installs: DesktopTranscriptReplica[] = [];
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
    transcriptReplicaOptions: {
      accountPreparationBytes: (deltaBytes) => {
        prepBytes += deltaBytes;
      },
    },
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    installReseededReplica: (replica) => installs.push(replica),
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

  await reseeding;
  await owner.waitUntilReady();
  assert.equal(replicas.length, 2);
  assert.equal(installs.length, 0);
  // The superseded build is closed, not installed: only the recovery
  // replica's resident bytes stay accounted.
  assert.equal(prepBytes, replicas[1]!.residentBytes);
  await owner.close();
});

test('serializes concurrent reseeds into exactly one swap', async () => {
  const events = new AsyncFrameQueue();
  const fetches: Array<Deferred<void>> = [];
  let replica!: DesktopTranscriptReplica;
  let prepBytes = 0;
  const installs: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => 4,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(page.throughSequence),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async () => {
            const gate = deferred<void>();
            fetches.push(gate);
            await gate.promise;
            return transcriptPage('older', 4);
          },
          async close() {
            events.end();
          },
        }),
    },
    sessionId: 'session-1',
    transcriptReplicaOptions: {
      accountPreparationBytes: (deltaBytes) => {
        prepBytes += deltaBytes;
      },
    },
    prepareActivation: async (subscription) => {
      replica = subscription.replica;
      return () => {};
    },
    installReseededReplica: (replica) => installs.push(replica),
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
  const first = owner.reseedTranscriptReplica();
  const second = owner.reseedTranscriptReplica();
  await pollFor(() => fetches.length === 2);
  fetches[0]!.resolve(undefined);
  fetches[1]!.resolve(undefined);

  await Promise.all([first, second]);
  assert.equal(installs.length, 1);
  // The loser is closed, not installed: only the winner's resident bytes stay
  // accounted.
  assert.equal(prepBytes, installs[0]!.residentBytes);
  await owner.close();
});

test('a reseed committing inside recovery teardown loses the swap', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  const reseedFetch = deferred<void>();
  const handleClose = deferred<void>();
  let closeStarted = false;
  let opens = 0;
  const replicas: DesktopTranscriptReplica[] = [];
  const installs: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        const events = first ? firstEvents : secondEvents;
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
            if (first) {
              closeStarted = true;
              await handleClose.promise;
            }
            events.end();
          },
        });
      },
    },
    sessionId: 'session-1',
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    installReseededReplica: (replica) => installs.push(replica),
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
  // The failed attempt is already detached while its close handshake is still
  // in flight: a reseed committing inside this window must lose, not swap a
  // replica onto the corpse.
  await pollFor(() => closeStarted);
  reseedFetch.resolve(undefined);

  // The losing reseed rides out the in-flight recovery instead of returning
  // while state still points at the closed replica — it stays pending until
  // the failed handle's close completes and the replacement is installed.
  let loserSettled = false;
  void reseeding.finally(() => {
    loserSettled = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(loserSettled, false);
  handleClose.resolve(undefined);
  await reseeding;
  assert.equal(installs.length, 0);
  await pollFor(() => opens === 2);
  await owner.waitUntilReady();
  assert.equal(replicas.length, 2);
  await owner.close();
});

test('a losing reseed propagates the recovery terminal failure', async () => {
  const firstEvents = new AsyncFrameQueue();
  const reseedFetch = deferred<void>();
  const handleClose = deferred<void>();
  let closeStarted = false;
  let opens = 0;
  const injected = new Error('openSession exploded');
  const replicas: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        if (opens === 2) throw injected;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: firstEvents,
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
            closeStarted = true;
            await handleClose.promise;
            firstEvents.end();
          },
        });
      },
    },
    sessionId: 'session-1',
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    installReseededReplica: () => {},
    acceptFrame: () => {},
    recoveryStarted: () => {},
    recoveryCompleted: () => {},
    recoveryFailed: () => {},
    terminalFailure: () => {},
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
  await pollFor(() => closeStarted);
  reseedFetch.resolve(undefined);
  handleClose.resolve(undefined);

  // The loser waits out the in-flight recovery; when that recovery ends
  // terminally, the caller learns the truth instead of getting undefined.
  await assert.rejects(reseeding, injected);
  await owner.close();
});

test('a reseed masked by the subscription close classifies by its recorded reason', async () => {
  let opens = 0;
  let terminal: Error | undefined;
  const replicas: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: new AsyncFrameQueue(),
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => 2,
          // The subscription already closed for a slow consumer, but a
          // transcript read that races its death only sees the dead-state mask.
          deathCause: first
            ? () =>
                new RuntimeHostSubscriptionError(
                  'slow_consumer',
                  'Runtime Host Session subscription closed for a slow consumer',
                )
            : undefined,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(page.throughSequence),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: first
            ? async () => {
                throw new RuntimeHostSubscriptionError(
                  'connection_closed',
                  'Session subscription closed during transcript loading',
                );
              }
            : undefined,
          async close() {},
        });
      },
    },
    sessionId: 'session-1',
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    installReseededReplica: () => {},
    acceptFrame: () => {},
    recoveryStarted: () => {},
    recoveryCompleted: () => {},
    recoveryFailed: () => {},
    terminalFailure: (error) => {
      terminal = error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  replicas[0]!.discard();
  await owner.reseedTranscriptReplica();
  await pollFor(() => opens === 2);
  await owner.waitUntilReady();
  assert.equal(terminal, undefined);
  assert.equal(replicas.length, 2);
  await owner.close();
});

test('a reseed masked by the subscription close preserves a terminal removal', async () => {
  let terminal: Error | undefined;
  const replicas: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events: new AsyncFrameQueue(),
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => 2,
          deathCause: () => new SessionRemovedSubscriptionError('session removed'),
          loadTranscriptPage: async () => {
            throw new RuntimeHostSubscriptionError(
              'connection_closed',
              'Session subscription closed during transcript loading',
            );
          },
          async close() {},
        }),
    },
    sessionId: 'session-1',
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    installReseededReplica: () => {},
    acceptFrame: () => {},
    recoveryStarted: () => {},
    recoveryCompleted: () => {},
    recoveryFailed: () => {},
    terminalFailure: (error) => {
      terminal = error;
    },
  });
  owner.start();
  await owner.waitUntilReady();

  replicas[0]!.discard();
  await owner.reseedTranscriptReplica();
  assert.ok(terminal instanceof SessionRemovedSubscriptionError);
  await owner.close();
});

test('closes the orphan replica when install throws', async () => {
  const events = new AsyncFrameQueue();
  let replica!: DesktopTranscriptReplica;
  let prepBytes = 0;
  const installs: DesktopTranscriptReplica[] = [];
  const injected = new Error('install failed');
  let failInstall = true;
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () =>
        runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => 2,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(page.throughSequence),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async (input) =>
            transcriptPage(input.direction, input.throughSequence ?? 2),
          async close() {
            events.end();
          },
        }),
    },
    sessionId: 'session-1',
    transcriptReplicaOptions: {
      accountPreparationBytes: (deltaBytes) => {
        prepBytes += deltaBytes;
      },
    },
    prepareActivation: async (subscription) => {
      replica = subscription.replica;
      return () => {};
    },
    installReseededReplica: (reseeded) => {
      installs.push(reseeded);
      if (failInstall) throw injected;
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
  await assert.rejects(
    owner.reseedTranscriptReplica(),
    (error) => error === injected,
  );
  // The evicted replica is untouched and the orphan is closed: it still
  // reports evicted rather than closed, and its bytes are released.
  assert.throws(() => replica.messages(), /was evicted/);
  assert.equal(prepBytes, 0);
  assert.equal(installs.length, 1);

  failInstall = false;
  await owner.reseedTranscriptReplica();
  assert.equal(installs.length, 2);
  await owner.close();
});

test('routes a post-commit catch-up failure through attempt recovery', async () => {
  const firstEvents = new AsyncFrameQueue();
  const secondEvents = new AsyncFrameQueue();
  let watermark = 2;
  let opens = 0;
  let pageReads = 0;
  const replicas: DesktopTranscriptReplica[] = [];
  const installs: DesktopTranscriptReplica[] = [];
  const owner = new RuntimeHostSessionSubscriptionOwner({
    client: {
      openSession: async () => {
        opens += 1;
        const first = opens === 1;
        const events = first ? firstEvents : secondEvents;
        return runtimeHostSessionFixture({
          snapshot: continuitySnapshot(),
          events,
          transcriptBootstrap: { durable: transcriptPage('older', 2) },
          transcriptWatermark: () => watermark,
          decodeTranscriptPage: async (page) => ({
            messages: rowsThrough(page.throughSequence),
            nextCursor: page.nextCursor,
          }),
          loadTranscriptPage: async (input) => {
            pageReads += 1;
            if (first && pageReads === 2) {
              throw new RuntimeHostOperationError(
                'session.transcript.page',
                'not_found',
                'subscription transcript context was lost',
              );
            }
            return transcriptPage(input.direction, input.throughSequence ?? 2);
          },
          async close() {
            events.end();
          },
        });
      },
    },
    sessionId: 'session-1',
    prepareActivation: async (subscription) => {
      replicas.push(subscription.replica);
      return () => {};
    },
    installReseededReplica: (replica) => {
      installs.push(replica);
      // A row committed between the reseed's fetch and this commit: the
      // owner's post-commit catch-up reads it and hits the dead context.
      watermark = 3;
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
  await owner.reseedTranscriptReplica();
  assert.equal(installs.length, 1);

  // The committed replica's catch-up hit the dead transcript context; the
  // owner recovers the subscription instead of leaving the failure latched.
  await pollFor(() => opens === 2);
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
