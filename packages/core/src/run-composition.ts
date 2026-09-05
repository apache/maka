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

import { defineObjectShape, hasExactShape, isRecord } from './record-schema.js';

export const RUN_COMPOSITION_SCHEMA_VERSION = 1 as const;

export interface RunCompositionSourceRevision {
  readonly id: string;
  readonly revision: string;
}

export interface RunCompositionSnapshot {
  readonly schemaVersion: typeof RUN_COMPOSITION_SCHEMA_VERSION;
  readonly composerId: string;
  readonly composerRevision: string;
  readonly sourceRevisions: readonly RunCompositionSourceRevision[];
  readonly baseSystemPromptHash: `sha256:${string}`;
  readonly toolCatalogHash: `sha256:${string}`;
  readonly toolAvailabilityHash: `sha256:${string}`;
  readonly baseProviderOptionsHash: `sha256:${string}`;
  readonly toolNames: readonly string[];
  readonly contextWindow: number | null;
}

const RUN_COMPOSITION_SHAPE = defineObjectShape<RunCompositionSnapshot>()(
  [
    'schemaVersion',
    'composerId',
    'composerRevision',
    'sourceRevisions',
    'baseSystemPromptHash',
    'toolCatalogHash',
    'toolAvailabilityHash',
    'baseProviderOptionsHash',
    'toolNames',
    'contextWindow',
  ],
  [],
);

const ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION_SHAPE = defineObjectShape<RunCompositionSourceRevision>()(
  ['id', 'revision'],
  [],
);

export function decodeRunCompositionSnapshot(value: unknown): RunCompositionSnapshot {
  if (!isRecord(value) || !hasExactShape(value, RUN_COMPOSITION_SHAPE)) {
    throw new Error('Invalid Run Composition snapshot schema');
  }
  const valid =
    value.schemaVersion === RUN_COMPOSITION_SCHEMA_VERSION &&
    boundedMatchingString(value.composerId, ID_PATTERN, 128) &&
    boundedString(value.composerRevision, 128) &&
    canonicalSourceRevisions(value.sourceRevisions) &&
    hash(value.baseSystemPromptHash) &&
    hash(value.toolCatalogHash) &&
    hash(value.toolAvailabilityHash) &&
    hash(value.baseProviderOptionsHash) &&
    canonicalToolNames(value.toolNames) &&
    (value.contextWindow === null ||
      (Number.isSafeInteger(value.contextWindow) && (value.contextWindow as number) > 0));
  if (!valid) throw new Error('Invalid Run Composition snapshot schema');
  return Object.freeze({
    ...(value as unknown as RunCompositionSnapshot),
    sourceRevisions: Object.freeze(
      (value.sourceRevisions as RunCompositionSourceRevision[]).map((source) =>
        Object.freeze({ ...source }),
      ),
    ),
    toolNames: Object.freeze([...(value.toolNames as string[])]),
  });
}

export type RunCompositionSnapshotInput = Omit<RunCompositionSnapshot, 'schemaVersion'>;

export function createRunCompositionSnapshot(
  input: RunCompositionSnapshotInput,
): RunCompositionSnapshot {
  return decodeRunCompositionSnapshot({
    schemaVersion: RUN_COMPOSITION_SCHEMA_VERSION,
    ...input,
    sourceRevisions: [...input.sourceRevisions].sort((left, right) =>
      compareExactString(left.id, right.id),
    ),
    toolNames: [...input.toolNames].sort(compareExactString),
  });
}

function compareExactString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalSourceRevisions(value: unknown): value is RunCompositionSourceRevision[] {
  if (!Array.isArray(value) || value.length > 64) return false;
  let previous: string | undefined;
  for (const source of value) {
    if (
      !isRecord(source) ||
      !hasExactShape(source, SOURCE_REVISION_SHAPE) ||
      !boundedMatchingString(source.id, ID_PATTERN, 128) ||
      !boundedString(source.revision, 128) ||
      (previous !== undefined && previous >= source.id)
    ) {
      return false;
    }
    previous = source.id;
  }
  return true;
}

function canonicalToolNames(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length > 256) return false;
  let previous: string | undefined;
  for (const name of value) {
    if (!boundedString(name, 128) || (previous !== undefined && previous >= name)) return false;
    previous = name;
  }
  return true;
}

function hash(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

function boundedMatchingString(
  value: unknown,
  pattern: RegExp,
  maxLength: number,
): value is string {
  return boundedString(value, maxLength) && pattern.test(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}
