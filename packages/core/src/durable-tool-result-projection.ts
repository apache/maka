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

import { isCanonicalStorageRef, type StorageRef } from './events.js';
import { isCanonicalArtifactEntityId, normalizeArtifactImagePreviewMime } from './artifacts.js';
import { hasExactShape, isRecord } from './record-schema.js';
import { serializedByteLength } from './serialized-byte-length.js';

export const DURABLE_TOOL_RESULT_PROJECTION_VERSION = 1 as const;
export const DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES = 256 * 1024;
export const DURABLE_TOOL_RESULT_PROJECTION_MAX_PARTS = 64;
export const DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_DEPTH = 32;
export const DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_NODES = 20_000;
export const DURABLE_TOOL_RESULT_PROJECTION_FAILURE_MESSAGE =
  'The tool completed, but its model-visible result could not be projected safely.';

export type DurableProjectionJson =
  | null
  | boolean
  | number
  | string
  | DurableProjectionJson[]
  | { [key: string]: DurableProjectionJson };

export type DurableProjectionArtifactRef = Extract<
  StorageRef,
  { kind: 'session_context' | 'session_file' }
>;

export type DurableToolResultProjectionPart =
  | { kind: 'text'; text: string }
  | {
      kind: 'artifact';
      mediaType: string;
      ref: DurableProjectionArtifactRef;
    };

export type DurableToolResultProjection =
  | { version: 1; kind: 'text'; text: string; isError?: true }
  | { version: 1; kind: 'json'; value: DurableProjectionJson; isError?: true }
  | { version: 1; kind: 'content'; parts: DurableToolResultProjectionPart[] }
  | { version: 1; kind: 'execution_denied'; reason?: string }
  | {
      version: 1;
      kind: 'failure';
      reason: 'projection_failed';
      message: typeof DURABLE_TOOL_RESULT_PROJECTION_FAILURE_MESSAGE;
    };

export const DURABLE_TOOL_RESULT_PROJECTION_FAILURE: DurableToolResultProjection = Object.freeze({
  version: DURABLE_TOOL_RESULT_PROJECTION_VERSION,
  kind: 'failure',
  reason: 'projection_failed',
  message: DURABLE_TOOL_RESULT_PROJECTION_FAILURE_MESSAGE,
});

export function decodeDurableToolResultProjection(value: unknown): DurableToolResultProjection {
  if (
    !isDurableToolResultProjection(value) ||
    serializedByteLength(value, DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES) >
      DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES
  ) {
    throw new Error('Invalid durable Tool Result projection');
  }
  return value;
}

function isDurableToolResultProjection(value: unknown): value is DurableToolResultProjection {
  if (!isRecord(value) || value.version !== DURABLE_TOOL_RESULT_PROJECTION_VERSION) return false;
  switch (value.kind) {
    case 'text':
      return (
        hasExactShape(value, {
          required: ['version', 'kind', 'text'],
          allowed: new Set(['version', 'kind', 'text', 'isError']),
        }) &&
        typeof value.text === 'string' &&
        (value.isError === undefined || value.isError === true)
      );
    case 'json':
      return (
        hasExactShape(value, {
          required: ['version', 'kind', 'value'],
          allowed: new Set(['version', 'kind', 'value', 'isError']),
        }) &&
        isDurableProjectionJson(value.value, { nodes: 0 }, 0) &&
        (value.isError === undefined || value.isError === true)
      );
    case 'content':
      return (
        hasExactShape(value, {
          required: ['version', 'kind', 'parts'],
          allowed: new Set(['version', 'kind', 'parts']),
        }) &&
        Array.isArray(value.parts) &&
        value.parts.length > 0 &&
        value.parts.length <= DURABLE_TOOL_RESULT_PROJECTION_MAX_PARTS &&
        value.parts.every(isProjectionPart)
      );
    case 'execution_denied':
      return (
        hasExactShape(value, {
          required: ['version', 'kind'],
          allowed: new Set(['version', 'kind', 'reason']),
        }) &&
        (value.reason === undefined || typeof value.reason === 'string')
      );
    case 'failure':
      return (
        hasExactShape(value, {
          required: ['version', 'kind', 'reason', 'message'],
          allowed: new Set(['version', 'kind', 'reason', 'message']),
        }) &&
        value.reason === 'projection_failed' &&
        value.message === DURABLE_TOOL_RESULT_PROJECTION_FAILURE_MESSAGE
      );
    default:
      return false;
  }
}

function isProjectionPart(value: unknown): value is DurableToolResultProjectionPart {
  if (!isRecord(value)) return false;
  if (value.kind === 'text') {
    return (
      hasExactShape(value, {
        required: ['kind', 'text'],
        allowed: new Set(['kind', 'text']),
      }) && typeof value.text === 'string'
    );
  }
  return (
    value.kind === 'artifact' &&
    hasExactShape(value, {
      required: ['kind', 'mediaType', 'ref'],
      allowed: new Set(['kind', 'mediaType', 'ref']),
    }) &&
    typeof value.mediaType === 'string' &&
    normalizeArtifactImagePreviewMime(value.mediaType) === value.mediaType &&
    isCanonicalStorageRef(value.ref) &&
    (value.ref.kind === 'session_context' ||
      (value.ref.kind === 'session_file' && isCanonicalArtifactEntityId(value.ref.relativePath)))
  );
}

function isDurableProjectionJson(
  value: unknown,
  state: { nodes: number },
  depth: number,
): value is DurableProjectionJson {
  state.nodes += 1;
  if (
    state.nodes > DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_NODES ||
    depth > DURABLE_TOOL_RESULT_PROJECTION_MAX_JSON_DEPTH
  ) {
    return false;
  }
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isDurableProjectionJson(item, state, depth + 1));
  }
  return (
    isRecord(value) &&
    Object.values(value).every((item) => isDurableProjectionJson(item, state, depth + 1))
  );
}
