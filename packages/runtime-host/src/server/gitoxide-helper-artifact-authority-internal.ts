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
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const HASH_BUFFER_BYTES = 64 * 1024;
const MAX_HELPER_ARTIFACT_BYTES = 256 * 1024 * 1024;
export const GITOXIDE_HELPER_OPERATIONS_INTERNAL = Object.freeze([
  'inspect_repository',
  'import_source_head',
  'create_candidate',
  'read_tree_file',
] as const);
export type GitoxideHelperOperationInternal = (typeof GITOXIDE_HELPER_OPERATIONS_INTERNAL)[number];

export interface GitoxideHelperReleaseArtifactClaim {
  readonly kind: 'gitoxide_helper_release_artifact_claim_v1';
}

export interface GitoxideHelperInvocationCapability {
  readonly kind: 'gitoxide_helper_invocation_capability_v1';
}

export interface GitoxideHelperReleaseArtifactStateInternal {
  readonly executablePath: string;
  readonly expectedSha256: `sha256:${string}`;
  readonly expectedBytes: number;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly protocolVersion: 1;
  readonly supportedOperations: readonly GitoxideHelperOperationInternal[];
}

export interface VerifiedGitoxideHelperArtifactInternal {
  readonly executablePath: string;
  readonly protocolVersion: 1;
  readonly supportedOperations: readonly GitoxideHelperOperationInternal[];
}

export interface GitoxideHelperArtifactIdentityInternal {
  readonly sha256: `sha256:${string}`;
  readonly bytes: number;
  readonly protocolVersion: 1;
  readonly supportedOperations: readonly GitoxideHelperOperationInternal[];
}

export type GitoxideHelperArtifactAuthorityErrorCode =
  | 'gitoxide_helper_release_claim_invalid'
  | 'gitoxide_helper_release_claim_unsupported'
  | 'gitoxide_helper_artifact_invalid'
  | 'gitoxide_helper_artifact_identity_mismatch'
  | 'gitoxide_helper_invocation_capability_invalid';

export class GitoxideHelperArtifactAuthorityError extends Error {
  constructor(
    readonly code: GitoxideHelperArtifactAuthorityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GitoxideHelperArtifactAuthorityError';
  }
}

interface ReleaseClaimRecord extends GitoxideHelperReleaseArtifactStateInternal {
  readonly releaseOwnerToken: object;
}

interface InvocationCapabilityRecord {
  readonly invocationOwnerToken: object;
  readonly claim: ReleaseClaimRecord;
  readonly canonicalExecutablePath: string;
}

const releaseClaims = new WeakMap<object, ReleaseClaimRecord>();
const invocationCapabilities = new WeakMap<object, InvocationCapabilityRecord>();

/**
 * Internal seam for the future packaged-release owner. This function is not
 * exported from @maka/runtime-host/server and does not establish the platform
 * signing trust root by itself.
 */
export function issueGitoxideHelperReleaseArtifactClaimInternal(
  releaseOwnerToken: object,
  state: GitoxideHelperReleaseArtifactStateInternal,
): GitoxideHelperReleaseArtifactClaim {
  assertReleaseArtifactState(state);
  const claim = Object.freeze({
    kind: 'gitoxide_helper_release_artifact_claim_v1' as const,
  });
  releaseClaims.set(
    claim,
    Object.freeze({
      ...state,
      supportedOperations: Object.freeze([...state.supportedOperations]),
      releaseOwnerToken,
    }),
  );
  return claim;
}

export async function admitGitoxideHelperArtifactInternal(input: {
  readonly releaseOwnerToken: object;
  readonly invocationOwnerToken: object;
  readonly claim: GitoxideHelperReleaseArtifactClaim;
}): Promise<GitoxideHelperInvocationCapability> {
  const claim = releaseClaims.get(input.claim);
  if (!claim || claim.releaseOwnerToken !== input.releaseOwnerToken) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_release_claim_invalid',
      'Gitoxide helper release artifact claim is invalid for this release owner',
    );
  }
  if (claim.platform !== process.platform || claim.arch !== process.arch) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_release_claim_unsupported',
      `Gitoxide helper release artifact does not support ${process.platform}/${process.arch}`,
    );
  }

  const canonicalExecutablePath = await verifyArtifact(claim);
  const capability = Object.freeze({
    kind: 'gitoxide_helper_invocation_capability_v1' as const,
  });
  invocationCapabilities.set(capability, {
    invocationOwnerToken: input.invocationOwnerToken,
    claim,
    canonicalExecutablePath,
  });
  return capability;
}

export async function verifyGitoxideHelperArtifactForInvocationInternal(
  invocationOwnerToken: object,
  capability: GitoxideHelperInvocationCapability,
): Promise<VerifiedGitoxideHelperArtifactInternal> {
  const record = invocationCapabilities.get(capability);
  if (!record || record.invocationOwnerToken !== invocationOwnerToken) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_invocation_capability_invalid',
      'Gitoxide helper invocation capability is invalid for this owner',
    );
  }

  const canonicalExecutablePath = await verifyArtifact(record.claim);
  if (canonicalExecutablePath !== record.canonicalExecutablePath) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_artifact_identity_mismatch',
      'Gitoxide helper canonical executable path changed after admission',
    );
  }
  return Object.freeze({
    executablePath: canonicalExecutablePath,
    protocolVersion: record.claim.protocolVersion,
    supportedOperations: record.claim.supportedOperations,
  });
}

