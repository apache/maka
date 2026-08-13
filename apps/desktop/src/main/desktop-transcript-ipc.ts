import type { StoredMessage } from '@maka/core/session';
import {
  DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES,
  type DesktopTranscriptBatch,
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
): DesktopTranscriptBatch[] {
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
): DesktopTranscriptBatch[] {
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

function encodeDesktopTranscriptBatches(
  identity: TranscriptBatchIdentity,
  content: TranscriptBatchContent,
): DesktopTranscriptBatch[] {
  const fragments = [
    ...content.durable.flatMap((entry) =>
      encodeMessage('durable', entry.sequence, null, entry.message),
    ),
    ...content.overlay.flatMap((message, order) =>
      encodeMessage('overlay', message.id, order, message),
    ),
  ];
  const batches: DesktopTranscriptBatch[] = [];
  let fragmentIndex = 0;
  let evictedIndex = 0;
  let completedIndex = 0;
  let first = true;
  while (
    fragmentIndex < fragments.length ||
    evictedIndex < content.evictedDurableSequences.length ||
    completedIndex < content.completedOverlayMessageIds.length ||
    first
  ) {
    const batchFragments: DesktopTranscriptFragment[] = [];
    let rawBytes = 0;
    while (fragmentIndex < fragments.length) {
      const fragment = fragments[fragmentIndex]!;
      const bytes = Buffer.from(fragment.data, 'base64').byteLength;
      if (batchFragments.length > 0 && rawBytes + bytes > DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES) {
        break;
      }
      batchFragments.push(fragment);
      rawBytes += bytes;
      fragmentIndex += 1;
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
      fragmentIndex === fragments.length &&
      evictedIndex === content.evictedDurableSequences.length &&
      completedIndex === content.completedOverlayMessageIds.length;
    batches.push({
      ...identity,
      durableThrough: content.durableThrough,
      fragments: batchFragments,
      evictedDurableSequences,
      completedOverlayMessageIds,
      hasOlder: content.hasOlder,
      hasNewer: content.hasNewer,
      reset: content.reset && first,
      ready,
    });
    first = false;
  }
  return batches;
}

function encodeMessage(
  source: 'durable' | 'overlay',
  identity: number | string,
  order: number | null,
  message: StoredMessage,
): DesktopTranscriptFragment[] {
  const bytes = Buffer.from(JSON.stringify(message), 'utf8');
  const fragments: DesktopTranscriptFragment[] = [];
  for (let byteOffset = 0; byteOffset < bytes.byteLength; ) {
    const end = Math.min(byteOffset + DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES, bytes.byteLength);
    fragments.push({
      source,
      identity,
      order,
      byteOffset,
      totalBytes: bytes.byteLength,
      data: bytes.subarray(byteOffset, end).toString('base64'),
    });
    byteOffset = end;
  }
  return fragments;
}
