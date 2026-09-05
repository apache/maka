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
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  type DesktopTranscriptBatchPayload,
  type DesktopTranscriptFragment,
} from '../preload/transcript-contract.js';
import type {
  DesktopSequencedTranscriptMessage,
  DesktopTranscriptReplicaChange,
  DesktopTranscriptReplicaSnapshot,
} from './desktop-transcript-replica.js';

interface TranscriptBatchIdentity {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
}

interface TranscriptBatchContent {
  readonly durableThrough: number | null;
  readonly durable: readonly DesktopSequencedTranscriptMessage[];
  readonly overlay: readonly StoredMessage[];
  readonly evictedDurableSequences: readonly number[];
  readonly completedOverlayMessageIds: readonly string[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly reset: boolean;
}

export function encodeDesktopTranscriptSnapshot(
  snapshot: DesktopTranscriptReplicaSnapshot,
): Iterable<DesktopTranscriptBatchPayload> {
  return encodeDesktopTranscriptBatches(snapshot, {
    durableThrough: snapshot.durableThrough,
    durable: snapshot.durable,
    overlay: snapshot.overlay,
    evictedDurableSequences: [],
    completedOverlayMessageIds: [],
    hasOlder: snapshot.hasOlder,
    hasNewer: snapshot.hasNewer,
    reset: true,
  });
}

export function encodeDesktopTranscriptChange(
  identity: TranscriptBatchIdentity,
  change: DesktopTranscriptReplicaChange,
): Iterable<DesktopTranscriptBatchPayload> {
  return encodeDesktopTranscriptBatches(identity, {
    durableThrough: change.durableThrough,
    durable: change.durableUpserts,
    overlay: [],
    evictedDurableSequences: change.evictedDurableSequences,
    completedOverlayMessageIds: change.completedOverlayMessageIds,
    hasOlder: change.hasOlder,
    hasNewer: change.hasNewer,
    reset: false,
  });
}

function* encodeDesktopTranscriptBatches(
  identity: TranscriptBatchIdentity,
  content: TranscriptBatchContent,
): Iterable<DesktopTranscriptBatchPayload> {
  const fragments = encodeMessages(content);
  let fragment = fragments.next();
  let evictedIndex = 0;
  let completedIndex = 0;
  let first = true;
  while (
    !fragment.done ||
    evictedIndex < content.evictedDurableSequences.length ||
    completedIndex < content.completedOverlayMessageIds.length ||
    first
  ) {
    const batchFragments: DesktopTranscriptFragment[] = [];
    let rawBytes = 0;
    while (!fragment.done) {
      const bytes = fragment.value.data.byteLength;
      if (batchFragments.length > 0 && rawBytes + bytes > DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES) {
        break;
      }
      batchFragments.push(fragment.value);
      rawBytes += bytes;
      fragment = fragments.next();
    }
    const evictedDurableSequences = content.evictedDurableSequences.slice(
      evictedIndex,
      evictedIndex + 256,
    );
    evictedIndex += evictedDurableSequences.length;
    const completedOverlayMessageIds: string[] = [];
    let identityBytes = 0;
    while (completedIndex < content.completedOverlayMessageIds.length) {
      const messageId = content.completedOverlayMessageIds[completedIndex]!;
      const bytes = Buffer.byteLength(messageId, 'utf8');
      if (
        completedOverlayMessageIds.length >= 256 ||
        (completedOverlayMessageIds.length > 0 &&
          identityBytes + bytes > DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES)
      ) {
        break;
      }
      completedOverlayMessageIds.push(messageId);
      identityBytes += bytes;
      completedIndex += 1;
    }
    const ready =
      fragment.done === true &&
      evictedIndex === content.evictedDurableSequences.length &&
      completedIndex === content.completedOverlayMessageIds.length;
    yield {
      ...identity,
      durableThrough: content.durableThrough,
      fragments: batchFragments,
      evictedDurableSequences,
      completedOverlayMessageIds,
      hasOlder: content.hasOlder,
      hasNewer: content.hasNewer,
      reset: content.reset && first,
      ready,
    };
    first = false;
  }
}

function* encodeMessages(content: TranscriptBatchContent): Generator<DesktopTranscriptFragment> {
  for (const entry of content.durable) {
    yield* encodeMessage('durable', entry.sequence, null, entry.message);
  }
  for (const [order, message] of content.overlay.entries()) {
    yield* encodeMessage('overlay', message.id, order, message);
  }
}

function* encodeMessage(
  source: 'durable' | 'overlay',
  identity: number | string,
  order: number | null,
  message: StoredMessage,
): Generator<DesktopTranscriptFragment> {
  const bytes = Buffer.from(JSON.stringify(message), 'utf8');
  for (let byteOffset = 0; byteOffset < bytes.byteLength; ) {
    const end = Math.min(byteOffset + DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES, bytes.byteLength);
    yield {
      source,
      identity,
      order,
      byteOffset,
      totalBytes: bytes.byteLength,
      data: Uint8Array.from(bytes.subarray(byteOffset, end)),
    };
    byteOffset = end;
  }
}
