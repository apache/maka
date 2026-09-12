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
/** Turns the Main tail cache keeps for the projector and for the tail the Renderer opens with. */
export const DESKTOP_TRANSCRIPT_TAIL_MAX_TURNS = 10;
export const DESKTOP_TRANSCRIPT_OVERLAY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Main rejects a read whose Host epoch moved under it. `ipcRenderer.invoke`
 * carries nothing across but the Error's message, so both sides name the
 * rejection by this code rather than by matching prose.
 */
export const DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED_CODE = 'DESKTOP_TRANSCRIPT_HOST_EPOCH_CHANGED';
export const DESKTOP_TRANSCRIPT_GLOBAL_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export interface DesktopTranscriptFragment {
  readonly source: 'durable' | 'overlay';
  readonly identity: number | string;
  readonly order: number | null;
  readonly byteOffset: number;
  readonly totalBytes: number;
  readonly data: Uint8Array;
}

/**
 * Every batch carries what the rows in it are anchored on, because adjacency
 * cannot be read off durable sequence numbers: they advance by a stride, so
 * only the Host read that produced a row proves what it is contiguous with.
 *
 * - `extends` names the edge a page read started from.
 * - `coversFrom` names the watermark a tail change read forward from; absent
 *   means the batch claims no contiguity and only moves the watermark.
 * - `navigation` appears on the reset answering `loadAround` / `loadLatest`,
 *   which replaces the window outright instead of splicing onto it.
 */
export interface DesktopTranscriptBatchPayload {
  readonly navigation?: number;
  readonly extends?: DesktopTranscriptExtension;
  readonly coversFrom?: number | null;
  readonly sessionId: string;
  readonly generation: string;
  readonly hostEpoch: string;
  readonly durableThrough: number | null;
  readonly fragments: readonly DesktopTranscriptFragment[];
  readonly hasOlder?: boolean;
  readonly hasNewer?: boolean;
  readonly reset: boolean;
  readonly ready: boolean;
}

export interface DesktopTranscriptExtension {
  readonly direction: 'older' | 'newer';
  readonly anchor: number | null;
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
  readonly navigation: number;
  readonly consumerId: string;
  readonly sessionId: string;
  readonly hostEpoch: string;
  readonly anchorSequence: number | null;
  readonly maxBytes: number;
}

/**
 * The Renderer reporting that its window now holds every durable row through
 * `through`. Main cannot derive this: a consumer only proves the Session is
 * open, and a tail change a parked window refuses moves no window.
 */
export interface DesktopTranscriptTailAcknowledgement {
  readonly consumerId: string;
  readonly sessionId: string;
  readonly hostEpoch: string;
  readonly through: number;
}

export interface DesktopTranscriptHandle extends DesktopTranscriptOpenResult {
  acknowledgeTail(through: number): Promise<void>;
  loadBefore(anchorSequence: number | null, maxBytes: number, navigation: number): Promise<void>;
  loadAfter(anchorSequence: number | null, maxBytes: number, navigation: number): Promise<void>;
  loadAround(sequence: number, maxBytes: number, navigation: number): Promise<void>;
  loadLatest(navigation: number): Promise<void>;
  close(): Promise<void>;
}

export function assertDesktopTranscriptBatch(value: unknown): DesktopTranscriptBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Desktop transcript batch');
  }
  const batch = value as Record<string, unknown>;
  if (
    typeof batch.sessionId !== 'string' ||
    (batch.navigation !== undefined && !isSequence(batch.navigation)) ||
    !isExtension(batch.extends) ||
    (batch.coversFrom !== undefined && batch.coversFrom !== null && !isSequence(batch.coversFrom)) ||
    !isSequence(batch.deliverySequence) ||
    typeof batch.generation !== 'string' ||
    typeof batch.hostEpoch !== 'string' ||
    (batch.durableThrough !== null && !isSequence(batch.durableThrough)) ||
    !Array.isArray(batch.fragments) ||
    (batch.hasOlder !== undefined && typeof batch.hasOlder !== 'boolean') ||
    (batch.hasNewer !== undefined && typeof batch.hasNewer !== 'boolean') ||
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

function isExtension(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const extension = value as Record<string, unknown>;
  return (extension.direction === 'older' || extension.direction === 'newer') &&
    (extension.anchor === null || isSequence(extension.anchor));
}
