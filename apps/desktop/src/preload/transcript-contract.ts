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
export const DESKTOP_TRANSCRIPT_TAIL_MAX_BYTES = 512 * 1024;
/** Turns the Main tail cache keeps for the projector and for tail-only consumers. */
export const DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS = 10;
export const DESKTOP_TRANSCRIPT_MESSAGE_MAX_BYTES = 16 * 1024 * 1024;
export const DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Projected message bytes of whole Turns one history read delivers: the first read and each "load earlier". */
export const DESKTOP_TRANSCRIPT_HISTORY_MAX_BYTES = 64 * 1024 * 1024;

export interface DesktopTranscriptFragment {
  readonly sequence: number;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly data: Uint8Array;
}

/**
 * Every batch carries what the rows in it are anchored on, because adjacency
 * cannot be read off durable sequence numbers: they advance by a stride, so
 * only the Host read that produced a row proves what it is contiguous with.
 *
 * - `reset` starts a replacement of everything the consumer holds.
 * - `earlierThan` starts earlier history that ends just before that sequence.
 * - `coversFrom` names the watermark a tail change read forward from.
 *
 * One answer spans batches until `ready`; `hasOlder` is final only there.
 */
export interface DesktopTranscriptBatchPayload {
  readonly earlierThan?: number;
  readonly coversFrom?: number | null;
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly durableThrough: number | null;
  readonly fragments: readonly DesktopTranscriptFragment[];
  readonly hasOlder?: boolean;
  /**
   * Whether the oldest Turn in this answer has all its rows in it. A
   * byte-bounded answer can begin inside a Turn, and no local rule tells the
   * consumer that it did.
   */
  readonly beginsAtTurnBoundary?: boolean;
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

/**
 * Tail-only consumers get the Main tail cache; history consumers get the
 * newest whole Turns up to the history budget and may ask for earlier ones.
 */
export type DesktopTranscriptOpenMode = 'tail' | 'history';

/**
 * The Renderer reporting that it now holds every durable row through
 * `through`. Main cannot derive this: a consumer only proves the Session is
 * open, and a change still assembling in the Renderer moves no reader.
 */
export interface DesktopTranscriptTailAcknowledgement {
  readonly consumerId: string;
  readonly sessionId: string;
  readonly hostEpoch: string;
  readonly through: number;
}

export interface DesktopTranscriptHandle extends DesktopTranscriptOpenResult {
  acknowledgeTail(through: number): Promise<void>;
  /** One budget of earlier history, continuing in the same answer down to `throughSequence`. */
  loadEarlier(throughSequence?: number): Promise<void>;
  close(): Promise<void>;
}

export function assertDesktopTranscriptBatch(value: unknown): DesktopTranscriptBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Desktop transcript batch');
  }
  const batch = value as Record<string, unknown>;
  if (
    typeof batch.sessionId !== 'string' ||
    (batch.earlierThan !== undefined && !isSequence(batch.earlierThan)) ||
    (batch.coversFrom !== undefined && batch.coversFrom !== null && !isSequence(batch.coversFrom)) ||
    !isSequence(batch.deliverySequence) ||
    typeof batch.generation !== 'string' ||
    typeof batch.hostEpoch !== 'string' ||
    (batch.durableThrough !== null && !isSequence(batch.durableThrough)) ||
    !Array.isArray(batch.fragments) ||
    (batch.hasOlder !== undefined && typeof batch.hasOlder !== 'boolean') ||
    (batch.beginsAtTurnBoundary !== undefined &&
      typeof batch.beginsAtTurnBoundary !== 'boolean') ||
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
      !isSequence(fragment.sequence) ||
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
