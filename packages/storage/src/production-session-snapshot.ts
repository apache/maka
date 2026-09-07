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

import { Buffer } from 'node:buffer';
import { constants as fsConstants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  assertSessionBundleLimits,
  type OpaqueStateIdentityDescriptor,
  type SessionBundleArtifact,
  type SessionBundleFileService,
  type SessionBundleLimits,
} from './session-bundle-contract.js';
import { createSessionBundleFileService } from './session-bundle-file-service.js';
import { exportSessionBundleState } from './session-bundle-policy.js';
import {
  createFileQuiescentSessionSnapshotCoordinator,
  createFileSessionSnapshotStagingCleanupAuthority,
  type PreparedSessionBundleHandle,
  type SessionSnapshotCancellation,
  SessionSnapshotError,
  type SessionSnapshotPrivateStagingRootAuthority,
  type SessionSnapshotQuiescenceAuthority,
  type SessionSnapshotStagingCleanupRecovery,
  type SessionSnapshotWorkspaceConfirmationResolver,
  type SessionSnapshotWorkspaceConfirmationAuthority,
  type SessionSnapshotWorkspaceEntry,
  type SessionSnapshotWorkspaceExclusionCategory,
  type SessionSnapshotWorkspacePolicy,
  type SessionSnapshotWorkspacePreparer,
  type SessionSnapshotWorkspacePreparation,
  type SessionSnapshotStatePreparer,
} from './quiescent-session-snapshot.js';
import { isSessionBundleUstarPathV1 } from './session-bundle-ustar.js';
import type { ProcessLifetimeOwner } from './process-lifetime-owner.js';
import { isSafeSessionId } from './session-store.js';

/** State-layer-owned descriptor format; the Bundle codec only transports these bytes. */
export const SESSION_SNAPSHOT_STATE_IDENTITY_MEDIA_TYPE =
  'application/vnd.maka.session-state-identity+json;version=1';

const NO_FOLLOW_OPEN_FLAG = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
const WORKSPACE_COPY_CHUNK_BYTES = 64 * 1024;

export interface FileSessionSnapshotStatePreparerOptions {
  /** Session-owned state root, never the host configuration root. */
  readonly stateRoot: string;
  /** Host configuration root; it is checked by the exporter but never copied. */
  readonly configRoot: string;
}

/**
 * Creates the production state adapter for #2369. The existing state exporter
 * owns semantic filtering and SQLite backup; this adapter only binds it to the
 * quiescent-snapshot contract and emits the opaque identity descriptor.
 */
export function createFileSessionSnapshotStatePreparer(
  options: FileSessionSnapshotStatePreparerOptions,
): SessionSnapshotStatePreparer {
  const stateRoot = requireAbsolutePath(options.stateRoot, 'stateRoot');
  const configRoot = requireAbsolutePath(options.configRoot, 'configRoot');
  return {
    async prepareState(input): Promise<OpaqueStateIdentityDescriptor> {
      assertSnapshotActive(input.cancellation, 'state');
      const destinationRoot = requireAbsolutePath(input.destinationRoot, 'destinationRoot');
      try {
        await exportSessionBundleState({
          stateRoot,
          configRoot,
          destinationRoot,
          sessionId: input.makaSessionId,
        });
      } catch (error) {
        throw asSnapshotError(
          'io_failure',
          'Unable to export Session snapshot state',
          'state',
          error,
        );
      }
      assertSnapshotActive(input.cancellation, 'state');
      return createSessionSnapshotStateIdentity(input.makaSessionId);
    },
  };
}

export function createSessionSnapshotStateIdentity(
  makaSessionId: string,
): OpaqueStateIdentityDescriptor {
  if (typeof makaSessionId !== 'string' || makaSessionId.length === 0) {
    throw new TypeError('Session snapshot Maka Session identity is required');
  }
  return Object.freeze({
    mediaType: SESSION_SNAPSHOT_STATE_IDENTITY_MEDIA_TYPE,
    bytes: Uint8Array.from(
      Buffer.from(`${JSON.stringify({ schemaVersion: 1, makaSessionId })}\n`, 'utf8'),
    ),
  });
}

export interface FileSessionSnapshotWorkspacePreparerOptions {
  /** The live workspace root for one Session. */
  readonly workspaceRoot: string;
  /** Required, bounded Bundle policy; snapshot copying never has unlimited quotas. */
  readonly limits: SessionBundleLimits;
  /** Internal production composition hook that reserves already-staged state budget. */
  readonly remainingLimitsForDestinationRoot?: (destinationRoot: string) => SessionBundleLimits;
}

/**
 * Copies a workspace under the coordinator's pinned policy. It deliberately
 * does not accept a caller-supplied policy: the coordinator supplies that
 * policy at invocation time and this preparer applies every decision.
 */
