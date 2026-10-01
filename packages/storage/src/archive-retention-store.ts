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

import {
  type ArchiveRetentionDays,
  type ArchiveRetentionDeletion,
  type ArchiveRetentionSweep,
  decodeArchiveRetentionDeletion,
  decodeArchiveRetentionSweep,
  isArchiveRetentionDays,
} from '@maka/core/archive-retention';
import { runWithStorageRootLease, type StorageRootLease } from './root-authority.js';
import { readBoundedJsonDocument, writeJsonDocument } from './runtime-policy/document-io.js';
import { RuntimePolicyStoreError } from './runtime-policy/errors.js';

const FILE = 'archive-retention.json';
const VERSION = 1 as const;
const MAX_BYTES = 16 * 1024;

/**
 * The archived-task retention setting and its latest results: a Host document
 * of its own in the State Root. It is deliberately not part of the runtime
 * policy, which has several writers and travels with config export and
 * import; the only writer of this one is the Host's retention command and its
 * sweep.
 */
export interface ArchiveRetentionDocument {
  readonly version: typeof VERSION;
  /** Moves with every setting change, never with a sweep result. */
  readonly revision: number;
  readonly enabled: boolean;
  readonly days: ArchiveRetentionDays;
  /** Host clock when the current setting took effect; present exactly while enabled. */
  readonly enabledAt?: number;
  readonly latest?: {
    readonly lastSweep?: ArchiveRetentionSweep;
    readonly lastDeletion?: ArchiveRetentionDeletion;
  };
}

/**
 * `invalid` is a document that exists but cannot be fully validated, including
 * one written by a newer Host. Retention treats it as disabled.
 */
export type ArchiveRetentionDocumentRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'valid'; readonly document: ArchiveRetentionDocument }
  | { readonly kind: 'invalid'; readonly reason: string };

export interface InteractiveArchiveRetentionStore {
  /** Throws only when the document cannot be read at all. */
  read(): Promise<ArchiveRetentionDocumentRead>;
  /** Atomically replaces the document. */
  write(document: ArchiveRetentionDocument): Promise<void>;
}

export function openArchiveRetentionStore(
  lease: StorageRootLease<'interactive', 'write'>,
): InteractiveArchiveRetentionStore {
  return Object.freeze({
    read: () =>
      runWithStorageRootLease(lease, 'interactive', 'write', (root) =>
        readArchiveRetentionDocument(root),
      ),
    write: (document: ArchiveRetentionDocument) =>
      runWithStorageRootLease(lease, 'interactive', 'write', (root) =>
        writeJsonDocument(root, FILE, encodeArchiveRetentionDocument(document), MAX_BYTES),
      ),
  });
}

export async function readArchiveRetentionDocument(
  root: string,
): Promise<ArchiveRetentionDocumentRead> {
  let value: unknown;
  try {
    value = await readBoundedJsonDocument(root, FILE, MAX_BYTES);
  } catch (error) {
    if (error instanceof RuntimePolicyStoreError && error.code === 'invalid_document') {
      return { kind: 'invalid', reason: error.message };
    }
    throw error;
  }
  if (value === undefined) return { kind: 'absent' };
  try {
    return { kind: 'valid', document: decodeArchiveRetentionDocument(value) };
  } catch (error) {
    return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
  }
}

function decodeArchiveRetentionDocument(value: unknown): ArchiveRetentionDocument {
  const document = exactRecord(
    value,
    FILE,
    ['version', 'revision', 'enabled', 'days'],
    ['enabledAt', 'latest'],
  );
  if (document.version !== VERSION) throw new Error(`${FILE} has an unsupported version`);
  if (typeof document.enabled !== 'boolean') throw new Error(`${FILE} has an invalid enabled`);
  if (!isArchiveRetentionDays(document.days)) throw new Error(`${FILE} has invalid days`);
  if (document.enabled !== (document.enabledAt !== undefined)) {
    throw new Error(`${FILE} must carry enabledAt exactly while enabled`);
  }
  const latest =
    document.latest === undefined
      ? undefined
      : exactRecord(document.latest, `${FILE}.latest`, [], ['lastSweep', 'lastDeletion']);
  return {
    version: VERSION,
    revision: count(document.revision, 'revision'),
    enabled: document.enabled,
    days: document.days,
    ...(document.enabledAt === undefined
      ? {}
      : { enabledAt: count(document.enabledAt, 'enabledAt') }),
    ...(latest === undefined
      ? {}
      : {
          latest: {
            ...(latest.lastSweep === undefined
              ? {}
              : { lastSweep: decodeArchiveRetentionSweep(latest.lastSweep, documentError) }),
            ...(latest.lastDeletion === undefined
              ? {}
              : {
                  lastDeletion: decodeArchiveRetentionDeletion(latest.lastDeletion, documentError),
                }),
          },
        }),
  };
}

function encodeArchiveRetentionDocument(document: ArchiveRetentionDocument): unknown {
  // Never publish what the reader would refuse.
  return decodeArchiveRetentionDocument(JSON.parse(JSON.stringify(document)));
}

function exactRecord(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new Error(`${label} has an unknown key`);
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(`${label} is missing ${key}`);
  }
  return record;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${FILE} has an invalid ${label}`);
  }
  return value;
}

function documentError(message: string): Error {
  return new Error(`${FILE}: ${message}`);
}
