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

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES } from '@maka/core/durable-tool-result-projection';

export const RUNTIME_PAYLOAD_MARKER = '__maka_storage';
export const RUNTIME_PAYLOAD_PREFIX = `{"${RUNTIME_PAYLOAD_MARKER}":`;
// This canonical header lets SQLite enforce logical quotas without repeatedly
// parsing a large base64 JSON value. The reader rejects alternate number syntax.
export const RUNTIME_PAYLOAD_V1_PREFIX = `${RUNTIME_PAYLOAD_PREFIX}{"version":1,"codec":"zstd","rawBytes":`;
// Match the transcript's existing single-record limit, independently of maintenance throughput.
export const RUNTIME_PAYLOAD_MAX_BYTES = DURABLE_TOOL_RESULT_PROJECTION_MAX_BYTES * 2 + 256 * 1024;
export const RUNTIME_COMPRESSION_POLICY = 'json-zstd-v1:level3:minimum1024:gain-max128-10pct';
export const RUNTIME_COMPRESSIBLE_KINDS = [
  'text',
  'thinking',
  'function_call',
  'function_response',
] as const;
const utf8Decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
// Repeated transcript pages reuse immutable bytes, never mutable event objects.
// Charge both strings at UTF-16 size and bound each worker's cache to 16 MiB.
const decodedPayloads = new Map<string, string>();
const DECODED_CACHE_BYTES = 16 * 1024 * 1024;
let decodedCacheBytes = 0;

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid encoded RuntimeEvent payload');
  }
  return value as Record<string, unknown>;
}

function projection(value: Record<string, unknown>): Record<string, unknown> {
  const content = object(value.content);
  if (
    !RUNTIME_COMPRESSIBLE_KINDS.includes(
      content.kind as (typeof RUNTIME_COMPRESSIBLE_KINDS)[number],
    )
  ) {
    throw new Error('Unsupported encoded RuntimeEvent content kind');
  }
  // Keep identity/control fields directly queryable. All original fields, including
  // signatures, provider metadata, attachments and modelProjection, live in the frame.
  const fields = Object.fromEntries(
    ['kind', 'id', 'name', 'isError', 'providerExecuted', 'steering']
      .filter((key) => Object.hasOwn(content, key))
      .map((key) => [key, content[key]]),
  );
  const { [RUNTIME_PAYLOAD_MARKER]: _marker, ...event } = value;
  return { ...event, content: fields };
}

function evidence(value: Record<string, unknown>): string {
  const content = object(value.content);
  return JSON.stringify([
    value.id,
    value.sessionId,
    value.runId,
    value.invocationId,
    value.turnId,
    value.ts,
    value.partial,
    value.author,
    value.role,
    content.kind,
    content.id,
    content.name,
    content.modelProjection,
    content.providerExecuted,
  ]);
}

function frame(value: string) {
  const raw = Buffer.from(value);
  const encoded = zstdCompressSync(raw, {
    params: {
      [constants.ZSTD_c_compressionLevel]: 3,
      [constants.ZSTD_c_checksumFlag]: 1,
    },
  });
  return {
    version: 1,
    codec: 'zstd',
    rawBytes: raw.length,
    storedBytes: encoded.length,
    sha256: createHash('sha256').update(raw).digest('hex'),
    data: encoded.toString('base64'),
  };
}