export function createFileSessionSnapshotWorkspacePreparer(
  options: FileSessionSnapshotWorkspacePreparerOptions,
): SessionSnapshotWorkspacePreparer {
  const workspaceRoot = requireAbsolutePath(options.workspaceRoot, 'workspaceRoot');
  assertSessionBundleLimits(options.limits);
  const limits = Object.freeze({ ...options.limits });
  return {
    async prepareWorkspace(input): Promise<SessionSnapshotWorkspacePreparation> {
      assertSnapshotActive(input.cancellation, 'workspace');
      const destinationRoot = requireAbsolutePath(input.destinationRoot, 'destinationRoot');
      const effectiveLimits =
        options.remainingLimitsForDestinationRoot?.(destinationRoot) ?? limits;
      assertSessionBundleLimits(effectiveLimits);
      const sourceRoot = await canonicalWorkspaceRoot(workspaceRoot);
      await assertMissing(destinationRoot, 'Workspace snapshot destination already exists');
      await mkdir(destinationRoot, { mode: 0o700 });

      const budget: WorkspaceCopyBudget = {
        includedEntries: 0,
        excludedEntries: 0,
        payloadBytes: 0,
        exclusions: emptyExclusionCounts(),
        seenCaseFoldedPaths: new Map(),
      };
      try {
        await copyWorkspaceDirectory({
          sourceDirectory: sourceRoot.path,
          destinationDirectory: destinationRoot,
          relativeDirectory: '',
          expectedDirectoryIdentity: sourceRoot.identity,
          policy: input.policy,
          confirmation: input.confirmation,
          cancellation: input.cancellation,
          limits: effectiveLimits,
          budget,
        });
      } catch (error) {
        if (error instanceof SessionSnapshotError) throw error;
        throw asSnapshotError(
          'io_failure',
          'Unable to prepare Session snapshot workspace',
          'workspace',
          error,
        );
      }
      assertSnapshotActive(input.cancellation, 'workspace');
      return Object.freeze({
        includedEntries: budget.includedEntries,
        excludedEntries: budget.excludedEntries,
        excludedEntriesByCategory: Object.freeze({ ...budget.exclusions }),
        payloadBytes: budget.payloadBytes,
      });
    },
  };
}

export interface FileProductionSessionSnapshotServiceOptions {
  /**
   * Host-authorized binding for this one production snapshot service. Callers
   * cannot select a Maka Session, workspace, and Cloud envelope independently.
   */
  readonly session: ProductionSessionSnapshotBinding;
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly workspaceRoot: string;
  readonly stagingParent: string;
  /** Separate durable root for the staging-cleanup lease database. */
  readonly cleanupStateRoot: string;
  readonly processLifetimeOwner: ProcessLifetimeOwner;
  readonly quiescence: SessionSnapshotQuiescenceAuthority;
  readonly limits: SessionBundleLimits;
  readonly bundleFileService?: SessionBundleFileService;
  readonly privateStagingRootAuthority?: SessionSnapshotPrivateStagingRootAuthority;
  readonly confirmationAuthority?: SessionSnapshotWorkspaceConfirmationAuthority;
}

export interface ProductionSessionSnapshotBinding {
  /** Runtime/storage identity whose state and workspace this service snapshots. */
  readonly makaSessionId: string;
  /** Control-plane identity embedded in and verified against the Bundle envelope. */
  readonly cloudSessionId: string;
}

