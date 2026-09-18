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
import { deferred, waitFor as pollFor } from '@maka/core/test-only/async-primitives';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionContinuitySnapshot,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import { RuntimeHostSessionSubscriptionOwner } from '../runtime-host-session-subscription-owner.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';

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
          transcript: Promise.resolve([]),
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

function continuitySnapshot(): SessionContinuitySnapshot {
  return {
    schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
    session: {
      sessionId: 'session-1',
      metadataRevision: 1,
      status: 'running',
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
