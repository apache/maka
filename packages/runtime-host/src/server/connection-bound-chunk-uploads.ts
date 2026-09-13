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

export interface ChunkUploadOwner {
  readonly hostEpoch: string;
  readonly connectionId: string;
}

export interface ConnectionBoundChunkUpload<TMetadata> {
  readonly owner: ChunkUploadOwner;
  readonly totalBytes: number;
  readonly metadata: TMetadata;
  readonly bytes: Buffer;
  readonly nextOffset: number;
}

interface MutableChunkUpload<TMetadata> {
  readonly owner: ChunkUploadOwner;
  readonly totalBytes: number;
  readonly metadata: TMetadata;
  readonly bytes: Buffer;
  nextOffset: number;
  touchedAt: number;
}

type OpenResult<TMetadata> =
  | { readonly kind: 'opened'; readonly upload: ConnectionBoundChunkUpload<TMetadata> }
  | { readonly kind: 'owned_existing'; readonly upload: ConnectionBoundChunkUpload<TMetadata> }
  | { readonly kind: 'identity_conflict' }
  | { readonly kind: 'capacity_exhausted' };

type AcceptResult =
  | { readonly kind: 'accepted'; readonly nextOffset: number }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'conflict' };

type ConsumeResult<TMetadata> =
  | { readonly kind: 'taken'; readonly upload: ConnectionBoundChunkUpload<TMetadata> }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'incomplete' };

/** Shared bounded staging for connection-affine chunk protocols. */
export class ConnectionBoundChunkUploads<TMetadata> {
  readonly #uploads = new Map<string, MutableChunkUpload<TMetadata>>();

  constructor(
    private readonly limits: {
      readonly maxActive: number;
      readonly maxStagedBytes: number;
      readonly ttlMs: number;
    },
    private readonly now: () => number = Date.now,
  ) {}

  open(
    key: string,
    owner: ChunkUploadOwner,
    totalBytes: number,
    metadata: TMetadata,
  ): OpenResult<TMetadata> {
    this.sweepExpired();
    const existing = this.#uploads.get(key);
    if (existing) {
      if (!ownedBy(existing, owner)) return { kind: 'identity_conflict' };
      return { kind: 'owned_existing', upload: snapshot(existing) };
    }
    if (
      this.#uploads.size >= this.limits.maxActive ||
      this.#stagedBytes() + totalBytes > this.limits.maxStagedBytes
    ) {
      return { kind: 'capacity_exhausted' };
    }
    const upload: MutableChunkUpload<TMetadata> = {
      owner: { hostEpoch: owner.hostEpoch, connectionId: owner.connectionId },
      totalBytes,
      metadata,
      bytes: Buffer.alloc(totalBytes),
      nextOffset: 0,
      touchedAt: this.now(),
    };
    this.#uploads.set(key, upload);
    return { kind: 'opened', upload: snapshot(upload) };
  }

  accept(key: string, owner: ChunkUploadOwner, offset: number, chunk: Buffer): AcceptResult {
    this.sweepExpired();
    const upload = this.#owned(key, owner);
    if (!upload) return { kind: 'not_found' };
    const end = offset + chunk.byteLength;
    if (end > upload.totalBytes || offset > upload.nextOffset) return { kind: 'conflict' };
    if (offset < upload.nextOffset) {
      if (end > upload.nextOffset || !upload.bytes.subarray(offset, end).equals(chunk)) {
        return { kind: 'conflict' };
      }
    } else {
      chunk.copy(upload.bytes, offset);
      upload.nextOffset = end;
    }
    upload.touchedAt = this.now();
    return { kind: 'accepted', nextOffset: upload.nextOffset };
  }

  consumeComplete(key: string, owner: ChunkUploadOwner): ConsumeResult<TMetadata> {
    this.sweepExpired();
    const upload = this.#owned(key, owner);
    if (!upload) return { kind: 'not_found' };
    if (upload.nextOffset !== upload.totalBytes) return { kind: 'incomplete' };
    this.#uploads.delete(key);
    return { kind: 'taken', upload: snapshot(upload) };
  }

  refreshOwned(
    key: string,
    owner: ChunkUploadOwner,
  ): ConnectionBoundChunkUpload<TMetadata> | undefined {
    this.sweepExpired();
    const upload = this.#owned(key, owner);
    if (!upload) return undefined;
    upload.touchedAt = this.now();
    return snapshot(upload);
  }

  abort(key: string, owner: ChunkUploadOwner): void {
    if (this.#owned(key, owner)) this.#uploads.delete(key);
  }

  releaseConnection(connectionId: string): void {
    for (const [key, upload] of this.#uploads) {
      if (upload.owner.connectionId === connectionId) this.#uploads.delete(key);
    }
  }

  clear(): void {
    this.#uploads.clear();
  }

  sweepExpired(): void {
    const cutoff = this.now() - this.limits.ttlMs;
    for (const [key, upload] of this.#uploads) {
      if (upload.touchedAt <= cutoff) this.#uploads.delete(key);
    }
  }

  #owned(key: string, owner: ChunkUploadOwner): MutableChunkUpload<TMetadata> | undefined {
    const upload = this.#uploads.get(key);
    return upload && ownedBy(upload, owner) ? upload : undefined;
  }

  #stagedBytes(): number {
    let total = 0;
    for (const upload of this.#uploads.values()) total += upload.totalBytes;
    return total;
  }
}

function ownedBy<TMetadata>(
  upload: MutableChunkUpload<TMetadata>,
  owner: ChunkUploadOwner,
): boolean {
  return (
    upload.owner.hostEpoch === owner.hostEpoch && upload.owner.connectionId === owner.connectionId
  );
}

function snapshot<TMetadata>(
  upload: MutableChunkUpload<TMetadata>,
): ConnectionBoundChunkUpload<TMetadata> {
  return {
    owner: upload.owner,
    totalBytes: upload.totalBytes,
    metadata: upload.metadata,
    bytes: upload.bytes,
    nextOffset: upload.nextOffset,
  };
}