export interface PackQuiescentSessionBundleInput {
  readonly destination: string;
  readonly lastCommittedActivationId?: string;
  readonly confirmationGrantId?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

/**
 * Cleanup of the private staging copy after the immutable Bundle is written.
 * A pending cleanup does not invalidate the already-written Bundle; callers
 * should record the failure. Its persisted lease becomes eligible for recovery
 * after the current process lifetime ends.
 */
export type SessionSnapshotPackCleanup =
  | { readonly state: 'released' }
  | { readonly state: 'pending_recovery'; readonly error: SessionSnapshotError };

/**
 * A production Bundle artifact plus the status of its separate private-staging
 * cleanup. The artifact fields remain available at the top level so existing
 * consumers can use it as an ordinary SessionBundleArtifact.
 */
export interface ProductionSessionBundleArtifact extends SessionBundleArtifact {
  readonly snapshotCleanup: SessionSnapshotPackCleanup;
}

export interface FileProductionSessionSnapshotService {
  recover(): Promise<SessionSnapshotStagingCleanupRecovery>;
  prepare(input: {
    readonly confirmationGrantId?: string;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
  }): Promise<PreparedSessionBundleHandle>;
  pack(input: PackQuiescentSessionBundleInput): Promise<ProductionSessionBundleArtifact>;
}

/**
 * Production composition and first codec call site for #2369. Startup awaits
 * persisted staging recovery before this function resolves, so callers cannot
 * serve snapshot requests while an earlier process's private staging is still
 * unreconciled.
 */
export async function createFileProductionSessionSnapshotService(
  options: FileProductionSessionSnapshotServiceOptions,
): Promise<FileProductionSessionSnapshotService> {
  const session = requireProductionSessionSnapshotBinding(options.session);
  assertSessionBundleLimits(options.limits);
  const limits = Object.freeze({ ...options.limits });
  const stagingCleanup = createFileSessionSnapshotStagingCleanupAuthority({
    cleanupStateRoot: requireAbsolutePath(options.cleanupStateRoot, 'cleanupStateRoot'),
    stagingParent: requireAbsolutePath(options.stagingParent, 'stagingParent'),
    processLifetimeOwner: options.processLifetimeOwner,
    privateStagingRootAuthority: options.privateStagingRootAuthority,
  });
  await stagingCleanup.recover();
  await assertProductionRootsSeparate({
    stateRoot: options.stateRoot,
    configRoot: options.configRoot,
    workspaceRoot: options.workspaceRoot,
    stagingParent: stagingCleanup.stagingParent,
    cleanupStateRoot: options.cleanupStateRoot,
  });
  const stateBudgetsByStagingRoot = new Map<string, SnapshotStagingBudget>();
  const fileStatePreparer = createFileSessionSnapshotStatePreparer({
    stateRoot: options.stateRoot,
    configRoot: options.configRoot,
  });
  const state: SessionSnapshotStatePreparer = {
    async prepareState(input): Promise<OpaqueStateIdentityDescriptor> {
      const identity = await fileStatePreparer.prepareState(input);
      const payload = await measurePreparedStatePayload(
        input.destinationRoot,
        limits,
        input.cancellation,
      );
      const budget = reserveStateBundleBudget(payload, identity, limits);
      stateBudgetsByStagingRoot.set(dirname(input.destinationRoot), budget);
      return identity;
    },
  };
  const workspace = createFileSessionSnapshotWorkspacePreparer({
    workspaceRoot: options.workspaceRoot,
    limits,
    remainingLimitsForDestinationRoot(destinationRoot) {
      const stagingRoot = dirname(destinationRoot);
      const stateBudget = stateBudgetsByStagingRoot.get(stagingRoot);
      if (!stateBudget) {
        throw new SessionSnapshotError(
          'io_failure',
          'Session snapshot state budget is unavailable for workspace copying',
          { details: { phase: 'workspace' } },
        );
      }
      return deriveWorkspaceLimits(limits, stateBudget);
    },
  });
  const coordinator = createFileQuiescentSessionSnapshotCoordinator({
    stagingParent: stagingCleanup.stagingParent,
    stagingCleanup,
    quiescence: options.quiescence,
    state,
    workspace,
    confirmationAuthority: options.confirmationAuthority,
    privateStagingRootAuthority: options.privateStagingRootAuthority,
  });
  const bundleFileService = options.bundleFileService ?? createSessionBundleFileService();
  const prepare = async (input: {
    readonly confirmationGrantId?: string;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
  }): Promise<PreparedSessionBundleHandle> => {
    try {
      return await coordinator.prepare({ ...input, makaSessionId: session.makaSessionId });
    } finally {
      stateBudgetsByStagingRoot.clear();
    }
  };
  return Object.freeze({
    recover: () => stagingCleanup.recover(),
    prepare,
    async pack(input: PackQuiescentSessionBundleInput): Promise<ProductionSessionBundleArtifact> {
      const prepared = await prepare(input);
      let artifact: SessionBundleArtifact | undefined;
      let primaryFailure: unknown;
      try {
        artifact = await bundleFileService.pack({
          snapshot: prepared.snapshot,
          envelope: {
            sessionId: session.cloudSessionId,
            ...(input.lastCommittedActivationId === undefined
              ? {}
              : { lastCommittedActivationId: input.lastCommittedActivationId }),
          },
          destination: input.destination,
          limits,
        });
      } catch (error) {
        primaryFailure = error;
      }
      let cleanup: SessionSnapshotPackCleanup = { state: 'released' };
      try {
        await prepared.release();
      } catch (cleanupFailure) {
        const error = normalizePackCleanupFailure(cleanupFailure);
        if (primaryFailure !== undefined) {
          throw new AggregateError(
            [primaryFailure, error],
            'Session Bundle packing failed and snapshot cleanup also failed',
          );
        }
        cleanup = { state: 'pending_recovery', error };
      }
      if (primaryFailure !== undefined) throw primaryFailure;
      if (!artifact) throw new Error('Session Bundle packing completed without an artifact');
      return Object.freeze({ ...artifact, snapshotCleanup: Object.freeze(cleanup) });
    },
  });
}

function normalizePackCleanupFailure(error: unknown): SessionSnapshotError {
  if (error instanceof SessionSnapshotError && error.code === 'cleanup_failed') return error;
  return new SessionSnapshotError('cleanup_failed', 'Session snapshot cleanup failed', {
    cause: error,
    details: { phase: 'cleanup' },
  });
}

type WorkspaceCopyBudget = {
  includedEntries: number;
  excludedEntries: number;
  payloadBytes: number;
  exclusions: Record<SessionSnapshotWorkspaceExclusionCategory, number>;
  seenCaseFoldedPaths: Map<string, string>;
};

type SnapshotStagingBudget = {
  /** Includes state-identity.json and the state/ + workspace/ root entries. */
  readonly entryCount: number;
  /** Includes state files and state-identity.json, but never directories. */
  readonly payloadBytes: number;
};

async function measurePreparedStatePayload(
  root: string,
  limits: SessionBundleLimits,
  cancellation: SessionSnapshotCancellation,
): Promise<{ readonly entryCount: number; readonly payloadBytes: number }> {
  const budget = { entryCount: 0, payloadBytes: 0 };
  await measurePreparedStateDirectory(root, budget, limits, cancellation);
  return budget;
}

async function measurePreparedStateDirectory(
  directory: string,
  budget: { entryCount: number; payloadBytes: number },
  limits: SessionBundleLimits,
  cancellation: SessionSnapshotCancellation,
): Promise<void> {
  assertSnapshotActive(cancellation, 'state');
  const metadata = await lstatBigInt(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SessionSnapshotError('unsafe_source', 'Prepared Session state is unsafe', {
      details: { phase: 'state' },
    });
  }
  const children = await readdir(directory, { encoding: 'buffer', withFileTypes: true });
  for (const child of children) {
    assertSnapshotActive(cancellation, 'state');
    const name = decodeFilesystemName(child.name);
    const path = join(directory, name);
    const childMetadata = await lstatBigInt(path);
    if (childMetadata.isSymbolicLink()) {
      throw new SessionSnapshotError('unsafe_source', 'Prepared Session state is unsafe', {
        details: { phase: 'state' },
      });
    }
    if (childMetadata.isDirectory()) {
      budget.entryCount = reserveStateEntry(budget.entryCount, limits);
      await measurePreparedStateDirectory(path, budget, limits, cancellation);
      continue;
    }
    if (!childMetadata.isFile()) {
      throw new SessionSnapshotError('unsafe_source', 'Prepared Session state is unsafe', {
        details: { phase: 'state' },
      });
    }
    if (childMetadata.nlink !== 1n) {
      throw new SessionSnapshotError('unsafe_source', 'Prepared Session state is unsafe', {
        details: { phase: 'state' },
      });
    }
    const bytes = safeSize(childMetadata.size);
    if (bytes > limits.maxFileBytes) throw stateQuotaExceeded();
    budget.payloadBytes = reserveStatePayload(budget.payloadBytes, bytes, limits);
    budget.entryCount = reserveStateEntry(budget.entryCount, limits);
  }
}

function reserveStateBundleBudget(
  state: { readonly entryCount: number; readonly payloadBytes: number },
  identity: OpaqueStateIdentityDescriptor,
  limits: SessionBundleLimits,
): SnapshotStagingBudget {
  const identityBytes = identity.bytes.byteLength;
  if (identityBytes > limits.maxStateIdentityBytes || identityBytes > limits.maxFileBytes) {
    throw stateQuotaExceeded();
  }
  const payloadBytes = reserveStatePayload(state.payloadBytes, identityBytes, limits);
  // state-identity.json, state/, and workspace/ are always emitted by the codec.
  const entryCount = reserveStateEntry(
    reserveStateEntry(reserveStateEntry(state.entryCount, limits), limits),
    limits,
  );
  return Object.freeze({ entryCount, payloadBytes });
}

function deriveWorkspaceLimits(
  limits: SessionBundleLimits,
  reserved: SnapshotStagingBudget,
): SessionBundleLimits {
  if (
    reserved.payloadBytes > limits.maxPayloadBytes ||
    reserved.entryCount > limits.maxEntryCount
  ) {
    throw stateQuotaExceeded();
  }
  return Object.freeze({
    ...limits,
    maxPayloadBytes: limits.maxPayloadBytes - reserved.payloadBytes,
    maxEntryCount: limits.maxEntryCount - reserved.entryCount,
  });
}

function reserveStatePayload(current: number, added: number, limits: SessionBundleLimits): number {
  const next = safeAdd(current, added);
  if (next > limits.maxPayloadBytes) throw stateQuotaExceeded();
  return next;
}

function reserveStateEntry(current: number, limits: SessionBundleLimits): number {
  const next = safeAdd(current, 1);
  if (next > limits.maxEntryCount) throw stateQuotaExceeded();
  return next;
}

function stateQuotaExceeded(): SessionSnapshotError {
  return new SessionSnapshotError('quota_exceeded', 'Session snapshot state exceeds Bundle quota', {
    details: { phase: 'state' },
  });
}

async function copyWorkspaceDirectory(input: {
  readonly sourceDirectory: string;
  readonly destinationDirectory: string;
  readonly relativeDirectory: string;
  readonly expectedDirectoryIdentity?: FilesystemIdentity;
  readonly policy: SessionSnapshotWorkspacePolicy;
  readonly confirmation: SessionSnapshotWorkspaceConfirmationResolver;
  readonly cancellation: SessionSnapshotCancellation;
  readonly limits: SessionBundleLimits;
  readonly budget: WorkspaceCopyBudget;
}): Promise<void> {
  assertSnapshotActive(input.cancellation, 'workspace');
  const directoryBefore = await readDirectoryFingerprint(input.sourceDirectory);
  if (
    input.expectedDirectoryIdentity !== undefined &&
    !sameFilesystemIdentity(directoryBefore, input.expectedDirectoryIdentity)
  ) {
    throw new SessionSnapshotError('source_changed', 'Workspace root changed before copying', {
      details: { phase: 'workspace' },
    });
  }
  const children = await readdir(input.sourceDirectory, {
    encoding: 'buffer',
    withFileTypes: true,
  });
  const normalized = children
    .map((child) => decodeFilesystemName(child.name))
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  for (const name of normalized) {
    assertSnapshotActive(input.cancellation, 'workspace');
    const relativePath =
      input.relativeDirectory.length === 0 ? name : `${input.relativeDirectory}/${name}`;
    const sourcePath = join(input.sourceDirectory, name);
    const destinationPath = join(input.destinationDirectory, name);
    const metadata = await lstatBigInt(sourcePath);
    const entry = classifyFilesystemEntry(relativePath, metadata);
    registerWorkspacePath(input.budget, relativePath);
    assertWorkspacePathBudget(relativePath, entry.kind, input.limits);

    const policyDecision = input.policy.classify(entry);
    if (policyDecision.kind === 'reject') {
      throw new SessionSnapshotError(
        'policy_rejected',
        'Workspace snapshot policy rejected an entry',
        { details: { phase: 'workspace', policyCategory: policyDecision.category } },
      );
    }
    if (policyDecision.kind === 'exclude') {
      recordExclusion(input.budget, policyDecision.category);
      continue;
    }
    if (policyDecision.kind === 'confirm') {
      const resolution = await input.confirmation.resolve(entry);
      assertSnapshotActive(input.cancellation, 'workspace');
      if (resolution.kind === 'exclude') {
        recordExclusion(input.budget, resolution.category);
        continue;
      }
    }

    if (entry.kind === 'directory') {
      await mkdir(destinationPath, { mode: 0o700 });
      recordIncludedEntry(input.budget, input.limits);
      await copyWorkspaceDirectory({
        ...input,
        sourceDirectory: sourcePath,
        destinationDirectory: destinationPath,
        relativeDirectory: relativePath,
        expectedDirectoryIdentity: undefined,
      });
      continue;
    }

    const before = fileFingerprint(metadata);
    const bytes = safeSize(metadata.size);
    assertWorkspaceFileQuota(bytes, input.budget, input.limits);
    recordIncludedEntry(input.budget, input.limits);
    await copyWorkspaceFile({
      sourcePath,
      destinationPath,
      expected: before,
      expectedSize: bytes,
      sourceMetadata: metadata,
      cancellation: input.cancellation,
    });
    const after = await lstatBigInt(sourcePath);
    const destination = await lstatBigInt(destinationPath);
    if (
      !after.isFile() ||
      after.nlink !== 1n ||
      !sameFileFingerprint(before, fileFingerprint(after)) ||
      !destination.isFile() ||
      destination.isSymbolicLink() ||
      destination.nlink !== 1n ||
      destination.size !== metadata.size
    ) {
      throw new SessionSnapshotError('source_changed', 'Workspace changed while being copied', {
        details: { phase: 'workspace' },
      });
    }
    input.budget.payloadBytes += bytes;
  }
  const directoryAfter = await readDirectoryFingerprint(input.sourceDirectory);
  if (!sameDirectoryFingerprint(directoryBefore, directoryAfter)) {
    throw new SessionSnapshotError('source_changed', 'Workspace changed while being copied', {
      details: { phase: 'workspace' },
    });
  }
}

function classifyFilesystemEntry(
  relativePath: string,
  metadata: BigIntStats,
): SessionSnapshotWorkspaceEntry {
  if (metadata.isSymbolicLink()) {
    throw new SessionSnapshotError('unsafe_source', 'Workspace contains a symbolic link', {
      details: { phase: 'workspace', policyCategory: 'unsafe_path' },
    });
  }
  if (metadata.isDirectory()) return { relativePath, kind: 'directory' };
  if (metadata.isFile()) {
    if (metadata.nlink !== 1n) {
      throw new SessionSnapshotError('unsafe_source', 'Workspace contains a hard-linked file', {
        details: { phase: 'workspace', policyCategory: 'unsafe_path' },
      });
    }
    return { relativePath, kind: 'file' };
  }
  throw new SessionSnapshotError('unsafe_source', 'Workspace contains an unsupported entry', {
    details: { phase: 'workspace', policyCategory: 'unsupported_entry' },
  });
}

function assertWorkspacePathBudget(
  relativePath: string,
  kind: SessionSnapshotWorkspaceEntry['kind'],
  limits: SessionBundleLimits,
): void {
  const archivePath = `workspace/${relativePath}${kind === 'directory' ? '/' : ''}`;
  if (!isSessionBundleUstarPathV1(archivePath)) {
    throw new SessionSnapshotError(
      'unsafe_source',
      'Workspace path is not portable in Session Bundles',
      {
        details: {
          phase: 'workspace',
          policyCategory: 'unsupported_portable_path',
          observed: 1,
        },
      },
    );
  }
  if (
    Buffer.byteLength(archivePath, 'utf8') > limits.maxPathBytes ||
    archivePath.replace(/\/$/u, '').split('/').length > limits.maxPathDepth
  ) {
    throw new SessionSnapshotError('quota_exceeded', 'Workspace path exceeds Bundle quota', {
      details: { phase: 'workspace' },
    });
  }
}

function assertWorkspaceFileQuota(
  bytes: number,
  budget: WorkspaceCopyBudget,
  limits: SessionBundleLimits,
): void {
  if (bytes > limits.maxFileBytes || safeAdd(budget.payloadBytes, bytes) > limits.maxPayloadBytes) {
    throw new SessionSnapshotError('quota_exceeded', 'Workspace payload exceeds Bundle quota', {
      details: { phase: 'workspace' },
    });
  }
}

function recordIncludedEntry(budget: WorkspaceCopyBudget, limits: SessionBundleLimits): void {
  if (safeAdd(budget.includedEntries, 1) > limits.maxEntryCount) {
    throw new SessionSnapshotError('quota_exceeded', 'Workspace entry count exceeds Bundle quota', {
      details: { phase: 'workspace' },
    });
  }
  budget.includedEntries += 1;
}

function recordExclusion(
  budget: WorkspaceCopyBudget,
  category: SessionSnapshotWorkspaceExclusionCategory,
): void {
  budget.excludedEntries += 1;
  budget.exclusions[category] += 1;
}

function emptyExclusionCounts(): Record<SessionSnapshotWorkspaceExclusionCategory, number> {
  return {
    dependency_tree: 0,
    source_control: 0,
    cache: 0,
    log: 0,
    runtime_scratch: 0,
    confirmed_secret_path: 0,
  };
}

function registerWorkspacePath(budget: WorkspaceCopyBudget, path: string): void {
  const caseFolded = path.toLocaleLowerCase('en-US');
  const previous = budget.seenCaseFoldedPaths.get(caseFolded);
  if (previous !== undefined && previous !== path) {
    throw new SessionSnapshotError('unsafe_source', 'Workspace contains case-conflicting paths', {
      details: { phase: 'workspace', policyCategory: 'unsafe_path' },
    });
  }
  budget.seenCaseFoldedPaths.set(caseFolded, path);
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<{
  readonly path: string;
  readonly identity: FilesystemIdentity;
}> {
  let root;
  try {
    root = await lstatBigInt(workspaceRoot);
  } catch (error) {
    throw asSnapshotError('unsafe_source', 'Workspace root is unavailable', 'workspace', error);
  }
  if (!root.isDirectory() || root.isSymbolicLink()) {
    throw new SessionSnapshotError('unsafe_source', 'Workspace root is unsafe', {
      details: { phase: 'workspace', policyCategory: 'unsafe_path' },
    });
  }
  try {
    const canonical = await realpath(workspaceRoot);
    const configuredAfter = await lstatBigInt(workspaceRoot);
    const canonicalMetadata = await lstatBigInt(canonical);
    if (
      !configuredAfter.isDirectory() ||
      configuredAfter.isSymbolicLink() ||
      !canonicalMetadata.isDirectory() ||
      canonicalMetadata.isSymbolicLink() ||
      !sameFilesystemIdentity(root, configuredAfter) ||
      !sameFilesystemIdentity(root, canonicalMetadata)
    ) {
      throw new SessionSnapshotError('source_changed', 'Workspace root changed while resolving', {
        details: { phase: 'workspace' },
      });
    }
    return {
      path: canonical,
      identity: filesystemIdentity(root),
    };
  } catch (error) {
    if (error instanceof SessionSnapshotError) throw error;
    throw asSnapshotError('unsafe_source', 'Workspace root is unavailable', 'workspace', error);
  }
}

async function assertMissing(path: string, message: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw error;
  }
  throw new SessionSnapshotError('unsafe_source', message, {
    details: { phase: 'workspace', policyCategory: 'unsafe_path' },
  });
}

type FileFingerprint = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
};