function decodeFrame(value: unknown, maxBytes = RUNTIME_PAYLOAD_MAX_BYTES): string {
  const metadata = object(value);
  if (metadata.version !== 1 || metadata.codec !== 'zstd') {
    throw new Error('Unsupported RuntimeEvent storage format or codec');
  }
  const rawBytes = metadata.rawBytes;
  if (
    typeof rawBytes !== 'number' ||
    !Number.isSafeInteger(rawBytes) ||
    rawBytes < 1 ||
    rawBytes > maxBytes ||
    typeof metadata.data !== 'string' ||
    typeof metadata.storedBytes !== 'number' ||
    !Number.isSafeInteger(metadata.storedBytes) ||
    metadata.storedBytes < 1 ||
    metadata.storedBytes > RUNTIME_PAYLOAD_MAX_BYTES ||
    typeof metadata.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(metadata.sha256) ||
    metadata.data.length > Math.ceil(metadata.storedBytes / 3) * 4
  ) {
    throw new Error('Invalid RuntimeEvent storage length or checksum');
  }
  const encoded = Buffer.from(metadata.data, 'base64');
  if (encoded.length !== metadata.storedBytes || encoded.toString('base64') !== metadata.data) {
    throw new Error('Invalid RuntimeEvent storage byte stream');
  }
  const raw = zstdDecompressSync(encoded, {
    maxOutputLength: rawBytes,
    params: { [constants.ZSTD_d_windowLogMax]: 26 },
  });
  if (
    raw.length !== rawBytes ||
    createHash('sha256').update(raw).digest('hex') !== metadata.sha256
  ) {
    throw new Error('RuntimeEvent storage checksum mismatch');
  }
  return utf8Decoder.decode(raw);
}

export function runtimePayloadIsEncoded(value: string): boolean {
  return (
    value.includes(`"${RUNTIME_PAYLOAD_MARKER}"`) &&
    Object.hasOwn(object(JSON.parse(value)), RUNTIME_PAYLOAD_MARKER)
  );
}

function unpackRuntimePayload(
  value: string,
): { json: string; event: Record<string, unknown> } | undefined {
  if (!value.includes(`"${RUNTIME_PAYLOAD_MARKER}"`)) return undefined;
  const cached = decodedPayloads.get(value);
  if (cached !== undefined) {
    decodedPayloads.delete(value);
    decodedPayloads.set(value, cached);
    return { json: cached, event: object(JSON.parse(cached)) };
  }
  const envelope = object(JSON.parse(value));
  if (!Object.hasOwn(envelope, RUNTIME_PAYLOAD_MARKER)) return { json: value, event: envelope };
  if (!value.startsWith(RUNTIME_PAYLOAD_PREFIX))
    throw new Error('Invalid RuntimeEvent storage prefix');
  const metadata = object(envelope[RUNTIME_PAYLOAD_MARKER]);
  if (metadata.version !== 1 || metadata.codec !== 'zstd')
    throw new Error('Unsupported RuntimeEvent storage format or codec');
  if (!value.startsWith(`${RUNTIME_PAYLOAD_V1_PREFIX}${String(metadata.rawBytes)},"storedBytes":`))
    throw new Error('Invalid RuntimeEvent storage length header');
  const original = decodeFrame(metadata);
  const event = object(JSON.parse(original));
  const expected = projection(event);
  const { [RUNTIME_PAYLOAD_MARKER]: _marker, ...actual } = envelope;
  if (!isDeepStrictEqual(expected, actual))
    throw new Error('RuntimeEvent storage projection mismatch');
  const bytes = (value.length + original.length) * 2;
  if (bytes <= DECODED_CACHE_BYTES) {
    while (decodedCacheBytes + bytes > DECODED_CACHE_BYTES) {
      const [key, json] = decodedPayloads.entries().next().value!;
      decodedPayloads.delete(key);
      decodedCacheBytes -= (key.length + json.length) * 2;
    }
    decodedPayloads.set(value, original);
    decodedCacheBytes += bytes;
  }
  // Evidence is verified at publication and when that representation is read.
  // A body read consumes only the body frame; it must not stringify the model
  // projection again or decode another representation it never uses.
  return { json: original, event };
}

/** Restores exact UTF-8 JSON bytes; immutable retries and raw restore use this path. */
export function decodeRuntimePayloadJson(value: string): string {
  return decodedPayloads.get(value) ?? unpackRuntimePayload(value)?.json ?? value;
}

/** Decode, validate and parse once in the storage read task. */
export function parseRuntimePayloadJson(value: string): unknown {
  return unpackRuntimePayload(value)?.event ?? JSON.parse(value);
}

