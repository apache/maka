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

export interface SessionContextRef {
  readonly kind: 'session_context';
  readonly sessionId: string;
  readonly refId: string;
}

export type ContextOffloadOwner =
  | {
      readonly kind: 'read_image_snapshot';
      readonly ownerId: string;
    }
  | {
      readonly kind: 'tool_result_archive';
      readonly ownerId: string;
    };

export interface ContextOffloadRecord {
  readonly refId: string;
  readonly sessionId: string;
  readonly owner: ContextOffloadOwner;
  /** Canonical lowercase SHA-256. */
  readonly blobId: string;
  readonly sizeBytes: number;
  readonly mediaType: string;
  readonly createdAt: number;
}

export interface ContextOffloadLimits {
  /** Whole-object byte limit selected by each typed owner contract. */
  readonly ownerMaxBytes: Readonly<Record<ContextOffloadOwner['kind'], number>>;
  /** Logical bytes referenced by one Session, counting shared blobs once per reference. */
  readonly sessionLogicalBytes: number;
  /** Physical bytes stored by the workspace, counting each content-addressed blob once. */
  readonly workspacePhysicalBytes: number;
}

export type ContextOffloadPutFailureReason =
  | 'too_large'
  | 'session_quota_exceeded'
  | 'workspace_quota_exceeded'
  | 'identity_conflict'
  | 'unavailable';

export type ContextOffloadPutResult =
  | { readonly ok: true; readonly record: ContextOffloadRecord }
  | {
      readonly ok: false;
      readonly reason: ContextOffloadPutFailureReason;
    };

export type ContextOffloadReadResult =
  | {
      readonly ok: true;
      readonly record: ContextOffloadRecord;
      readonly bytes: Uint8Array;
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'session_mismatch' | 'too_large' | 'corrupt' | 'unavailable';
    };

export interface ContextOffloadUsage {
  readonly references: number;
  readonly logicalBytes: number;
  readonly physicalBytes: number;
}

export type ContextOffloadCopyResult =
  | {
      readonly ok: true;
      readonly copied: readonly {
        readonly sourceRefId: string;
        readonly targetRefId: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly reason: 'not_found' | 'session_quota_exceeded' | 'identity_conflict' | 'unavailable';
    };

export interface ContextOffloadRetirementResult {
  readonly releasedReferences: number;
  readonly releasedLogicalBytes: number;
}

export interface ContextOffloadGarbageCollectionResult {
  readonly deletedBlobs: number;
  readonly deletedBytes: number;
  readonly hasMore: boolean;
}

export class ReadImageSnapshotStoreError extends Error {
  constructor(readonly reason: ContextOffloadPutFailureReason) {
    super(`Read image snapshot storage failed: ${reason}`);
    this.name = 'ReadImageSnapshotStoreError';
  }
}

export interface ReadImageSnapshotStore {
  snapshot(input: {
    /** Stable identity of the Read result within its Session. */
    readonly ownerId: string;
    readonly bytes: Uint8Array;
    readonly mimeType: string;
  }): Promise<SessionContextRef>;

  read(input: SessionContextRef): Promise<ContextOffloadReadResult>;
}

/**
 * Storage contract for capped, whole-object Agent context offload.
 *
 * The asynchronous boundary is intentional even when the first implementation
 * uses DatabaseSync, so callers do not depend on the execution substrate.
 */
export interface ContextOffloadStore {
  put(input: {
    readonly sessionId: string;
    readonly owner: ContextOffloadOwner;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly expectedSha256?: string;
  }): Promise<ContextOffloadPutResult>;

  read(input: {
    readonly sessionId: string;
    readonly refId: string;
    readonly maxBytes: number;
  }): Promise<ContextOffloadReadResult>;

  copyReferences(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly references: readonly {
      readonly sourceRefId: string;
      readonly targetOwner: ContextOffloadOwner;
    }[];
  }): Promise<ContextOffloadCopyResult>;

  releaseReference(input: { readonly sessionId: string; readonly refId: string }): Promise<void>;

  retireSession(sessionId: string): Promise<ContextOffloadRetirementResult>;

  collectGarbage(input: {
    readonly olderThan: number;
    readonly maxBlobs: number;
    readonly maxBytes: number;
  }): Promise<ContextOffloadGarbageCollectionResult>;

  /**
   * Session-scoped reference/logical usage when sessionId is supplied. Physical
   * bytes always describe the workspace because shared bytes have no one owner.
   */
  usage(sessionId?: string): Promise<ContextOffloadUsage>;

  close(): void;
}