type DirectoryFingerprint = Pick<FileFingerprint, 'dev' | 'ino' | 'mtimeNs' | 'ctimeNs'>;
type FilesystemIdentity = Pick<FileFingerprint, 'dev' | 'ino'>;

async function copyWorkspaceFile(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly expected: FileFingerprint;
  readonly expectedSize: number;
  readonly sourceMetadata: BigIntStats;
  readonly cancellation: SessionSnapshotCancellation;
}): Promise<void> {
  let source: Awaited<ReturnType<typeof open>> | undefined;
  let destination: Awaited<ReturnType<typeof open>> | undefined;
  try {
    source = await open(input.sourcePath, fsConstants.O_RDONLY | NO_FOLLOW_OPEN_FLAG);
    const openedSource = (await source.stat({ bigint: true })) as BigIntStats;
    if (
      !openedSource.isFile() ||
      openedSource.nlink !== 1n ||
      !sameFileFingerprint(input.expected, fileFingerprint(openedSource))
    ) {
      throw sourceChangedDuringWorkspaceCopy();
    }
    destination = await open(
      input.destinationPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW_OPEN_FLAG,
      destinationFileMode(input.sourceMetadata),
    );
    const buffer = Buffer.allocUnsafe(Math.min(WORKSPACE_COPY_CHUNK_BYTES, input.expectedSize));
    let copied = 0;
    while (copied < input.expectedSize) {
      assertSnapshotActive(input.cancellation, 'workspace');
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.byteLength, input.expectedSize - copied),
        copied,
      );
      if (bytesRead === 0) throw sourceChangedDuringWorkspaceCopy();
      let written = 0;
      while (written < bytesRead) {
        assertSnapshotActive(input.cancellation, 'workspace');
        const result = await destination.write(
          buffer,
          written,
          bytesRead - written,
          copied + written,
        );
        if (result.bytesWritten === 0) {
          throw new SessionSnapshotError('io_failure', 'Workspace snapshot copy made no progress', {
            details: { phase: 'workspace' },
          });
        }
        written += result.bytesWritten;
      }
      copied += bytesRead;
    }
    assertSnapshotActive(input.cancellation, 'workspace');
    const sourceAfter = (await source.stat({ bigint: true })) as BigIntStats;
    const destinationAfter = (await destination.stat({ bigint: true })) as BigIntStats;
    if (
      !sourceAfter.isFile() ||
      sourceAfter.nlink !== 1n ||
      !sameFileFingerprint(input.expected, fileFingerprint(sourceAfter)) ||
      !destinationAfter.isFile() ||
      destinationAfter.isSymbolicLink() ||
      destinationAfter.nlink !== 1n ||
      destinationAfter.size !== BigInt(input.expectedSize)
    ) {
      throw sourceChangedDuringWorkspaceCopy();
    }
  } finally {
    try {
      await destination?.close();
    } finally {
      await source?.close();
    }
  }
}