/** Complete persisted bodies are lossless; SQL identity and control fields remain queryable. */
export function encodeRuntimePayloadJson(value: string): { json: string | null } {
  const raw = Buffer.from(value);
  if (
    raw.length < 1024 ||
    raw.length > RUNTIME_PAYLOAD_MAX_BYTES ||
    runtimePayloadIsEncoded(value)
  ) {
    return { json: null };
  }
  const event = object(JSON.parse(value));
  const content = event.content;
  if (
    content === null ||
    typeof content !== 'object' ||
    Array.isArray(content) ||
    !RUNTIME_COMPRESSIBLE_KINDS.includes(
      (content as Record<string, unknown>).kind as (typeof RUNTIME_COMPRESSIBLE_KINDS)[number],
    ) ||
    event.partial === true
  )
    return { json: null };
  const toolEvidence =
    (content as Record<string, unknown>).kind === 'function_response' ? evidence(event) : undefined;
  const metadata = {
    ...frame(value),
    ...(toolEvidence === undefined ? {} : { evidence: frame(toolEvidence) }),
  };
  const json = JSON.stringify({ [RUNTIME_PAYLOAD_MARKER]: metadata, ...projection(event) });
  // Count the real envelope and base64 overhead, not just the codec's output.
  if (raw.length - Buffer.byteLength(json) < Math.max(128, raw.length * 0.1)) {
    return { json: null };
  }
  if (decodeRuntimePayloadJson(json) !== value)
    throw new Error('RuntimeEvent storage round trip failed');
  if (toolEvidence !== undefined && decodeFrame(metadata.evidence) !== toolEvidence)
    throw new Error('RuntimeEvent evidence round trip failed');
  return { json };
}

// Tool evidence must not load/decode an arbitrarily large raw result. Its separately
// bounded frame contains only the fields the pre-compression SQL reader selected.
export function decodeRuntimeEvidenceJson(value: string, maxBytes: number): string {
  if (value.startsWith('[')) return value;
  return decodeFrame(JSON.parse(value), maxBytes);
}

export function runtimeEvidenceSql(column: string): string {
  return `(CASE WHEN substr(${column}, 1, ${RUNTIME_PAYLOAD_PREFIX.length}) = '${RUNTIME_PAYLOAD_PREFIX}'
    THEN CASE WHEN json_valid(${column}) THEN json_extract(${column}, '$.${RUNTIME_PAYLOAD_MARKER}.evidence') END
    ELSE CASE WHEN json_valid(${column}) THEN json_extract(${column},
      '$.id', '$.sessionId', '$.runId', '$.invocationId', '$.turnId', '$.ts', '$.partial',
      '$.author', '$.role', '$.content.kind', '$.content.id', '$.content.name',
      '$.content.modelProjection', '$.content.providerExecuted') END END)`;
}

export function runtimeEvidenceBytesSql(column: string, maxBytes: number): string {
  return `(CASE WHEN substr(${column}, 1, ${RUNTIME_PAYLOAD_PREFIX.length}) = '${RUNTIME_PAYLOAD_PREFIX}'
    THEN CASE WHEN json_valid(${column}) AND json_type(${column}, '$.${RUNTIME_PAYLOAD_MARKER}.evidence.rawBytes') = 'integer'
      THEN CASE WHEN length(CAST(json_extract(${column}, '$.${RUNTIME_PAYLOAD_MARKER}.evidence') AS BLOB)) <= ${maxBytes}
        THEN json_extract(${column}, '$.${RUNTIME_PAYLOAD_MARKER}.evidence.rawBytes') ELSE ${maxBytes + 1} END END
    ELSE length(CAST(${runtimeEvidenceSql(column)} AS BLOB)) END)`;
}

/** Read quotas always count logical source bytes; unknown/bad metadata is rejected by the decoder. */
export function runtimePayloadBytesSql(column: string): string {
  return `(CASE WHEN substr(${column}, 1, ${RUNTIME_PAYLOAD_V1_PREFIX.length}) = '${RUNTIME_PAYLOAD_V1_PREFIX}'
    THEN max(CAST(substr(${column}, ${RUNTIME_PAYLOAD_V1_PREFIX.length + 1}, 10) AS INTEGER), length(CAST(${column} AS BLOB)))
    ELSE length(CAST(${column} AS BLOB)) END)`;
}
