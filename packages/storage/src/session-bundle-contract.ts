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

/**
 * Filesystem-facing contract for portable Session Bundles.
 *
 * This boundary deliberately treats Maka state as opaque bytes and files. It
 * must not acquire dependencies on Session, SQLite, JSONL, RuntimeEvent, or
 * Artifact schemas. State preparation and semantic identity validation happen
 * before this codec is called; state migration and re-keying happen after
 * hydration in the state-owning layer.
 *
 * V1 archive paths intentionally use a host-independent portability subset.
 * Every segment rejects ASCII control characters, `<`, `>`, `:`, `"`, `|`,
 * `?`, `*`, trailing dots/spaces, and case-insensitive Windows device names
 * such as `CON`, `NUL`, `COM1`, and `LPT1`, even when encoding on POSIX.
 */

export const SESSION_BUNDLE_SCHEMA_VERSION = 1 as const;
export const SESSION_BUNDLE_CODEC_NAME = 'maka-session-bundle' as const;
export const SESSION_BUNDLE_CODEC_VERSION = 1 as const;
export const SESSION_BUNDLE_CANONICALIZATION_VERSION = 1 as const;
export const SESSION_BUNDLE_ARCHIVE_FORMAT = 'ustar' as const;
export const SESSION_BUNDLE_COMPRESSION_FORMAT = 'zstd' as const;
export const SESSION_BUNDLE_COMPRESSION_LEVEL = 3 as const;

export const SESSION_BUNDLE_MANIFEST_PATH = 'manifest.json' as const;
export const SESSION_BUNDLE_STATE_IDENTITY_PATH = 'state-identity.json' as const;
export const SESSION_BUNDLE_STATE_PATH = 'state/' as const;
export const SESSION_BUNDLE_WORKSPACE_PATH = 'workspace/' as const;

export type Sha256Digest = `sha256:${string}`;

const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value);
}

/**
 * State identity is produced and semantically validated by the state layer.
 * The filesystem codec preserves these bytes exactly and never parses them.
 */
export interface OpaqueStateIdentityDescriptor {
  mediaType: string;
  bytes: Uint8Array;
}

export function copyOpaqueStateIdentityDescriptor(
  descriptor: OpaqueStateIdentityDescriptor,
): OpaqueStateIdentityDescriptor {
  if (!isRecord(descriptor)) {
    throw new TypeError('State identity descriptor must be an object');
  }
  if (!isNonEmptyUnicodeString(descriptor.mediaType)) {
    throw new TypeError('State identity mediaType must be a non-empty Unicode string');
  }
  if (!(descriptor.bytes instanceof Uint8Array)) {
    throw new TypeError('State identity bytes must be a Uint8Array');
  }
  return {
    mediaType: descriptor.mediaType,
    bytes: Uint8Array.from(descriptor.bytes),
  };
}

export interface PreparedSessionBundleSnapshot {
  stateRoot: string;
  workspaceRoot: string;
  stateIdentity: OpaqueStateIdentityDescriptor;
}

export interface SessionBundleSource {
  path: string;
  /**
   * Optional for standalone inspection, but required when the source was
   * resolved through SessionRepository.
   */
  expectedArchiveDigest?: Sha256Digest;
}

export interface SessionBundleLimits {
  maxCompressedBytes: number;
  maxDecompressedTarBytes: number;
  maxPayloadBytes: number;
  maxFileBytes: number;
  maxEntryCount: number;
  maxManifestBytes: number;
  maxStateIdentityBytes: number;
  maxPathBytes: number;
  maxPathDepth: number;
}

export type SessionBundleQuotaName = keyof SessionBundleLimits;

export const SESSION_BUNDLE_LIMIT_NAMES = [
  'maxCompressedBytes',
  'maxDecompressedTarBytes',
  'maxPayloadBytes',
  'maxFileBytes',
  'maxEntryCount',
  'maxManifestBytes',
  'maxStateIdentityBytes',
  'maxPathBytes',
  'maxPathDepth',
] as const satisfies readonly SessionBundleQuotaName[];

/**
 * Limits are caller-owned policy and intentionally have no defaults. Zero is a
 * valid fail-closed budget; negative, fractional, missing, or unsafe integers
 * are programmer/configuration errors rather than errors in an input Bundle.
 */
