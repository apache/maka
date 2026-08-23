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
  isNonEmptyUnicodeString,
  isSha256Digest,
  SESSION_BUNDLE_ARCHIVE_FORMAT,
  SESSION_BUNDLE_CANONICALIZATION_VERSION,
  SESSION_BUNDLE_CODEC_NAME,
  SESSION_BUNDLE_CODEC_VERSION,
  SESSION_BUNDLE_COMPRESSION_FORMAT,
  SESSION_BUNDLE_COMPRESSION_LEVEL,
  SESSION_BUNDLE_SCHEMA_VERSION,
  SESSION_BUNDLE_STATE_IDENTITY_PATH,
  SESSION_BUNDLE_STATE_PATH,
  SESSION_BUNDLE_WORKSPACE_PATH,
  SessionBundleFileError,
  type SessionBundleManifestV1,
} from './session-bundle-contract.js';

const MANIFEST_KEYS = ['codec', 'envelope', 'payload', 'schemaVersion', 'stateIdentity'] as const;
const CODEC_KEYS = [
  'archive',
  'canonicalizationVersion',
  'compression',
  'compressionLevel',
  'name',
  'version',
] as const;
const ENVELOPE_KEYS = ['lastCommittedActivationId', 'sessionId'] as const;
const STATE_IDENTITY_KEYS = ['mediaType', 'path'] as const;
const PAYLOAD_KEYS = [
  'entryCount',
  'payloadBytes',
  'statePath',
  'treeDigest',
  'workspacePath',
] as const;

/**
 * Encode Manifest V1 as RFC 8785/JCS UTF-8 with no BOM or trailing newline.
 *
 * The serializer is intentionally schema-specific: the validated Manifest V1
 * value contains only objects, strings, and non-negative safe integers. This
 * keeps the portable codec independent of a general-purpose JSON dependency
 * while retaining the exact JCS ordering and ECMAScript primitive encoding
 * rules required by the format.
 */
export function encodeSessionBundleManifestV1(manifest: SessionBundleManifestV1): Uint8Array {
  const validated = decodeManifestValue(manifest);
  return new TextEncoder().encode(canonicalJson(validated));
}

/**
 * Decode and validate a canonical Manifest V1.
 *
 * Non-canonical JSON is rejected even when it would parse to the same value.
 * That rejects duplicate keys, insignificant whitespace, alternate numeric
 * spellings, BOMs, and reordered object members before an archive is trusted.
 */
export function decodeSessionBundleManifestV1(bytes: Uint8Array): SessionBundleManifestV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw invalidManifest();

  let text: string;
  let parsed: unknown;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    // JSON.parse diagnostics can contain attacker-controlled input excerpts.
    // Preserve the stable public error code without retaining the raw parser
    // failure as a cause.
    throw invalidManifest();
  }

  const manifest = decodeManifestValue(parsed);
  const canonical = encodeSessionBundleManifestV1(manifest);
  if (!equalBytes(bytes, canonical)) throw invalidManifest();
  return manifest;
}

function decodeManifestValue(value: unknown): SessionBundleManifestV1 {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS)) throw invalidManifest();

  if (value.schemaVersion !== SESSION_BUNDLE_SCHEMA_VERSION) {
    if (typeof value.schemaVersion === 'number' && Number.isSafeInteger(value.schemaVersion)) {
      throw new SessionBundleFileError(
        'unsupported_schema',
        'Session bundle schema version is not supported',
      );
    }
    throw invalidManifest();
  }

  const codec = decodeCodec(value.codec);
  const envelope = decodeEnvelope(value.envelope);
  const stateIdentity = decodeStateIdentity(value.stateIdentity);
  const payload = decodePayload(value.payload);

  return {
    schemaVersion: SESSION_BUNDLE_SCHEMA_VERSION,
    codec,
    envelope,
    stateIdentity,
    payload,
  };
}

function decodeCodec(value: unknown): SessionBundleManifestV1['codec'] {
  if (!isRecord(value) || !hasExactKeys(value, CODEC_KEYS)) throw invalidManifest();
  if (
    value.name !== SESSION_BUNDLE_CODEC_NAME ||
    value.version !== SESSION_BUNDLE_CODEC_VERSION ||
    value.canonicalizationVersion !== SESSION_BUNDLE_CANONICALIZATION_VERSION ||
    value.archive !== SESSION_BUNDLE_ARCHIVE_FORMAT ||
    value.compression !== SESSION_BUNDLE_COMPRESSION_FORMAT ||
    value.compressionLevel !== SESSION_BUNDLE_COMPRESSION_LEVEL
  ) {
    throw new SessionBundleFileError(
      'unsupported_codec',
      'Session bundle codec settings are not supported',
    );
  }
  return {
    name: SESSION_BUNDLE_CODEC_NAME,
    version: SESSION_BUNDLE_CODEC_VERSION,
    canonicalizationVersion: SESSION_BUNDLE_CANONICALIZATION_VERSION,
    archive: SESSION_BUNDLE_ARCHIVE_FORMAT,
    compression: SESSION_BUNDLE_COMPRESSION_FORMAT,
    compressionLevel: SESSION_BUNDLE_COMPRESSION_LEVEL,
  };
}

function decodeEnvelope(value: unknown): SessionBundleManifestV1['envelope'] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ENVELOPE_KEYS) ||
    !Object.hasOwn(value, 'sessionId') ||
    !isNonEmptyUnicodeString(value.sessionId)
  ) {
    throw invalidManifest();
  }
  let lastCommittedActivationId: string | undefined;
  if (Object.hasOwn(value, 'lastCommittedActivationId')) {
    if (!isNonEmptyUnicodeString(value.lastCommittedActivationId)) throw invalidManifest();
    lastCommittedActivationId = value.lastCommittedActivationId;
  }
  return {
    sessionId: value.sessionId,
    ...(lastCommittedActivationId === undefined ? {} : { lastCommittedActivationId }),
  };
}

function decodeStateIdentity(value: unknown): SessionBundleManifestV1['stateIdentity'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, STATE_IDENTITY_KEYS) ||
    value.path !== SESSION_BUNDLE_STATE_IDENTITY_PATH ||
    !isNonEmptyUnicodeString(value.mediaType)
  ) {
    throw invalidManifest();
  }
  return {
    path: SESSION_BUNDLE_STATE_IDENTITY_PATH,
    mediaType: value.mediaType,
  };
}

function decodePayload(value: unknown): SessionBundleManifestV1['payload'] {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    value.statePath !== SESSION_BUNDLE_STATE_PATH ||
    value.workspacePath !== SESSION_BUNDLE_WORKSPACE_PATH ||
    !isSha256Digest(value.treeDigest) ||
    !isNonNegativeSafeInteger(value.payloadBytes) ||
    !isNonNegativeSafeInteger(value.entryCount) ||
    value.entryCount < 3
  ) {
    throw invalidManifest();
  }
  return {
    statePath: SESSION_BUNDLE_STATE_PATH,
    workspacePath: SESSION_BUNDLE_WORKSPACE_PATH,
    treeDigest: value.treeDigest,
    payloadBytes: value.payloadBytes,
    entryCount: value.entryCount,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidManifest();
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (!isRecord(value)) throw invalidManifest();
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidManifest(): SessionBundleFileError {
  return new SessionBundleFileError(
    'invalid_manifest',
    'Session bundle manifest is invalid or non-canonical',
  );
}
