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
export const REQUEST_COMPOSITION_SCHEMA_VERSION = 1 as const;

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

export interface RequestCompositionToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly providerTool?: Record<string, unknown>;
}

/**
 * One model-visible request surface, frozen at a logical model-step boundary.
 * A later step appends a new snapshot only when one of these effective fields
 * changes; physical retries of the same step keep referring to this snapshot.
 */
export interface RequestCompositionSnapshot {
  readonly schemaVersion: typeof REQUEST_COMPOSITION_SCHEMA_VERSION;
  readonly compositionId: string;
  readonly step: number;
  readonly reason: 'initial' | 'change';
  readonly sourceRevisions: readonly RunCompositionSourceRevision[];
  readonly systemPromptHash: `sha256:${string}`;
  readonly toolCatalogHash: `sha256:${string}`;
  readonly toolAvailabilityHash: `sha256:${string}`;
  readonly providerOptionsHash: `sha256:${string}`;
  readonly toolNames: readonly string[];
  readonly toolSchemas: readonly RequestCompositionToolSchema[];
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
const REQUEST_COMPOSITION_SHAPE = defineObjectShape<RequestCompositionSnapshot>()(
  [
    'schemaVersion',
    'compositionId',
    'step',
    'reason',
    'sourceRevisions',
    'systemPromptHash',
    'toolCatalogHash',
    'toolAvailabilityHash',
    'providerOptionsHash',
    'toolNames',
    'toolSchemas',
  ],
  [],
);
const REQUEST_COMPOSITION_TOOL_SCHEMA_SHAPE = defineObjectShape<RequestCompositionToolSchema>()(
  ['name', 'description', 'inputSchema'],
  ['providerTool'],
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

export type RequestCompositionSnapshotInput = Omit<
  RequestCompositionSnapshot,
  'schemaVersion' | 'reason'
>;

export function createRequestCompositionSnapshot(
  input: RequestCompositionSnapshotInput,
  reason: RequestCompositionSnapshot['reason'],
): RequestCompositionSnapshot {
  return decodeRequestCompositionSnapshot({
    schemaVersion: REQUEST_COMPOSITION_SCHEMA_VERSION,
    ...input,
    reason,
    sourceRevisions: [...input.sourceRevisions].sort((left, right) =>
      compareExactString(left.id, right.id),
    ),
    toolNames: [...input.toolNames].sort(compareExactString),
    toolSchemas: [...input.toolSchemas].sort((left, right) =>
      compareExactString(left.name, right.name),
    ),
  });
}

export function decodeRequestCompositionSnapshot(value: unknown): RequestCompositionSnapshot {
  if (!isRecord(value) || !hasExactShape(value, REQUEST_COMPOSITION_SHAPE)) {
    throw new Error('Invalid Request Composition snapshot schema');
  }
  const valid =
    value.schemaVersion === REQUEST_COMPOSITION_SCHEMA_VERSION &&
    boundedString(value.compositionId, 128) &&
    Number.isSafeInteger(value.step) &&
    (value.step as number) >= 0 &&
    (value.reason === 'initial' || value.reason === 'change') &&
    canonicalSourceRevisions(value.sourceRevisions) &&
    hash(value.systemPromptHash) &&
    hash(value.toolCatalogHash) &&
    hash(value.toolAvailabilityHash) &&
    hash(value.providerOptionsHash) &&
    canonicalToolNames(value.toolNames) &&
    canonicalToolSchemas(value.toolSchemas);
  if (!valid) throw new Error('Invalid Request Composition snapshot schema');
  return Object.freeze({
    ...(value as unknown as RequestCompositionSnapshot),
    sourceRevisions: Object.freeze(
      (value.sourceRevisions as RunCompositionSourceRevision[]).map((source) =>
        Object.freeze({ ...source }),
      ),
    ),
    toolNames: Object.freeze([...(value.toolNames as string[])]),
    toolSchemas: Object.freeze(
      (value.toolSchemas as RequestCompositionToolSchema[]).map((schema) =>
        Object.freeze(structuredClone(schema)),
      ),
    ),
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

function canonicalToolSchemas(value: unknown): value is RequestCompositionToolSchema[] {
  if (!Array.isArray(value) || value.length > 512) return false;
  let previous: string | undefined;
  for (const schema of value) {
    if (
      !isRecord(schema) ||
      !hasExactShape(schema, REQUEST_COMPOSITION_TOOL_SCHEMA_SHAPE) ||
      !boundedString(schema.name, 256) ||
      !boundedString(schema.description, 16_384) ||
      !isRecord(schema.inputSchema) ||
      (schema.providerTool !== undefined && !isRecord(schema.providerTool)) ||
      (previous !== undefined && previous >= schema.name)
    ) {
      return false;
    }
    previous = schema.name;
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