export function assertSessionBundleLimits(
  limits: SessionBundleLimits,
): asserts limits is SessionBundleLimits {
  if (!isRecord(limits)) throw new TypeError('Session bundle limits must be an object');
  const actualKeys = Object.keys(limits);
  if (
    actualKeys.length !== SESSION_BUNDLE_LIMIT_NAMES.length ||
    actualKeys.some((key) => !SESSION_BUNDLE_LIMIT_NAMES.includes(key as SessionBundleQuotaName))
  ) {
    throw new TypeError('Session bundle limits must contain exactly the supported quota keys');
  }
  for (const name of SESSION_BUNDLE_LIMIT_NAMES) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`Session bundle limit ${name} must be a non-negative safe integer`);
    }
  }
}

export interface SessionBundleEnvelopeInput {
  /**
   * Cloud identity allocated by the control plane. Hydration verifies this
   * binding and never silently rebinds a Bundle.
   */
  sessionId: string;
  /**
   * Optional provenance only. Activation deduplication and terminal outcomes
   * remain authoritative in the control plane's Activation store.
   */
  lastCommittedActivationId?: string;
}

export interface SessionBundlePackInput {
  snapshot: PreparedSessionBundleSnapshot;
  envelope: SessionBundleEnvelopeInput;
  destination: string;
  limits: SessionBundleLimits;
}

export interface SessionBundleReadInput {
  source: SessionBundleSource;
  limits: SessionBundleLimits;
}

export interface SessionBundleHydrateInput extends SessionBundleReadInput {
  expectedSessionId: string;
  destinationRoot: string;
}

export interface SessionBundleHydrationCleanupInput {
  /** Cleanup is restricted to codec-owned staging for this exact target. */
  destinationRoot: string;
}

export interface SessionBundleManifestV1 {
  schemaVersion: 1;
  codec: {
    name: 'maka-session-bundle';
    version: 1;
    canonicalizationVersion: 1;
    archive: 'ustar';
    compression: 'zstd';
    compressionLevel: 3;
  };
  envelope: {
    sessionId: string;
    lastCommittedActivationId?: string;
  };
  stateIdentity: {
    path: 'state-identity.json';
    mediaType: string;
  };
  payload: {
    statePath: 'state/';
    workspacePath: 'workspace/';
    treeDigest: Sha256Digest;
    payloadBytes: number;
    entryCount: number;
  };
}

export interface SessionBundleArtifact {
  path: string;
  archiveDigest: Sha256Digest;
  compressedBytes: number;
  decompressedTarBytes: number;
  payloadBytes: number;
  entryCount: number;
}

export interface SessionBundleInspection {
  manifest: SessionBundleManifestV1;
  stateIdentity: OpaqueStateIdentityDescriptor;
  archiveDigest: Sha256Digest;
  verified: true;
}

export interface SessionBundleHydration extends SessionBundleInspection {
  destinationRoot: string;
  stateRoot: string;
  workspaceRoot: string;
}

export interface SessionBundleHydrationCleanupResult {
  destinationRoot: string;
  removedStagingDirectories: number;
  removedOwnershipRecords: number;
}

export interface SessionBundleFileService {
  pack(input: SessionBundlePackInput): Promise<SessionBundleArtifact>;
  inspect(input: SessionBundleReadInput): Promise<SessionBundleInspection>;
  hydrate(input: SessionBundleHydrateInput): Promise<SessionBundleHydration>;
  cleanupHydrationStaging(
    input: SessionBundleHydrationCleanupInput,
  ): Promise<SessionBundleHydrationCleanupResult>;
}

export type SessionBundleFileErrorCode =
  | 'invalid_manifest'
  | 'unsupported_schema'
  | 'unsupported_codec'
  | 'identity_mismatch'
  | 'integrity_mismatch'
  | 'quota_exceeded'
  | 'unsafe_path'
  | 'unsupported_entry'
  | 'destination_exists'
  | 'source_changed'
  | 'io_failure';

export type SessionBundleFileOperation = 'pack' | 'inspect' | 'hydrate' | 'cleanup';

/**
 * Bounded diagnostic facts only. Raw attacker-controlled paths and strings do
 * not belong in stable error details.
 */
export interface SessionBundleFileErrorDetails {
  operation?: SessionBundleFileOperation;
  quota?: SessionBundleQuotaName;
  limit?: number;
  observed?: number;
  entryIndex?: number;
  pathDepth?: number;
}

export interface SessionBundleFileErrorOptions extends ErrorOptions {
  details?: SessionBundleFileErrorDetails;
}

export class SessionBundleFileError extends Error {
  readonly details?: Readonly<SessionBundleFileErrorDetails>;

  constructor(
    readonly code: SessionBundleFileErrorCode,
    message: string,
    options: SessionBundleFileErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SessionBundleFileError';
    if (options.details !== undefined) this.details = Object.freeze({ ...options.details });
  }
}

export function isValidUnicodeString(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

export function isNonEmptyUnicodeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isValidUnicodeString(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