export function requireGitoxideHelperArtifactIdentityInternal(
  invocationOwnerToken: object,
  capability: GitoxideHelperInvocationCapability,
): GitoxideHelperArtifactIdentityInternal {
  const record = invocationCapabilities.get(capability);
  if (!record || record.invocationOwnerToken !== invocationOwnerToken) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_invocation_capability_invalid',
      'Gitoxide helper invocation capability is invalid for this owner',
    );
  }
  return Object.freeze({
    sha256: record.claim.expectedSha256,
    bytes: record.claim.expectedBytes,
    protocolVersion: record.claim.protocolVersion,
    supportedOperations: record.claim.supportedOperations,
  });
}

export function requireGitoxideHelperOperationsInternal(
  invocationOwnerToken: object,
  capability: GitoxideHelperInvocationCapability,
  requiredOperations: readonly GitoxideHelperOperationInternal[],
): void {
  const record = invocationCapabilities.get(capability);
  if (!record || record.invocationOwnerToken !== invocationOwnerToken) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_invocation_capability_invalid',
      'Gitoxide helper invocation capability is invalid for this owner',
    );
  }
  const supported = new Set(record.claim.supportedOperations);
  if (requiredOperations.some((operation) => !supported.has(operation))) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_release_claim_unsupported',
      'Gitoxide helper release artifact does not attest the required operations',
    );
  }
}

function assertReleaseArtifactState(state: GitoxideHelperReleaseArtifactStateInternal): void {
  if (
    typeof state.executablePath !== 'string' ||
    state.executablePath.length === 0 ||
    !isAbsolute(state.executablePath) ||
    !SHA256_PATTERN.test(state.expectedSha256) ||
    !Number.isSafeInteger(state.expectedBytes) ||
    state.expectedBytes < 1 ||
    state.expectedBytes > MAX_HELPER_ARTIFACT_BYTES ||
    typeof state.platform !== 'string' ||
    state.platform.length === 0 ||
    typeof state.arch !== 'string' ||
    state.arch.length === 0 ||
    state.protocolVersion !== 1 ||
    !isExactSupportedOperations(state.supportedOperations)
  ) {
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_release_claim_invalid',
      'Gitoxide helper release artifact state is invalid',
    );
  }
}

function isExactSupportedOperations(
  operations: readonly GitoxideHelperOperationInternal[],
): boolean {
  return (
    Array.isArray(operations) &&
    operations.length > 0 &&
    new Set(operations).size === operations.length &&
    operations.every((operation) => GITOXIDE_HELPER_OPERATIONS_INTERNAL.includes(operation))
  );
}

async function verifyArtifact(claim: ReleaseClaimRecord): Promise<string> {
  let canonicalExecutablePath: string;
  let handle;
  try {
    await assertNoSymbolicLinkComponents(claim.executablePath);
    canonicalExecutablePath = await realpath(claim.executablePath);
    handle = await open(canonicalExecutablePath, 'r');
    const initialInfo = await handle.stat({ bigint: true });
    if (!initialInfo.isFile() || initialInfo.size !== BigInt(claim.expectedBytes)) {
      throw new GitoxideHelperArtifactAuthorityError(
        'gitoxide_helper_artifact_identity_mismatch',
        'Gitoxide helper artifact size or file type does not match its release claim',
      );
    }

    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
    let position = 0;
    while (position < claim.expectedBytes) {
      const length = Math.min(buffer.length, claim.expectedBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (position !== claim.expectedBytes) {
      throw new GitoxideHelperArtifactAuthorityError(
        'gitoxide_helper_artifact_identity_mismatch',
        'Gitoxide helper artifact changed while its identity was verified',
      );
    }
    const finalHandleInfo = await handle.stat({ bigint: true });
    const finalPathInfo = await lstat(canonicalExecutablePath, { bigint: true });
    if (
      !sameFileSnapshot(initialInfo, finalHandleInfo) ||
      !sameFileIdentity(finalHandleInfo, finalPathInfo)
    ) {
      throw new GitoxideHelperArtifactAuthorityError(
        'gitoxide_helper_artifact_identity_mismatch',
        'Gitoxide helper artifact changed while its identity was verified',
      );
    }
    const actualSha256 = `sha256:${digest.digest('hex')}`;
    if (actualSha256 !== claim.expectedSha256) {
      throw new GitoxideHelperArtifactAuthorityError(
        'gitoxide_helper_artifact_identity_mismatch',
        'Gitoxide helper artifact digest does not match its release claim',
      );
    }
  } catch (error) {
    if (error instanceof GitoxideHelperArtifactAuthorityError) throw error;
    throw new GitoxideHelperArtifactAuthorityError(
      'gitoxide_helper_artifact_invalid',
      `Gitoxide helper artifact could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return canonicalExecutablePath;
}

function sameFileIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameFileSnapshot(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function assertNoSymbolicLinkComponents(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const segments = relative(root, absolutePath).split(sep).filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    cursor = join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new GitoxideHelperArtifactAuthorityError(
        'gitoxide_helper_artifact_invalid',
        'Gitoxide helper artifact path must not traverse a symbolic link or junction',
      );
    }
  }
}
