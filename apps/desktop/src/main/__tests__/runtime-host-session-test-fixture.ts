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
import type {
  SessionAssistantStreamIdentity,
  SessionContinuitySnapshot,
  SessionTranscriptPage,
  SubscriptionFrame,
} from '@maka/runtime-host/protocol';
import type { DesktopRuntimeHostSession } from '../runtime-host-client.js';

export function runtimeHostSessionFixture(input: {
  readonly snapshot: SessionContinuitySnapshot;
  readonly activeAssistantStreams?: readonly SessionAssistantStreamIdentity[];
  readonly transcript: Promise<StoredMessage[]>;
  readonly events: AsyncIterable<SubscriptionFrame>;
  readonly transcriptBootstrap?: DesktopRuntimeHostSession['transcriptBootstrap'];
  decodeTranscriptPage?: DesktopRuntimeHostSession['decodeTranscriptPage'];
  loadTranscriptPage?: DesktopRuntimeHostSession['loadTranscriptPage'];
  ready?: DesktopRuntimeHostSession['ready'];
  close(): Promise<void>;
}): DesktopRuntimeHostSession {
  const sessionId = input.snapshot.session.sessionId;
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
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    snapshot: input.snapshot,
    activeAssistantStreams: input.activeAssistantStreams ?? [],
    transcriptBootstrap,
    events: (async function* () {
      await readyGate;
      yield* input.events;
    })(),
    loadTranscript: () => input.transcript,
    decodeTranscriptPage: input.decodeTranscriptPage ??
      (async (page): Promise<DecodedSessionTranscriptPage<StoredMessage>> => ({
        messages: page === transcriptBootstrap.durable
          ? (await input.transcript).map((message, identity) => ({ identity, message }))
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
    rangeBoundarySequence: null,
    protectedTurnSequence: null,
    nextCursor: null,
  };
}
