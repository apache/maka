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

import type { StoredMessage } from '@maka/core/session';
import type { DecodedSessionTranscriptPage } from '@maka/runtime-host/client';
import {
  SESSION_CONTINUITY_SCHEMA_VERSION,
  type SessionAssistantStreamIdentity,
  type SessionContinuitySnapshot,
  type SessionTranscriptPage,
  type SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostSession } from '../runtime-host-client.js';

export function runtimeHostSessionFixture(input: {
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams?: readonly SessionAssistantStreamIdentity[];
  readonly transcript?: Promise<StoredMessage[]>;
  readonly events?: AsyncIterable<SubscriptionFrame>;
  readonly transcriptBootstrap?: DesktopRuntimeHostSession['transcriptBootstrap'];
  transcriptWatermark?: () => number | null;
  deathCause?: () => Error | undefined;
  decodeTranscriptPage?: DesktopRuntimeHostSession['decodeTranscriptPage'];
  loadTranscriptPage?: DesktopRuntimeHostSession['loadTranscriptPage'];
  ready?: DesktopRuntimeHostSession['ready'];
  close(): Promise<void>;
}): DesktopRuntimeHostSession {
  const sessionId = input.snapshot.session.sessionId;
  const transcript = input.transcript ?? Promise.resolve([]);
  const events = input.events ?? { async *[Symbol.asyncIterator]() {} };
  const transcriptBootstrap = input.transcriptBootstrap ?? {
    throughSequence: null,
    durable: emptyPage(sessionId),
  };
  // The Host holds a subscription's frames until the subscriber declares
  // readiness, so a fixture that hands them over earlier would let an ordering
  // bug pass.
  let releaseFrames = (): void => undefined;
  const readyGate = new Promise<void>((resolve) => {
    releaseFrames = resolve;
  });
  let framesReady = false;
  void readyGate.then(() => {
    framesReady = true;
  });
  let transcriptWatermark = transcriptBootstrap.durable.throughSequence;
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    snapshot: input.snapshot,
    activeAssistantStreams: input.activeAssistantStreams ?? [],
    transcriptBootstrap,
    get transcriptWatermark() {
      return input.transcriptWatermark ? input.transcriptWatermark() : transcriptWatermark;
    },
    get deathCause() {
      return input.deathCause?.();
    },
    events: {
      [Symbol.asyncIterator]() {
        const iterator = events[Symbol.asyncIterator]();
        return {
          next() {
            const result = framesReady ? iterator.next() : readyGate.then(() => iterator.next());
            // Tapping the settled result keeps the watermark ahead of the
            // consumer's acceptFrame without adding a hop to its await chain.
            void result.then((settled) => {
              if (!settled.done && settled.value.kind === 'subscription.transcript_advanced') {
                transcriptWatermark = settled.value.throughSequence;
              }
            }, () => {});
            return result;
          },
          return: iterator.return?.bind(iterator),
          throw: iterator.throw?.bind(iterator),
        };
      },
    },
    loadTranscript: () => transcript,
    decodeTranscriptPage: input.decodeTranscriptPage ??
      (async (page): Promise<DecodedSessionTranscriptPage<StoredMessage>> => ({
        messages: page === transcriptBootstrap.durable
          ? (await transcript).map((message, identity) => ({ identity, message }))
          : [],
        nextCursor: null,
      })),
    loadTranscriptPage: input.loadTranscriptPage ??
      (async () => emptyPage(sessionId)),
    ready: async () => {
      releaseFrames();
      await input.ready?.();
    },
    close: input.close,
  };
}

function emptyPage(sessionId: string): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId,
    direction: 'older',
    throughSequence: null,
    rawBytes: 0,
    fragments: [],
    nextCursor: null,
    endsAtTurnBoundary: true,
  };
}

export class AsyncFrameQueue implements AsyncIterable<SubscriptionFrame> {
  readonly #frames: SubscriptionFrame[] = [];
  readonly #waiters: Array<(result: IteratorResult<SubscriptionFrame>) => void> = [];
  nextCount = 0;
  #ended = false;

  push(frame: SubscriptionFrame): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: frame, done: false });
    else this.#frames.push(frame);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SubscriptionFrame> {
    return {
      next: () => {
        this.nextCount += 1;
        const frame = this.#frames.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: () => {
        this.#ended = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export function continuitySnapshot(
  overrides: Partial<SessionContinuitySnapshot> = {},
): SessionContinuitySnapshot {
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
    rootTurn: {
      sessionId: 'session-1',
      turnId: 'turn-1',
      runId: 'run-1',
      status: 'running',
    },
    goal: null,
    queue: {
      hostEpoch: 'host-1',
      queueRevision: 0,
      steering: [],
      followup: [],
    },
    interactions: { pending: [] },
    ...overrides,
  };
}

export function transcriptPage(
  direction: 'older' | 'newer',
  throughSequence: number | null,
): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId: 'session-1',
    direction,
    throughSequence,
    rawBytes: 1,
    fragments: [],
    nextCursor: null,
    endsAtTurnBoundary: true,
  };
}