function destinationFileMode(metadata: BigIntStats): number {
  return (metadata.mode & 0o111n) === 0n ? 0o600 : 0o700;
}

function sourceChangedDuringWorkspaceCopy(): SessionSnapshotError {
  return new SessionSnapshotError('source_changed', 'Workspace changed while being copied', {
    details: { phase: 'workspace' },
  });
}

function fileFingerprint(metadata: BigIntStats): FileFingerprint {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function filesystemIdentity(metadata: Pick<BigIntStats, 'dev' | 'ino'>): FilesystemIdentity {
  return { dev: metadata.dev, ino: metadata.ino };
}

function sameFilesystemIdentity(
  left: Pick<BigIntStats, 'dev' | 'ino'>,
  right: Pick<BigIntStats, 'dev' | 'ino'>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readDirectoryFingerprint(path: string): Promise<DirectoryFingerprint> {
  const metadata = await lstatBigInt(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SessionSnapshotError(
      'source_changed',
      'Workspace directory changed while being copied',
      {
        details: { phase: 'workspace' },
      },
    );
  }
  return fileFingerprint(metadata);
}

function sameFileFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryFingerprint(
  left: DirectoryFingerprint,
  right: DirectoryFingerprint,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function lstatBigInt(path: string): Promise<BigIntStats> {
  return (await lstat(path, { bigint: true })) as BigIntStats;
}

function decodeFilesystemName(value: string | Buffer): string {
  if (typeof value === 'string') {
    if (value.length === 0 || value.includes('\0') || value.includes('/') || value.includes('\\')) {
      throw new SessionSnapshotError('unsafe_source', 'Workspace entry name is unsafe', {
        details: { phase: 'workspace', policyCategory: 'unsafe_path' },
      });
    }
    return value;
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
    return decodeFilesystemName(decoded);
  } catch (error) {
    if (error instanceof SessionSnapshotError) throw error;
    throw new SessionSnapshotError('unsafe_source', 'Workspace entry name is not valid UTF-8', {
      cause: error,
      details: { phase: 'workspace', policyCategory: 'unsafe_path' },
    });
  }
}

function safeSize(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SessionSnapshotError('quota_exceeded', 'Workspace file size is unsupported', {
      details: { phase: 'workspace' },
    });
  }
  return Number(value);
}

function safeAdd(left: number, right: number): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) {
    throw new SessionSnapshotError('quota_exceeded', 'Workspace quota accounting is invalid', {
      details: { phase: 'workspace' },
    });
  }
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new SessionSnapshotError('quota_exceeded', 'Workspace quota accounting overflowed', {
      details: { phase: 'workspace' },
    });
  }
  return result;
}

