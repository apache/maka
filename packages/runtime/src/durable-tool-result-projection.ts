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
  decodeDurableToolResultProjection,
  DURABLE_TOOL_RESULT_PROJECTION_FAILURE,
  DURABLE_TOOL_RESULT_PROJECTION_MAX_PARTS,
  DURABLE_TOOL_RESULT_PROJECTION_VERSION,
  type DurableProjectionArtifactRef,
  type DurableProjectionJson,
  type DurableToolResultProjection,
  type DurableToolResultProjectionPart,
} from '@maka/core/durable-tool-result-projection';
import { MAX_READ_IMAGE_BYTES } from '@maka/core/attachments';
import { isCanonicalArtifactEntityId } from '@maka/core/artifacts';
import { isCanonicalStorageRef } from '@maka/core/events';
import type { ToolResultContent } from '@maka/core/events';
import { redactSecrets } from '@maka/core/redaction';
import type { RuntimeEventFunctionResponseContent } from '@maka/core/runtime-event';
import { decodeCanonicalShellToolResultContent } from '@maka/core/shell-run-result';
import { markPersisted } from '@maka/core/persisted-value';
import { decodePersistedToolResultContent } from '@maka/core/tool-result-record-schema';

import type { ToolResultOutput } from './model-protocol.js';
import { toolResultOutput } from './tool-result-output.js';
import { withToolResultArchiveResourceRef } from './tool-result-archive.js';
import { projectBashToolResultForModel } from './bash-model-output.js';
import { projectFileWriteToolResultForModel } from './file-tool-model-output.js';

const OMITTED_BINARY_TEXT =
  '[Binary tool output omitted from the durable model projection; repeat the tool call if it is still needed.]';
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 20_000;

/**
 * The only new-write codec from Runtime's tool-output contract into the
 * provider-neutral durable projection protocol. It is total by construction:
 * invalid, unsafe, or oversized output becomes one stable failure sentinel.
 */
export function encodeDurableToolResultOutput(
  output: ToolResultOutput,
  sessionId: string,
): DurableToolResultProjection {
  try {
    const projection = encodeOutput(output, sessionId);
    return decodeDurableToolResultProjection(projection);
  } catch {
    return DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
  }
}

export type DurableProjectionArtifactPersister = (input: {
  bytes: Uint8Array;
  mediaType: string;
}) => Promise<DurableProjectionArtifactRef>;

export function encodeDurableToolResultOutputWithArtifacts(
  output: ToolResultOutput,
  sessionId: string,
  persistArtifact: DurableProjectionArtifactPersister | undefined,
): DurableToolResultProjection | PromiseLike<DurableToolResultProjection> {
  if (!persistArtifact || output.type !== 'content' || !hasInlineImage(output)) {
    return encodeDurableToolResultOutput(output, sessionId);
  }
  return (async () => {
    try {
      const value: Extract<ToolResultOutput, { type: 'content' }>['value'] = [];
      for (const part of output.value) {
        if (
          part.type !== 'file' ||
          part.data.type !== 'data' ||
          !part.mediaType.toLowerCase().startsWith('image/')
        ) {
          value.push(part);
          continue;
        }
        const bytes = decodeBoundedImageData(part.data.data);
        const ref = await persistArtifact({ bytes, mediaType: part.mediaType });
        value.push({ ...part, data: { ref } } as never);
      }
      return encodeDurableToolResultOutput({ type: 'content', value }, sessionId);
    } catch {
      return DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
    }
  })();
}

export function encodeDefaultDurableToolResultOutput(
  result: unknown,
  sessionId: string,
): DurableToolResultProjection {
  const image = sessionImageResult(result, sessionId);
  if (image) {
    try {
      return decodeDurableToolResultProjection({
        version: DURABLE_TOOL_RESULT_PROJECTION_VERSION,
        kind: 'content',
        parts: [{ kind: 'artifact', mediaType: image.mimeType, ref: image.ref }],
      });
    } catch {
      return DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
    }
  }
  return encodeDurableToolResultOutput(
    typeof result === 'string'
      ? { type: 'text', value: result }
      : { type: 'json', value: result as never },
    sessionId,
  );
}

