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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomicFile } from './atomic-file-write.js';
import { readStableBoundedFile } from './stable-storage.js';
import { withProcessLifetimeFileUpdateLock } from './process-lifetime-file-update-lock.js';
import {
  createSessionCheckpointManifestV1,
  encodeSessionCheckpointManifestV1,
  SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE,
  type CommittedSessionRevision,
  type StoredSessionCheckpoint,
} from './session-repository.js';

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface SessionCheckpointBinding {
  readonly makaSessionId: string;
  readonly repositorySessionId: string;
  readonly agentId: string;
}
export type CheckpointPublicationRequest = {
  readonly requestId: string;
  readonly commitId: string;
  readonly confirmationGrantId?: string;
  readonly expectedRevision: string | null;
  readonly snapshotCleanupPending?: true;
  readonly bundleCleanupPending?: true;
} & (
  | { readonly phase: 'capturing' }
  | { readonly phase: 'aborted' }
  | { readonly phase: 'prepared' | 'conflicted'; readonly checkpoint: StoredSessionCheckpoint }
  | {
      readonly phase: 'committed';
      readonly checkpoint: StoredSessionCheckpoint;
      readonly result: CommittedSessionRevision;
    }
);
export interface SessionCheckpointPublicationDocument {
  readonly schemaVersion: 1;
  readonly rootId: string;
  readonly binding: SessionCheckpointBinding;
  requests: CheckpointPublicationRequest[];
}

/**
 * Host operation recovery facts, NOT a second checkpoint Head. The Repository
 * remains the only authority for the current revision. Documents are bounded;
 * receipts are never silently expired to make space.
 */
export async function openSessionCheckpointPublicationStore(input: {
  readonly directory: string;
  readonly rootId: string;
}): Promise<SessionCheckpointPublicationStore> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const authorityPath = join(input.directory, 'authority-v1.json');
  const agentId = await withProcessLifetimeFileUpdateLock(authorityPath, async () => {
    const existing = await readOptional(authorityPath);
    if (existing !== undefined) {
      if (
        !record(existing) ||
        existing.schemaVersion !== 1 ||
        existing.rootId !== input.rootId ||
        !identifier(existing.agentId) ||
        !UUID.test(existing.agentId)
      )
        throw invalid();
      return existing.agentId;
    }
    const agentId = randomUUID();
    await writeDocument(authorityPath, { schemaVersion: 1, rootId: input.rootId, agentId });
    return agentId;
  });
  return {
    async withSession<T>(
      makaSessionId: string,
      operation: (
        document: SessionCheckpointPublicationDocument,
        save: () => Promise<void>,
      ) => Promise<T>,
    ): Promise<T> {
      if (!identifier(makaSessionId)) throw new TypeError('Invalid checkpoint Session identity');
      const key = createHash('sha256').update(makaSessionId).digest('hex');
      const path = join(input.directory, `session-${key}.json`);
      return withProcessLifetimeFileUpdateLock(path, async () => {
        const existing = await readOptional(path);
        const document: SessionCheckpointPublicationDocument =
          existing === undefined
            ? {
                schemaVersion: 1,
                rootId: input.rootId,
                binding: { makaSessionId, repositorySessionId: randomUUID(), agentId },
                requests: [],
              }
            : decode(existing, input.rootId, makaSessionId, agentId);
        const save = async () => {
          decode(document, input.rootId, makaSessionId, agentId);
          await writeDocument(path, document);
        };
        if (existing === undefined) await save();
        return operation(document, save);
      });
    },
  };
}