function assertSnapshotActive(
  cancellation: SessionSnapshotCancellation,
  phase: 'state' | 'workspace',
): void {
  if (!cancellation.signal.aborted) return;
  throw new SessionSnapshotError(
    'snapshot_cancelled',
    'Session snapshot preparation was cancelled',
    {
      details: { phase },
    },
  );
}

function requireAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new TypeError(`Session snapshot ${label} must be an absolute path`);
  }
  return resolve(value);
}

function requireProductionSessionSnapshotBinding(
  value: ProductionSessionSnapshotBinding,
): Readonly<ProductionSessionSnapshotBinding> {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Session snapshot production Session binding is required');
  }
  if (!isSafeSessionId(value.makaSessionId)) {
    throw new TypeError('Session snapshot production Maka Session identity is invalid');
  }
  if (typeof value.cloudSessionId !== 'string' || value.cloudSessionId.length === 0) {
    throw new TypeError('Session snapshot production Cloud Session identity is required');
  }
  return Object.freeze({
    makaSessionId: value.makaSessionId,
    cloudSessionId: value.cloudSessionId,
  });
}

async function assertProductionRootsSeparate(input: {
  readonly stateRoot: string;
  readonly configRoot: string;
  readonly workspaceRoot: string;
  readonly stagingParent: string;
  readonly cleanupStateRoot: string;
}): Promise<void> {
  const roots = await Promise.all(
    Object.entries(input).map(async ([label, path]) => ({
      label,
      path: await canonicalDirectoryRoot(path, label),
    })),
  );
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const left = roots[leftIndex]!;
      const right = roots[rightIndex]!;
      if (rootsOverlap(left.path, right.path)) {
        throw new SessionSnapshotError(
          'unsafe_source',
          'Session snapshot production roots overlap',
          { details: { phase: 'staging' } },
        );
      }
    }
  }
}

async function canonicalDirectoryRoot(path: string, label: string): Promise<string> {
  const absolute = requireAbsolutePath(path, label);
  try {
    const canonical = await realpath(absolute);
    const metadata = await lstatBigInt(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('root is not a directory');
    }
    return canonical;
  } catch (error) {
    throw new SessionSnapshotError('unsafe_source', 'Session snapshot root is unsafe', {
      cause: error,
      details: { phase: 'staging' },
    });
  }
}

function rootsOverlap(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return (
    leftToRight === '' ||
    rightToLeft === '' ||
    (!leftToRight.startsWith('..') && !isAbsolute(leftToRight)) ||
    (!rightToLeft.startsWith('..') && !isAbsolute(rightToLeft))
  );
}

function asSnapshotError(
  code: 'io_failure' | 'unsafe_source',
  message: string,
  phase: 'state' | 'workspace',
  cause: unknown,
): SessionSnapshotError {
  if (cause instanceof SessionSnapshotError) return cause;
  return new SessionSnapshotError(code, message, { cause, details: { phase } });
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
