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

export const DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES = 128 * 1024;
export const DESKTOP_TRANSCRIPT_RANGE_MAX_BYTES = 512 * 1024;
export const DESKTOP_TRANSCRIPT_SESSION_CACHE_MAX_BYTES = 20 * 1024 * 1024;
export const DESKTOP_TRANSCRIPT_OVERLAY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
export const DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;

export interface DesktopTranscriptFragment {
  readonly source: 'durable' | 'overlay';
  readonly identity: number | string;
  readonly order: number | null;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly data: Uint8Array;
}

export interface DesktopTranscriptBatchPayload {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly durableThrough: number | null;
  readonly fragments: readonly DesktopTranscriptFragment[];
  readonly evictedDurableSequences: readonly number[];
  readonly completedOverlayMessageIds: readonly string[];
  readonly hasOlder: boolean;
  readonly hasNewer: boolean;
  readonly reset: boolean;
  readonly ready: boolean;
}

export interface DesktopTranscriptBatch extends DesktopTranscriptBatchPayload {
  readonly deliverySequence: number;
}

export interface DesktopTranscriptOpenResult {
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly readThroughMessageId: string | null;
}

export interface DesktopTranscriptRangeRequest {
  readonly consumerId: string;
  readonly generation: string;
  readonly anchorSequence: number | null;
  readonly maxBytes: number;
}

export interface DesktopTranscriptHandle extends DesktopTranscriptOpenResult {
  loadBefore(anchorSequence: number | null, maxBytes?: number): Promise<void>;
  loadAround(sequence: number, maxBytes?: number): Promise<void>;
  close(): Promise<void>;
}

export function assertDesktopTranscriptBatch(value: unknown): DesktopTranscriptBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Desktop transcript batch');
  }
  const batch = value as Record<string, unknown>;
  if (
    typeof batch.sessionId !== 'string' ||
    !isSequence(batch.deliverySequence) ||
    typeof batch.generation !== 'string' ||
    typeof batch.hostEpoch !== 'string' ||
    (batch.durableThrough !== null && !isSequence(batch.durableThrough)) ||
    !Array.isArray(batch.fragments) ||
    !Array.isArray(batch.evictedDurableSequences) ||
    !batch.evictedDurableSequences.every(isSequence) ||
    batch.evictedDurableSequences.length > 256 ||
    !Array.isArray(batch.completedOverlayMessageIds) ||
    !batch.completedOverlayMessageIds.every(
      (messageId) => typeof messageId === 'string' && messageId.length > 0 && messageId.length <= 256,
    ) ||
    batch.completedOverlayMessageIds.length > 256 ||
    typeof batch.hasOlder !== 'boolean' ||
    typeof batch.hasNewer !== 'boolean' ||
    typeof batch.reset !== 'boolean' ||
    typeof batch.ready !== 'boolean'
  ) {
    throw new Error('Invalid Desktop transcript batch');
  }
  let rawBytes = 0;
  for (const value of batch.fragments) {
    const fragment = value as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (fragment.source !== 'durable' && fragment.source !== 'overlay') ||
      (fragment.source === 'durable'
        ? !isSequence(fragment.identity)
        : typeof fragment.identity !== 'string' || fragment.identity.length === 0) ||
      (fragment.source === 'overlay'
        ? !isSequence(fragment.order)
        : fragment.order !== null) ||
      !isSequence(fragment.byteOffset) ||
      !isSequence(fragment.totalBytes) ||
      (fragment.totalBytes as number) < 1 ||
      !(fragment.data instanceof Uint8Array) ||
      fragment.data.byteLength > DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES
    ) {
      throw new Error('Invalid Desktop transcript fragment');
    }
    const bytes = fragment.data.byteLength;
    if (
      bytes < 1 ||
      (fragment.byteOffset as number) + bytes > (fragment.totalBytes as number)
    ) {
      throw new Error('Invalid Desktop transcript fragment bounds');
    }
    rawBytes += bytes;
  }
  if (rawBytes > DESKTOP_TRANSCRIPT_FRAGMENT_MAX_BYTES) {
    throw new Error('Desktop transcript batch exceeds its byte limit');
  }
  return value as DesktopTranscriptBatch;
}

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