export function durableProjectionToToolResultOutput(
  projection: DurableToolResultProjection,
): ToolResultOutput {
  switch (projection.kind) {
    case 'text':
      return projection.isError
        ? { type: 'error-text', value: projection.text }
        : { type: 'text', value: projection.text };
    case 'json':
      return projection.isError
        ? { type: 'error-json', value: projection.value }
        : { type: 'json', value: projection.value };
    case 'content':
      return {
        type: 'content',
        value: projection.parts.map((part) =>
          part.kind === 'text'
            ? { type: 'text' as const, text: part.text }
            : {
                type: 'text' as const,
                text: `[Artifact ${JSON.stringify(
                  part.ref.kind === 'session_context' ? part.ref.refId : part.ref.relativePath,
                )} (${part.mediaType}) is stored in this Session.]`,
              },
        ),
      };
    case 'execution_denied':
      return {
        type: 'execution-denied',
        ...(projection.reason !== undefined ? { reason: projection.reason } : {}),
      };
    case 'failure':
      return { type: 'error-text', value: projection.message };
  }
}

export type EffectiveToolResultProjection =
  | {
      kind: 'projection';
      projection: DurableToolResultProjection;
      legacyOutput: unknown;
    }
  | { kind: 'provider_native'; output: unknown }
  | { kind: 'legacy_output'; output: unknown }
  | { kind: 'invalid_legacy'; message: string };

/** The single compatibility boundary for both current and legacy response events. */
export function decodeEffectiveToolResultProjection(
  content: RuntimeEventFunctionResponseContent,
  sessionId: string,
): EffectiveToolResultProjection {
  if (content.providerExecuted && content.providerOutput !== undefined) {
    return { kind: 'provider_native', output: content.providerOutput };
  }
  if (content.modelProjection !== undefined) {
    try {
      return {
        kind: 'projection',
        projection: decodeDurableToolResultProjection(content.modelProjection),
        legacyOutput: content.result,
      };
    } catch {
      return {
        kind: 'projection',
        projection: DURABLE_TOOL_RESULT_PROJECTION_FAILURE,
        legacyOutput: content.result,
      };
    }
  }

  let output = withToolResultArchiveResourceRef(content.result);
  if (isRetiredExploreAgentResult(output)) {
    try {
      output = decodePersistedToolResultContent(markPersisted<ToolResultContent>(output));
    } catch {
      return {
        kind: 'invalid_legacy',
        message: 'function_response contains an invalid retired tool result',
      };
    }
  }
  const shellResult = decodeCanonicalShellToolResultContent(output);
  if (shellResult.state === 'invalid') {
    return {
      kind: 'invalid_legacy',
      message: 'function_response contains an invalid shell tool result',
    };
  }
  if (shellResult.state === 'valid') output = shellResult.content;
  output =
    content.name === 'Bash'
      ? projectBashToolResultForModel(output)
      : projectFileWriteToolResultForModel(content.name, output);
  const projection =
    content.isError === true
      ? encodeDurableToolResultOutput(compatibilityErrorOutput(output), sessionId)
      : encodeDefaultDurableToolResultOutput(output, sessionId);
  if (projection.kind === 'failure' && isLegacyPathImageResult(output, sessionId)) {
    return { kind: 'legacy_output', output };
  }
  return {
    kind: 'projection',
    projection,
    legacyOutput: output,
  };
}

function compatibilityErrorOutput(output: unknown): ToolResultOutput {
  return output !== null &&
    typeof output === 'object' &&
    !Array.isArray(output) &&
    (output as { kind?: unknown }).kind === 'text' &&
    typeof (output as { text?: unknown }).text === 'string'
    ? { type: 'error-text', value: new Error((output as { text: string }).text).toString() }
    : toolResultOutput(output, true);
}

export function compatibilityToolResultProjection(
  content: RuntimeEventFunctionResponseContent,
  sessionId: string,
): DurableToolResultProjection | undefined {
  const effective = decodeEffectiveToolResultProjection(content, sessionId);
  if (effective.kind === 'provider_native') return undefined;
  if (effective.kind === 'legacy_output') return DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
  return effective.kind === 'projection'
    ? effective.projection
    : DURABLE_TOOL_RESULT_PROJECTION_FAILURE;
}