export interface SessionCheckpointPublicationStore {
  withSession<T>(
    makaSessionId: string,
    operation: (
      document: SessionCheckpointPublicationDocument,
      save: () => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}

function decode(
  value: unknown,
  rootId: string,
  sessionId: string,
  agentId: string,
): SessionCheckpointPublicationDocument {
  if (
    !record(value) ||
    value.schemaVersion !== 1 ||
    value.rootId !== rootId ||
    !record(value.binding) ||
    value.binding.makaSessionId !== sessionId ||
    value.binding.agentId !== agentId ||
    !identifier(value.binding.repositorySessionId) ||
    !UUID.test(value.binding.repositorySessionId) ||
    !Array.isArray(value.requests)
  )
    throw invalid();
  const ids = new Set<string>();
  const commits = new Set<string>();
  let pending = 0;
  for (const request of value.requests) {
    if (
      !record(request) ||
      !identifier(request.requestId) ||
      !identifier(request.commitId) ||
      !UUID.test(request.commitId) ||
      ids.has(request.requestId) ||
      commits.has(request.commitId) ||
      !(request.expectedRevision === null || identifier(request.expectedRevision)) ||
      !(request.snapshotCleanupPending === undefined || request.snapshotCleanupPending === true) ||
      !(request.bundleCleanupPending === undefined || request.bundleCleanupPending === true) ||
      !(request.confirmationGrantId === undefined || identifier(request.confirmationGrantId))
    )
      throw invalid();
    ids.add(request.requestId);
    commits.add(request.commitId);
    if (request.phase === 'capturing' || request.phase === 'aborted') {
      if (request.checkpoint !== undefined || request.result !== undefined) throw invalid();
      if (request.phase === 'capturing') pending++;
    } else if (
      request.phase === 'prepared' ||
      request.phase === 'conflicted' ||
      request.phase === 'committed'
    ) {
      assertCheckpoint(request.checkpoint);
      if (request.phase !== 'committed') {
        if (request.phase === 'prepared') pending++;
        if (request.result !== undefined) throw invalid();
      } else {
        const result = request.result;
        if (
          !record(result) ||
          !record(result.ref) ||
          result.ref.sessionId !== value.binding.repositorySessionId ||
          !identifier(result.ref.revision) ||
          result.agentId !== agentId ||
          result.forkedFrom !== undefined ||
          result.lastCommittedActivationId !== undefined
        )
          throw invalid();
        assertCheckpoint(result.checkpoint);
        if (JSON.stringify(result.checkpoint) !== JSON.stringify(request.checkpoint))
          throw invalid();
      }
    } else throw invalid();
  }
  if (pending > 1) throw invalid();
  return value as unknown as SessionCheckpointPublicationDocument;
}

function assertCheckpoint(value: unknown): asserts value is StoredSessionCheckpoint {
  try {
    if (
      !record(value) ||
      !record(value.value) ||
      value.value.schemaVersion !== 1 ||
      !record(value.manifest)
    )
      throw invalid();
    const manifest = createSessionCheckpointManifestV1(
      value.value.compatibilityBundle as Parameters<typeof createSessionCheckpointManifestV1>[0],
    );
    const bytes = encodeSessionCheckpointManifestV1(manifest);
    if (
      !identifier(value.manifest.objectRef) ||
      value.manifest.mediaType !== SESSION_CHECKPOINT_MANIFEST_MEDIA_TYPE ||
      value.manifest.bytes !== bytes.byteLength ||
      value.manifest.digest !== `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    )
      throw invalid();
  } catch (cause) {
    throw invalid(cause);
  }
}
async function readOptional(path: string): Promise<unknown> {
  try {
    const bytes = await readStableBoundedFile({
      path,
      maxBytes: MAX_DOCUMENT_BYTES,
      invalidFile: invalid,
    });
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function writeDocument(path: string, document: unknown): Promise<void> {
  const bytes = `${JSON.stringify(document)}\n`;
  // Reserve the duplicated checkpoint plus binding/revision envelope BEFORE
  // admitting CAS. Otherwise a prepared record near the quota could commit a
  // Head whose receipt can never fit, permanently blocking reconciliation.
  const receiptReserve =
    record(document) && Array.isArray(document.requests)
      ? document.requests.reduce(
          (total: number, request: unknown) =>
            total +
            (record(request) && request.phase === 'prepared'
              ? Buffer.byteLength(JSON.stringify(request.checkpoint)) + 8192
              : 0),
          0,
        )
      : 0;
  if (Buffer.byteLength(bytes) + receiptReserve > MAX_DOCUMENT_BYTES)
    throw new Error('Checkpoint publication journal quota exceeded');
  await writeAtomicFile(path, bytes, { fileMode: 0o600 });
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f]/u.test(value)
  );
}
function invalid(cause?: unknown): Error {
  return new Error(
    'Invalid checkpoint publication recovery record',
    cause === undefined ? undefined : { cause },
  );
}
