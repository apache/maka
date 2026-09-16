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
  loadTranscriptOverlay?: DesktopRuntimeHostSession['loadTranscriptOverlay'];
  decodeTranscriptPage?: DesktopRuntimeHostSession['decodeTranscriptPage'];
  loadTranscriptPage?: DesktopRuntimeHostSession['loadTranscriptPage'];
  close(): Promise<void>;
}): DesktopRuntimeHostSession {
  const sessionId = input.snapshot.session.sessionId;
  return {
    hostEpoch: 'host-1',
    subscriptionId: `subscription-${sessionId}`,
    snapshot: input.snapshot,
    activeAssistantStreams: input.activeAssistantStreams ?? [],
    transcriptBootstrap: input.transcriptBootstrap ?? {
      throughSequence: null,
      overlayMessageCount: 0,
      durable: emptyPage(sessionId, 'durable'),
      overlay: emptyPage(sessionId, 'overlay'),
    },
    events: input.events,
    loadTranscript: () => input.transcript,
    loadTranscriptOverlay: input.loadTranscriptOverlay ?? (() => input.transcript),
    decodeTranscriptPage: input.decodeTranscriptPage ??
      (async (): Promise<DecodedSessionTranscriptPage<StoredMessage>> => ({
        messages: [],
        nextCursor: null,
      })),
    loadTranscriptPage: input.loadTranscriptPage ??
      (async () => emptyPage(sessionId, 'durable')),
    close: input.close,
  };
}

function emptyPage(sessionId: string, source: 'durable' | 'overlay'): SessionTranscriptPage {
  return {
    kind: 'page',
    sessionId,
    source,
    direction: 'older',
    throughSequence: null,
    rawBytes: 0,
    fragments: [],
    nextCursor: null,
  };
}