function encodeOutput(output: ToolResultOutput, sessionId: string): DurableToolResultProjection {
  switch (output.type) {
    case 'text':
    case 'error-text':
      return {
        version: DURABLE_TOOL_RESULT_PROJECTION_VERSION,
        kind: 'text',
        text: redactSecrets(output.value),
        ...(output.type === 'error-text' ? { isError: true as const } : {}),
      };
    case 'json':
    case 'error-json':
      return {
        version: DURABLE_TOOL_RESULT_PROJECTION_VERSION,
        kind: 'json',
        value: sanitizeJson(output.value),
        ...(output.type === 'error-json' ? { isError: true as const } : {}),
      };
    case 'execution-denied':
      return {
        version: DURABLE_TOOL_RESULT_PROJECTION_VERSION,
        kind: 'execution_denied',
        ...(output.reason !== undefined ? { reason: redactSecrets(output.reason) } : {}),
      };
    case 'content': {
      if (output.value.length > DURABLE_TOOL_RESULT_PROJECTION_MAX_PARTS) {
        throw new Error('Tool Result content exceeds the durable part limit');
      }
      const parts: DurableToolResultProjectionPart[] = [];
      for (const part of output.value) {
        if (part.type === 'text') {
          parts.push({ kind: 'text', text: redactSecrets(part.text) });
          continue;
        }
        if (part.type === 'file') {
          const ref = readSessionArtifactRef(part, sessionId);
          if (ref) parts.push({ kind: 'artifact', mediaType: part.mediaType, ref });
          else parts.push({ kind: 'text', text: OMITTED_BINARY_TEXT });
        }
      }
      if (parts.length === 0) parts.push({ kind: 'text', text: 'Tool completed with no content.' });
      return { version: DURABLE_TOOL_RESULT_PROJECTION_VERSION, kind: 'content', parts };
    }
  }
}

function readSessionArtifactRef(
  part: Extract<ToolResultOutput, { type: 'content' }>['value'][number],
  sessionId: string,
) {
  if (part.type !== 'file') return undefined;
  const data = part.data as unknown;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const ref = (data as { ref?: unknown }).ref;
  return isCanonicalStorageRef(ref) &&
    (ref.kind === 'session_context' || ref.kind === 'session_file') &&
    ref.sessionId === sessionId
    ? ref
    : undefined;
}

function hasInlineImage(output: Extract<ToolResultOutput, { type: 'content' }>): boolean {
  return output.value.some(
    (part) =>
      part.type === 'file' &&
      part.data.type === 'data' &&
      part.mediaType.toLowerCase().startsWith('image/'),
  );
}

function decodeBoundedImageData(data: unknown): Uint8Array {
  let bytes: Uint8Array;
  if (typeof data === 'string') {
    if (data.length > Math.ceil((MAX_READ_IMAGE_BYTES * 4) / 3) + 4) {
      throw new Error('Inline image exceeds the artifact byte limit');
    }
    const decoded = Buffer.from(data, 'base64');
    if (decoded.toString('base64') !== data)
      throw new Error('Inline image is not canonical base64');
    bytes = decoded;
  } else if (data instanceof ArrayBuffer) {
    bytes = new Uint8Array(data.slice(0));
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  } else {
    throw new Error('Inline image data is not representable');
  }
  if (bytes.byteLength > MAX_READ_IMAGE_BYTES) {
    throw new Error('Inline image exceeds the artifact byte limit');
  }
  return bytes;
}

function sessionImageResult(result: unknown, sessionId: string) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return undefined;
  const image = result as { kind?: unknown; mimeType?: unknown; ref?: unknown };
  return image.kind === 'image' &&
    typeof image.mimeType === 'string' &&
    image.mimeType.length > 0 &&
    isCanonicalStorageRef(image.ref) &&
    (image.ref.kind === 'session_context' || image.ref.kind === 'session_file') &&
    image.ref.sessionId === sessionId
    ? { mimeType: image.mimeType, ref: image.ref }
    : undefined;
}

function isLegacyPathImageResult(result: unknown, sessionId: string): boolean {
  const image = sessionImageResult(result, sessionId);
  return image?.ref.kind === 'session_file' && !isCanonicalArtifactEntityId(image.ref.relativePath);
}

function sanitizeJson(value: unknown): DurableProjectionJson {
  const state = { nodes: 0 };
  const strictJson = sanitizeJsonValue(value, state, 0);
  return JSON.parse(redactSecrets(JSON.stringify(strictJson))) as DurableProjectionJson;
}

function sanitizeJsonValue(
  value: unknown,
  state: { nodes: number },
  depth: number,
): DurableProjectionJson {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) throw new Error('JSON exceeds limit');
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item, state, depth + 1));
  }
  if (!value || typeof value !== 'object') throw new Error('JSON is not representable');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('JSON contains an opaque object');
  }
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    throw new Error('JSON contains an opaque serializer');
  }
  const result: Record<string, DurableProjectionJson> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: sanitizeJsonValue(item, state, depth + 1),
    });
  }
  return result;
}

function isRetiredExploreAgentResult(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === 'explore_agent'
  );
}
