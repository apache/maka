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

import { join } from 'node:path';
import {
  createStorageRootLeaseIdentityGuard,
  runWithStorageRootLease,
  type StorageRootKind,
  type StorageRootLease,
} from './root-authority.js';
import { publishMarkerFile, readBoundedMarkerFile } from './marker-file.js';

export const STATE_ROOT_COMPOSITION_FILE = '.maka-host-composition.json';
export const STATE_ROOT_COMPOSITION_SCHEMA_VERSION = 1 as const;
const MAX_STATE_ROOT_COMPOSITION_BYTES = 1_024;
const COMPOSITION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;

interface StateRootCompositionRecord {
  readonly schemaVersion: typeof STATE_ROOT_COMPOSITION_SCHEMA_VERSION;
  readonly compositionId: string;
}

export interface StateRootCompositionBinding {
  readonly compositionId: string;
}

export class StateRootCompositionError extends Error {
  constructor(
    readonly code: 'invalid_composition' | 'composition_mismatch' | 'composition_io_failed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StateRootCompositionError';
  }
}

export async function bindStateRootComposition<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'write'>,
  compositionId: string,
): Promise<void> {
  requireCompositionId(compositionId);
  const assertCurrentRoot = createStorageRootLeaseIdentityGuard(lease, lease.kind, 'write');
  await runWithStorageRootLease(lease, lease.kind, 'write', async (root) => {
    const existing = await readStateRootCompositionIfPresent(root);
    if (existing) {
      assertMatchingComposition(existing, compositionId);
      return;
    }
    const record: StateRootCompositionRecord = {
      schemaVersion: STATE_ROOT_COMPOSITION_SCHEMA_VERSION,
      compositionId,
    };
    const publication = await withCompositionIoFailure(() =>
      publishMarkerFile({
        root,
        markerFile: STATE_ROOT_COMPOSITION_FILE,
        contents: `${JSON.stringify(record)}\n`,
        maxBytes: MAX_STATE_ROOT_COMPOSITION_BYTES,
        publication: 'create',
        beforePublish: assertCurrentRoot,
        invalidFile,
      }),
    );
    if (publication === 'published') return;
    const winner = await readStateRootComposition(root);
    assertMatchingComposition(winner, compositionId);
  });
}

export async function readStateRootCompositionBinding(
  root: string,
): Promise<StateRootCompositionBinding | undefined> {
  const record = await readStateRootCompositionIfPresent(root);
  return record ? Object.freeze({ compositionId: record.compositionId }) : undefined;
}

async function readStateRootCompositionIfPresent(
  root: string,
): Promise<StateRootCompositionRecord | undefined> {
  try {
    return await readStateRootComposition(root);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function readStateRootComposition(root: string): Promise<StateRootCompositionRecord> {
  return withCompositionIoFailure(async () => {
    const contents = await readBoundedMarkerFile({
      path: join(root, STATE_ROOT_COMPOSITION_FILE),
      maxBytes: MAX_STATE_ROOT_COMPOSITION_BYTES,
      invalidFile,
    });
    let value: unknown;
    try {
      value = JSON.parse(contents) as unknown;
    } catch (error) {
      throw invalidFile(error);
    }
    if (!isExactCompositionRecord(value)) throw invalidFile();
    requireCompositionId(value.compositionId);
    return value;
  });
}

function assertMatchingComposition(
  record: StateRootCompositionRecord,
  compositionId: string,
): void {
  if (record.compositionId === compositionId) return;
  throw new StateRootCompositionError(
    'composition_mismatch',
    `State Root requires Runtime Host composition ${record.compositionId}`,
  );
}

function requireCompositionId(value: string): void {
  if (!COMPOSITION_ID_PATTERN.test(value) || value.length > 128) {
    throw new StateRootCompositionError(
      'invalid_composition',
      'Runtime Host composition id is invalid',
    );
  }
}

function isExactCompositionRecord(value: unknown): value is StateRootCompositionRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length === 2 &&
    Object.hasOwn(record, 'schemaVersion') &&
    Object.hasOwn(record, 'compositionId') &&
    record.schemaVersion === STATE_ROOT_COMPOSITION_SCHEMA_VERSION &&
    typeof record.compositionId === 'string'
  );
}

function invalidFile(cause?: unknown): StateRootCompositionError {
  return new StateRootCompositionError(
    'invalid_composition',
    'State Root composition record is invalid',
    cause === undefined ? undefined : { cause },
  );
}

async function withCompositionIoFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof StateRootCompositionError || isNodeError(error, 'ENOENT')) throw error;
    throw new StateRootCompositionError(
      'composition_io_failed',
      'Unable to access the State Root composition record',
      { cause: error },
    );
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
