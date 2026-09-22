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

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rmdir,
  unlink,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { tryLock, unlock, waitForLock } from 'fs-native-extensions';

import { withArtifactWriterBootstrapLock } from './artifact-writer-bootstrap-lock.js';
import { publishMarkerFile, readBoundedMarkerFile } from './marker-file.js';
import { syncDirectoryChain } from './stable-storage.js';

export const STORAGE_ROOT_MARKER_FILE = '.maka-storage-root.json';
export const ARTIFACT_WRITER_LOCK_FILE = '.maka-artifact-writer.lock';
export const STORAGE_ROOT_MARKER_SCHEMA_VERSION = 1 as const;
const MAX_STORAGE_ROOT_MARKER_BYTES = 1_024;
const ARTIFACT_WRITER_BOOTSTRAP_DIRECTORY = 'artifact-writer-bootstrap';
const ROOT_CONTROL_REAP_DIRECTORY = '.reap';
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/;
const ROOT_CONTROL_REAP_GRACE_MS = 24 * 60 * 60 * 1_000;
const ROOT_CONTROL_REAP_MAX_ENTRIES = 1_024;
const ROOT_CONTROL_REAP_MAX_DURATION_MS = 500;
const ROOT_CONTROL_REAP_CLAIM_RETRIES = 3;
const ROOT_CONTROL_CLAIM_LOCK = '.claim.lock';

export type StorageRootKind = 'interactive';
export type StorageRootAccess = 'read' | 'write';

const capabilityBrand: unique symbol = Symbol('StorageRootCapability');
const leaseBrand: unique symbol = Symbol('StorageRootLease');
const repairBrand: unique symbol = Symbol('StorageRootIdentityRepairCandidate');
const artifactWriterBootstrapAuthorityBrand: unique symbol = Symbol(
  'ArtifactWriterBootstrapAuthority',
);
const artifactWriterLockAuthorityBrand: unique symbol = Symbol('ArtifactWriterLockAuthority');

export interface StorageRootCapability<K extends StorageRootKind = StorageRootKind> {
  readonly kind: K;
  readonly canonicalPath: string;
  readonly rootId: string;
  readonly [capabilityBrand]: true;
}

export type DiscoveredStorageRootCapability = StorageRootCapability<'interactive'>;

export interface StorageRootLease<
  K extends StorageRootKind = StorageRootKind,
  A extends StorageRootAccess = StorageRootAccess,
> {
  readonly kind: K;
  readonly access: A;
  readonly canonicalPath: string;
  readonly rootId: string;
  readonly [leaseBrand]: true;
}

export interface ArtifactWriterLockAuthority {
  readonly bootstrapLockPath: string;
  readonly controlDirectory: string;
  readonly assertCurrentRoot: () => Promise<void>;
  readonly [artifactWriterLockAuthorityBrand]: true;
}

export interface ArtifactWriterBootstrapAuthority {
  readonly lockPath: string;
  readonly canonicalPath: string;
  readonly assertCurrentRoot: () => Promise<void>;
  readonly [artifactWriterBootstrapAuthorityBrand]: true;
}

export interface ResolveStorageRootInput<K extends StorageRootKind> {
  path: string;
  kind: K;
}

export interface DiscoverStorageRootInput {
  path: string;
}

export interface ResolveExistingStorageRootInput<K extends StorageRootKind>
  extends ResolveStorageRootInput<K> {
  expectedRootId: string;
}

export type AdoptStorageRootOnImportInput<K extends StorageRootKind> =
  ResolveExistingStorageRootInput<K>;

export interface RepairStorageRootAfterRemountInput<K extends StorageRootKind>
  extends ResolveStorageRootInput<K> {
  expectedRootId?: string;
}

export interface StorageRootIdentityRepairCandidate<K extends StorageRootKind = StorageRootKind> {
  readonly kind: K;
  readonly canonicalPath: string;
  readonly rootId: string;
  readonly [repairBrand]: true;
}

export interface StateRootOwner<K extends StorageRootKind = StorageRootKind> {
  readonly capability: StorageRootCapability<K>;
  readonly lease: StorageRootLease<K, 'write'>;
  readonly controlDirectory: string;
  readonly lockPath: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface StateRootReader<K extends StorageRootKind = StorageRootKind> {
  readonly capability: StorageRootCapability<K>;
  readonly lease: StorageRootLease<K, 'read'>;
  readonly controlDirectory: string;
  readonly lockPath: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

export type InteractiveRootOwner = StateRootOwner<'interactive'>;
export type InteractiveRootReader = StateRootReader<'interactive'>;

export interface ReapStaleRootControlDirectoriesOptions {
  /** Test-only namespace override; production uses the account control namespace. */
  controlRoot?: string;
  graceMs?: number;
  maxEntries?: number;
  maxDurationMs?: number;
}

export interface RootControlDirectoryReapSummary {
  scanned: number;
  eligible: number;
  reaped: number;
  busy: number;
  skipped: number;
  failed: number;
  budgetExhausted: boolean;
}

interface RootIdentity {
  dev: bigint;
  ino: bigint;
}

interface CapabilityRecord<K extends StorageRootKind = StorageRootKind> {
  kind: K;
  canonicalPath: string;
  rootId: string;
  identity: RootIdentity;
}

interface LeaseRecord<
  K extends StorageRootKind = StorageRootKind,
  A extends StorageRootAccess = StorageRootAccess,
> extends CapabilityRecord<K> {
  access: A;
  isActive: () => boolean;
  beginOperation: () => () => void;
}

interface RootMarker {
  schemaVersion: typeof STORAGE_ROOT_MARKER_SCHEMA_VERSION;
  kind: StorageRootKind;
  rootId: string;
  rootIdentity: {
    dev: string;
    ino: string;
  };
}

interface StorageRootIdentityRepairRecord<K extends StorageRootKind = StorageRootKind>
  extends CapabilityRecord<K> {
  marker: RootMarker;
}

const capabilities = new WeakMap<object, CapabilityRecord>();
const leases = new WeakMap<object, LeaseRecord>();
const stateRootLocks = new WeakMap<object, { kind: StorageRootKind; access: StorageRootAccess }>();
const storageRootIdentityRepairs = new WeakMap<object, StorageRootIdentityRepairRecord>();

export type StorageRootAuthorityErrorCode =
  | 'invalid_root'
  | 'invalid_root_kind'
  | 'root_not_found'
  | 'root_unmarked'
  | 'invalid_marker'
  | 'root_identity_collision'
  | 'root_identity_changed'
  | 'invalid_repair'
  | 'invalid_capability'
  | 'invalid_lease'
  | 'invalid_owner'
  | 'invalid_lock_artifact'
  | 'insecure_control_directory'
  | 'root_io_failed'
  | 'control_io_failed'
  | 'lock_failed';

export class StorageRootAuthorityError extends Error {
  constructor(
    readonly code: StorageRootAuthorityErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'StorageRootAuthorityError';
  }
}

function assertStorageRootKind(kind: unknown): asserts kind is StorageRootKind {
  if (kind !== 'interactive') {
    throw new StorageRootAuthorityError(
      'invalid_root_kind',
      `Unsupported storage root kind: ${String(kind)}`,
    );
  }
}

export async function resolveStorageRoot<K extends StorageRootKind>(
  input: ResolveStorageRootInput<K>,
): Promise<StorageRootCapability<K>> {
  assertStorageRootKind(input.kind);
  return withAuthorityFailure('root_io_failed', 'Unable to resolve the storage root', () =>
    resolveStorageRootUnchecked(input),
  );
}

export async function discoverMarkedStorageRoot(
  input: DiscoverStorageRootInput,
): Promise<DiscoveredStorageRootCapability> {
  return withAuthorityFailure('root_io_failed', 'Unable to discover the storage root', async () => {
    const { canonicalPath, rootStat } = await resolveExistingRootPath(input.path);

    const identity = { dev: rootStat.dev, ino: rootStat.ino };
    const marker = await confirmRootSnapshot({
      root: canonicalPath,
      identity,
      readMarker: () => readRootMarker(canonicalPath),
      markerMismatchCode: 'root_identity_collision',
      markerMismatchMessage: `Storage root marker belongs to a different directory: ${canonicalPath}`,
    });
    return createCapability('interactive', canonicalPath, marker.rootId, identity);
  });
}

async function resolveStorageRootUnchecked<K extends StorageRootKind>(
  input: ResolveStorageRootInput<K>,
): Promise<StorageRootCapability<K>> {
  const requestedPath = resolve(input.path);
  await ensureRootDirectory(requestedPath);
  const canonicalPath = canonicalizePath(await realpath(requestedPath));
  const rootStat = await stat(canonicalPath, { bigint: true });
  if (!rootStat.isDirectory()) {
    throw new StorageRootAuthorityError(
      'invalid_root',
      `Storage root is not a directory: ${canonicalPath}`,
    );
  }

  const identity = { dev: rootStat.dev, ino: rootStat.ino };
  const marker = await confirmRootSnapshot({
    root: canonicalPath,
    identity,
    readMarker: () => ensureRootMarker(canonicalPath, input.kind, identity),
    markerMismatchCode: 'root_identity_collision',
    markerMismatchMessage: `Storage root marker belongs to a different directory: ${canonicalPath}`,
  });
  return createCapability(input.kind, canonicalPath, marker.rootId, identity);
}

export async function resolveExistingStorageRoot<K extends StorageRootKind>(
  input: ResolveExistingStorageRootInput<K>,
): Promise<StorageRootCapability<K>> {
  assertStorageRootKind(input.kind);
  return withAuthorityFailure(
    'root_io_failed',
    'Unable to resolve the existing storage root',
    async () => {
      const { canonicalPath, rootStat } = await resolveExistingRootPath(input.path);
      const identity = { dev: rootStat.dev, ino: rootStat.ino };
      const marker = await confirmRootSnapshot({
        root: canonicalPath,
        identity,
        readMarker: () => readAndValidateRootMarker(canonicalPath, input.kind),
        expectedRootId: input.expectedRootId,
        markerMismatchCode: 'root_identity_changed',
        markerMismatchMessage: `Storage root identity does not match the expected root: ${canonicalPath}`,
      });
      return createCapability(input.kind, canonicalPath, marker.rootId, identity);
    },
  );
}

/**
 * Explicit import boundary for a storage root copied through an archive.
 * The durable rootId stays authoritative while the host-local dev/ino binding
 * is atomically adopted for the extracted directory.
 */
export async function adoptStorageRootOnImport<K extends StorageRootKind>(
  input: AdoptStorageRootOnImportInput<K>,
): Promise<StorageRootCapability<K>> {
  assertStorageRootKind(input.kind);
  return withAuthorityFailure(
    'root_io_failed',
    'Unable to adopt the imported storage root',
    async () => {
      const { canonicalPath, rootStat } = await resolveExistingRootPath(input.path);
      const identity = { dev: rootStat.dev, ino: rootStat.ino };
      let marker = await readAndValidateRootMarker(canonicalPath, input.kind);
      if (marker.rootId !== input.expectedRootId) {
        throw new StorageRootAuthorityError(
          'root_identity_collision',
          `Imported storage root does not match the expected root: ${canonicalPath}`,
        );
      }
      await assertRootPathIdentity(
        canonicalPath,
        identity,
        `Storage root identity changed while adopting an import: ${canonicalPath}`,
      );
      if (!markerMatchesIdentity(marker, identity)) {
        marker = await replaceRootMarkerIdentity(canonicalPath, identity, marker);
      }
      await confirmRootSnapshot({
        root: canonicalPath,
        identity,
        readMarker: () => readAndValidateRootMarker(canonicalPath, input.kind),
        expectedRootId: input.expectedRootId,
        markerMismatchCode: 'root_identity_changed',
        markerMismatchMessage: `Imported storage root identity changed: ${canonicalPath}`,
      });
      return createCapability(input.kind, canonicalPath, marker.rootId, identity);
    },
  );
}

export async function prepareStorageRootIdentityRepair<K extends StorageRootKind>(
  input: ResolveStorageRootInput<K>,
): Promise<StorageRootIdentityRepairCandidate<K> | undefined> {
  assertStorageRootKind(input.kind);
  return withAuthorityFailure(
    'root_io_failed',
    'Unable to prepare the storage root identity repair',
    async () => {
      const { canonicalPath, rootStat } = await resolveExistingRootPath(input.path);
      const identity = { dev: rootStat.dev, ino: rootStat.ino };
      const identityChangedMessage = `Storage root identity changed while preparing its repair: ${canonicalPath}`;
      await assertRootPathIdentity(canonicalPath, identity, identityChangedMessage);
      let marker: RootMarker;
      try {
        marker = await readAndValidateRootMarker(canonicalPath, input.kind);
      } catch (error) {
        await assertRootPathIdentity(canonicalPath, identity, identityChangedMessage);
        throw error;
      }
      await assertRootPathIdentity(canonicalPath, identity, identityChangedMessage);
      if (markerMatchesIdentity(marker, identity)) return undefined;

      const record: StorageRootIdentityRepairRecord<K> = {
        kind: input.kind,
        canonicalPath,
        rootId: marker.rootId,
        identity,
        marker,
      };
      const candidate = Object.freeze({
        kind: record.kind,
        canonicalPath: record.canonicalPath,
        rootId: record.rootId,
      }) as StorageRootIdentityRepairCandidate<K>;
      storageRootIdentityRepairs.set(candidate, record);
      return candidate;
    },
  );
}

/**
 * Repairs only the mount-local portion of a root identity. This is for callers
 * that already know their execution environment remounted the same filesystem:
 * the inode must stay unchanged, and an expected durable root id may still pin
 * the repair to an existing Client binding.
 */
export async function repairStorageRootAfterRemount<K extends StorageRootKind>(
  input: RepairStorageRootAfterRemountInput<K>,
): Promise<StorageRootCapability<K> | undefined> {
  let candidate: StorageRootIdentityRepairCandidate<K> | undefined;
  try {
    candidate = await prepareStorageRootIdentityRepair(input);
  } catch (error) {
    if (
      error instanceof StorageRootAuthorityError &&
      (error.code === 'root_not_found' || error.code === 'root_unmarked')
    ) {
      return undefined;
    }
    throw error;
  }
  if (!candidate) return undefined;
  const record = storageRootIdentityRepairs.get(candidate) as
    | StorageRootIdentityRepairRecord<K>
    | undefined;
  if (!record) {
    throw new StorageRootAuthorityError(
      'invalid_repair',
      'Expected a prepared storage root identity repair',
    );
  }
  if (input.expectedRootId !== undefined && record.rootId !== input.expectedRootId) {
    storageRootIdentityRepairs.delete(candidate);
    throw new StorageRootAuthorityError(
      'root_identity_changed',
      `Remounted storage root does not match the expected root: ${record.canonicalPath}`,
    );
  }
  if (record.marker.rootIdentity.ino !== record.identity.ino.toString()) {
    storageRootIdentityRepairs.delete(candidate);
    throw new StorageRootAuthorityError(
      'root_identity_changed',
      `Storage root directory changed across remount: ${record.canonicalPath}`,
    );
  }
  return repairStorageRootIdentity(candidate);
}

/**
 * Explicit recovery boundary for a root whose host-local filesystem identity
 * is stale. Callers must obtain user intent for this exact candidate first.
 */
export async function repairStorageRootIdentity<K extends StorageRootKind>(
  candidate: StorageRootIdentityRepairCandidate<K>,
): Promise<StorageRootCapability<K>> {
  const record = storageRootIdentityRepairs.get(candidate) as
    | StorageRootIdentityRepairRecord<K>
    | undefined;
  if (!record) {
    throw new StorageRootAuthorityError(
      'invalid_repair',
      'Expected a prepared storage root identity repair',
    );
  }
  storageRootIdentityRepairs.delete(candidate);

  return withAuthorityFailure(
    'root_io_failed',
    'Unable to repair the storage root identity',
    async () => {
      const identityChangedMessage = `Storage root identity changed while repairing its marker: ${record.canonicalPath}`;
      await assertRootPathIdentity(record.canonicalPath, record.identity, identityChangedMessage);
      const marker = await readAndValidateRootMarker(record.canonicalPath, record.kind);
      await assertRootPathIdentity(record.canonicalPath, record.identity, identityChangedMessage);
      if (!rootMarkersEqual(marker, record.marker)) {
        throw new StorageRootAuthorityError(
          'root_identity_changed',
          `Storage root marker changed while awaiting repair: ${record.canonicalPath}`,
        );
      }
      const repaired = await replaceRootMarkerIdentity(
        record.canonicalPath,
        record.identity,
        record.marker,
      );
      await confirmRootSnapshot({
        root: record.canonicalPath,
        identity: record.identity,
        readMarker: () => readAndValidateRootMarker(record.canonicalPath, record.kind),
        expectedRootId: record.rootId,
        markerMismatchCode: 'root_identity_changed',
        markerMismatchMessage: `Repaired storage root identity changed: ${record.canonicalPath}`,
      });
      return createCapability(record.kind, record.canonicalPath, repaired.rootId, record.identity);
    },
  );
}

async function resolveExistingRootPath(path: string): Promise<{
  canonicalPath: string;
  rootStat: BigIntStats;
}> {
  let canonicalPath: string;
  try {
    canonicalPath = canonicalizePath(await realpath(resolve(path)));
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new StorageRootAuthorityError(
        'root_not_found',
        `Storage root does not exist: ${resolve(path)}`,
      );
    }
    throw error;
  }
  let rootStat: BigIntStats;
  try {
    rootStat = await stat(canonicalPath, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new StorageRootAuthorityError(
        'root_not_found',
        `Storage root does not exist: ${resolve(path)}`,
      );
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new StorageRootAuthorityError(
      'invalid_root',
      `Storage root is not a directory: ${canonicalPath}`,
    );
  }
  return { canonicalPath, rootStat };
}

function createCapability<K extends StorageRootKind>(
  kind: K,
  canonicalPath: string,
  rootId: string,
  identity: RootIdentity,
): StorageRootCapability<K> {
  const record: CapabilityRecord<K> = {
    kind,
    canonicalPath,
    rootId,
    identity,
  };
  const capability = Object.freeze({
    kind: record.kind,
    canonicalPath: record.canonicalPath,
    rootId: record.rootId,
  }) as StorageRootCapability<K>;
  capabilities.set(capability, record);
  return capability;
}

async function ensureRootDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
  } catch (error) {
    const existing = await statRootIfPresent(path);
    if (existing && !existing.isDirectory()) {
      throw new StorageRootAuthorityError(
        'invalid_root',
        `Storage root is not a directory: ${path}`,
      );
    }
    throw error;
  }
}

export function resolveRootControlNamespace(): string {
  try {
    const accountHome = userInfo().homedir;
    if (!isAbsolute(accountHome)) {
      throw new Error('OS account home must be an absolute path');
    }
    if (process.platform === 'darwin') {
      return join(accountHome, 'Library', 'Caches', 'Maka', 'runtime-hosts');
    }
    if (process.platform === 'win32') {
      return join(accountHome, 'AppData', 'Local', 'Maka', 'runtime-hosts');
    }
    return join(accountHome, '.cache', 'maka', 'runtime-hosts');
  } catch (error) {
    throw normalizeAuthorityFailure(
      error,
      'control_io_failed',
      'Unable to resolve the Runtime Host control namespace',
    );
  }
}

/** Recreates the private diagnostic parent after a failed Candidate releases its owner. */
export async function prepareRootControlDirectoryForDiagnostic(rootId: string): Promise<string> {
  if (!ROOT_ID_PATTERN.test(rootId)) {
    throw new StorageRootAuthorityError('invalid_root', 'Invalid Runtime Host root identity');
  }
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to prepare the Runtime Host diagnostic directory',
    async () => {
      const controlRoot = await preparePrivateControlRoot();
      const controlDirectory = join(controlRoot, rootId);
      await ensurePrivateDirectory(controlDirectory);
      return controlDirectory;
    },
  );
}

/**
 * Resolves the durable namespace that owns State Root process election.
 *
 * Endpoint registrations and diagnostics remain in the disposable control
 * namespace. The owner lock must not: deleting a cache directory while a Host
 * is running must never make the same State Root acquirable again.
 */
export function resolveRootOwnershipNamespace(): string {
  try {
    const accountHome = userInfo().homedir;
    if (!isAbsolute(accountHome)) {
      throw new Error('OS account home must be an absolute path');
    }
    if (process.platform === 'darwin') {
      return join(accountHome, 'Library', 'Application Support', 'Maka', 'state-root-owners');
    }
    if (process.platform === 'win32') {
      return join(accountHome, 'AppData', 'Local', 'Maka', 'state-root-owners');
    }
    return join(accountHome, '.local', 'share', 'Maka', 'state-root-owners');
  } catch (error) {
    throw normalizeAuthorityFailure(
      error,
      'control_io_failed',
      'Unable to resolve the State Root ownership namespace',
    );
  }
}

/**
 * Runs one bounded batch. Callers needing a complete sweep should consume
 * reapRootControlDirectoryBatches(), which retains its streaming cursor.
 */
export async function reapStaleRootControlDirectories(
  options: ReapStaleRootControlDirectoriesOptions = {},
): Promise<RootControlDirectoryReapSummary> {
  for await (const summary of reapRootControlDirectoryBatches(options)) return summary;
  return emptyReapSummary();
}

/** A finite sweep, retaining directory handles across cooperative batch boundaries. */
export async function* reapRootControlDirectoryBatches(
  options: ReapStaleRootControlDirectoriesOptions = {},
): AsyncGenerator<RootControlDirectoryReapSummary> {
  const graceMs = requireNonNegativeFiniteOption(
    options.graceMs ?? ROOT_CONTROL_REAP_GRACE_MS,
    'graceMs',
  );
  const maxEntries = requireNonNegativeIntegerOption(
    options.maxEntries ?? ROOT_CONTROL_REAP_MAX_ENTRIES,
    'maxEntries',
  );
  const maxDurationMs = requireNonNegativeFiniteOption(
    options.maxDurationMs ?? ROOT_CONTROL_REAP_MAX_DURATION_MS,
    'maxDurationMs',
  );
  let summary = emptyReapSummary();
  if (maxEntries === 0 || maxDurationMs === 0) {
    yield { ...summary, budgetExhausted: true };
    return;
  }
  let workItems = 0;
  let startedAt = performance.now();
  const controlRoot = resolve(options.controlRoot ?? resolveRootControlNamespace());
  for await (const event of rootControlReapEvents(controlRoot, graceMs)) {
    summary.scanned += event.scanned ?? 0;
    summary.eligible += event.eligible ?? 0;
    summary.reaped += event.reaped ?? 0;
    summary.busy += event.busy ?? 0;
    summary.skipped += event.skipped ?? 0;
    summary.failed += event.failed ?? 0;
    workItems += 1;
    if (workItems >= maxEntries || performance.now() - startedAt >= maxDurationMs) {
      yield { ...summary, budgetExhausted: true };
      summary = emptyReapSummary();
      workItems = 0;
      startedAt = performance.now();
    }
  }
  yield summary;
}

function emptyReapSummary(): RootControlDirectoryReapSummary {
  return {
    scanned: 0,
    eligible: 0,
    reaped: 0,
    busy: 0,
    skipped: 0,
    failed: 0,
    budgetExhausted: false,
  };
}

type ReapEvent = Partial<Omit<RootControlDirectoryReapSummary, 'budgetExhausted'>>;

async function* rootControlReapEvents(
  controlRoot: string,
  graceMs: number,
): AsyncGenerator<ReapEvent> {
  if (!(await lstatPathIfPresent(controlRoot))) return;
  await assertPrivateDirectory(controlRoot);
  const namespaceIdentity = await lstat(controlRoot, { bigint: true });
  // Claims are scanned first; both streams continue across batches, so neither
  // repeatedly scans an uncollectable prefix on every budget boundary.
  const reapRoot = join(controlRoot, ROOT_CONTROL_REAP_DIRECTORY);
  if (await lstatPathIfPresent(reapRoot)) {
    await assertPrivateDirectory(reapRoot);
    const reapIdentity = await lstat(reapRoot, { bigint: true });
    const claims = await opendir(reapRoot);
    try {
      for await (const entry of claims) {
        yield { scanned: 1 };
        await assertDirectoryIdentity(controlRoot, namespaceIdentity);
        await assertDirectoryIdentity(reapRoot, reapIdentity);
        if (!isReapClaimName(entry.name) || !entry.isDirectory()) {
          yield { skipped: 1 };
          continue;
        }
        const claimDirectory = join(reapRoot, entry.name);
        try {
          const metadata = await lstatPathIfPresent(claimDirectory);
          if (!metadata?.isDirectory() || Date.now() - Number(metadata.mtimeMs) < graceMs) {
            yield { skipped: 1 };
            continue;
          }
          yield { eligible: 1 };
          yield* removeRootControlClaim(controlRoot, claimDirectory);
        } catch (error) {
          yield reapFailureEvent(error);
        }
      }
    } finally {
      await claims.close().catch(() => undefined);
    }
  }

  const roots = await opendir(controlRoot);
  try {
    for await (const entry of roots) {
      yield { scanned: 1 };
      if (!ROOT_ID_PATTERN.test(entry.name) || !entry.isDirectory()) {
        yield { skipped: 1 };
        continue;
      }
      let result: QuarantineRootControlDirectoryResult | undefined;
      try {
        await assertDirectoryIdentity(controlRoot, namespaceIdentity);
        const metadata = await lstatPathIfPresent(join(controlRoot, entry.name));
        if (!metadata?.isDirectory() || Date.now() - Number(metadata.mtimeMs) < graceMs) {
          yield { skipped: 1 };
          continue;
        }
        yield { eligible: 1 };
        result = await quarantineRootControlDirectory({
          controlRoot,
          rootId: entry.name,
          expectedDirectoryIdentity: metadata,
          minimumDirectoryAgeMs: graceMs,
        });
        if (result.kind === 'quarantined') {
          yield* removeRootControlClaim(controlRoot, result.claimDirectory, result.claimHandle);
        } else {
          yield { [result.kind]: 1 };
        }
      } catch (error) {
        yield reapFailureEvent(error);
      } finally {
        if (result?.kind === 'quarantined') await closeReapLock(result.claimHandle);
      }
    }
  } finally {
    await roots.close().catch(() => undefined);
  }
}

function reapFailureEvent(error: unknown): ReapEvent {
  return isMissingPathError(error) ||
    (error instanceof StorageRootAuthorityError && error.code === 'invalid_lock_artifact')
    ? { skipped: 1 }
    : { failed: 1 };
}

export async function tryAcquireInteractiveRootOwner(
  capability: StorageRootCapability<'interactive'>,
): Promise<InteractiveRootOwner | undefined> {
  return tryAcquireStateRootOwner(capability);
}

export async function tryAcquireStateRootOwner<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
): Promise<StateRootOwner<K> | undefined> {
  return withAuthorityFailure('lock_failed', 'Unable to acquire the storage root owner lock', () =>
    acquireStateRootLock(capability, 'write'),
  );
}

export async function prepareStorageRootControlDirectory(
  capability: StorageRootCapability,
): Promise<{ controlRoot: string; controlDirectory: string }> {
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to prepare the Runtime Host control directory',
    async () => {
      const record = requireCapability(capability, capability.kind);
      return prepareStorageRootControlDirectoryForRecord(record);
    },
  );
}

export async function resolveExistingStorageRootControlDirectory(
  capability: StorageRootCapability,
): Promise<{ controlRoot: string; controlDirectory: string }> {
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to validate the existing Runtime Host control directory',
    async () => {
      const record = requireCapability(capability, capability.kind);
      await assertRootIdentity(record);
      const controlRoot = resolve(resolveRootControlNamespace());
      const controlDirectory = join(controlRoot, record.rootId);
      await assertPrivateDirectory(controlRoot);
      await assertPrivateDirectory(controlDirectory);
      await assertRootIdentity(record);
      return { controlRoot, controlDirectory };
    },
  );
}

export async function prepareArtifactWriterBootstrapAuthority(
  path: string,
): Promise<ArtifactWriterBootstrapAuthority> {
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to prepare the Artifact writer bootstrap authority',
    async () => {
      const { canonicalPath, rootStat } = await resolveExistingRootPath(path);
      const identity = { dev: rootStat.dev, ino: rootStat.ino };
      const identityChangedMessage = `Storage root identity changed while preparing its Artifact writer bootstrap lock: ${canonicalPath}`;
      await assertRootPathIdentity(canonicalPath, identity, identityChangedMessage);
      const controlRoot = await preparePrivateControlRoot();
      const lockPath = await prepareArtifactWriterBootstrapLockPathForIdentity(
        controlRoot,
        identity,
      );
      await assertRootPathIdentity(canonicalPath, identity, identityChangedMessage);
      return Object.freeze({
        lockPath,
        canonicalPath,
        assertCurrentRoot: () =>
          assertRootPathIdentity(canonicalPath, identity, identityChangedMessage),
        [artifactWriterBootstrapAuthorityBrand]: true as const,
      });
    },
  );
}

export async function prepareArtifactWriterLockAuthorityForLease<K extends StorageRootKind>(
  lease: StorageRootLease<K, 'write'>,
  expectedKind: K,
): Promise<ArtifactWriterLockAuthority> {
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to prepare the Artifact writer lock control path',
    async () => {
      const record = requireLease(lease, expectedKind, 'write');
      const authority = await prepareArtifactWriterLockAuthorityForRecord(record);
      requireLease(lease, expectedKind, 'write');
      return authority;
    },
  );
}

export async function prepareArtifactWriterLockAuthorityForMarkedRoot(
  path: string,
): Promise<ArtifactWriterLockAuthority | undefined> {
  let capability: DiscoveredStorageRootCapability;
  try {
    capability = await discoverMarkedStorageRoot({ path });
  } catch (error) {
    if (error instanceof StorageRootAuthorityError && error.code === 'root_unmarked') {
      return undefined;
    }
    throw error;
  }
  const record = requireCapability(capability, capability.kind);
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to prepare the Artifact writer lock control path',
    () => prepareArtifactWriterLockAuthorityForRecord(record),
  );
}

export async function tryAcquireInteractiveRootReader(
  capability: StorageRootCapability<'interactive'>,
): Promise<InteractiveRootReader | undefined> {
  return withAuthorityFailure(
    'lock_failed',
    'Unable to acquire the interactive storage root reader lock',
    () => acquireStateRootLock(capability, 'read'),
  );
}

/** Synchronous capability/liveness check only; I/O still requires the full lease guard. */
export function assertStorageRootLeaseActive<
  K extends StorageRootKind,
  A extends StorageRootAccess,
>(lease: StorageRootLease<K, A>, expectedKind: K, expectedAccess: A): void {
  requireLease(lease, expectedKind, expectedAccess);
}

export async function assertStorageRootLease<
  K extends StorageRootKind,
  A extends StorageRootAccess,
>(lease: StorageRootLease<K, A>, expectedKind: K, expectedAccess: A): Promise<void> {
  const record = requireLease(lease, expectedKind, expectedAccess);
  await assertRootIdentity(record);
  requireLease(lease, expectedKind, expectedAccess);
}

export function createStorageRootLeaseIdentityGuard<
  K extends StorageRootKind,
  A extends StorageRootAccess,
>(lease: StorageRootLease<K, A>, expectedKind: K, expectedAccess: A): () => Promise<void> {
  const record = requireLease(lease, expectedKind, expectedAccess);
  return () => assertRootIdentity(record);
}

export async function runWithStorageRootLease<
  K extends StorageRootKind,
  A extends StorageRootAccess,
  T,
>(
  lease: StorageRootLease<K, A>,
  expectedKind: K,
  expectedAccess: A,
  operation: (canonicalPath: string) => Promise<T>,
): Promise<T> {
  const record = requireLease(lease, expectedKind, expectedAccess);
  const finishOperation = record.beginOperation();
  try {
    await assertRootIdentity(record);
    return await operation(record.canonicalPath);
  } finally {
    finishOperation();
  }
}

export async function assertStorageRootCapability<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
  expectedKind: K,
): Promise<void> {
  const record = requireCapability(capability, expectedKind);
  await assertRootIdentity(record);
}

export async function assertInteractiveRootOwner(owner: InteractiveRootOwner): Promise<void> {
  return assertStateRootOwner(owner, 'interactive');
}

export async function assertStateRootOwner<K extends StorageRootKind>(
  owner: StateRootOwner<K>,
  expectedKind: K,
): Promise<void> {
  const authenticOwner = authenticateStateRootOwner(owner, expectedKind);
  const capabilityRecord = requireCapability(authenticOwner.capability, expectedKind);
  requireLease(authenticOwner.lease, expectedKind, 'write');
  await assertRootIdentity(capabilityRecord);
  requireLease(authenticOwner.lease, expectedKind, 'write');
}

export function authenticateInteractiveRootOwner(
  owner: InteractiveRootOwner,
): InteractiveRootOwner {
  return authenticateStateRootOwner(owner, 'interactive');
}

export function authenticateStateRootOwner<K extends StorageRootKind>(
  owner: StateRootOwner<K>,
  expectedKind: K,
): StateRootOwner<K> {
  const record = stateRootLocks.get(owner);
  if (record?.kind !== expectedKind || record.access !== 'write') {
    throw new StorageRootAuthorityError(
      'invalid_owner',
      `Expected an authentic ${expectedKind} storage root owner`,
    );
  }
  return owner;
}

function acquireStateRootLock<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
  access: 'write',
): Promise<StateRootOwner<K> | undefined>;
function acquireStateRootLock<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
  access: 'read',
): Promise<StateRootReader<K> | undefined>;
async function acquireStateRootLock<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
  access: StorageRootAccess,
): Promise<StateRootOwner<K> | StateRootReader<K> | undefined> {
  const capabilityRecord = requireCapability(capability, capability.kind);
  const ownershipRoot = resolve(resolveRootOwnershipNamespace());
  await ensureDurablePrivateDirectory(ownershipRoot);
  const lockPath = join(ownershipRoot, `${capabilityRecord.rootId}.lock`);
  const durableHandle = await tryAcquireStableRootLock(lockPath, access);
  if (!durableHandle) return undefined;

  let compatibilityHandle: FileHandle | undefined;
  let controlDirectory: string;
  try {
    for (let attempt = 0; ; attempt += 1) {
      ({ controlDirectory } = await prepareStorageRootControlDirectory(capability));
      try {
        compatibilityHandle = await tryAcquireStableRootLock(
          join(controlDirectory, 'owner.lock'),
          access,
        );
        break;
      } catch (error) {
        // A stale-directory reaper can rename the compatibility lock after it
        // is opened but before its identity is checked. The durable lock held
        // above makes one retry safe and prevents two owners from emerging.
        if (
          attempt !== 0 ||
          !(error instanceof StorageRootAuthorityError) ||
          error.code !== 'invalid_lock_artifact'
        ) {
          throw error;
        }
      }
    }
    if (!compatibilityHandle) {
      releaseLock(durableHandle);
      await durableHandle.close();
      return undefined;
    }
    await assertRootIdentity(capabilityRecord);
  } catch (error) {
    if (compatibilityHandle) {
      releaseLock(compatibilityHandle);
      await compatibilityHandle.close().catch(() => undefined);
    }
    releaseLock(durableHandle);
    await durableHandle.close().catch(() => undefined);
    throw error;
  }

  let active = true;
  let activeOperations = 0;
  const operationDrainWaiters = new Set<() => void>();
  let closePromise: Promise<void> | undefined;
  const beginOperation = () => {
    if (!active) throw invalidLease(capabilityRecord.kind, access);
    activeOperations += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeOperations -= 1;
      if (activeOperations !== 0) return;
      for (const resolve of operationDrainWaiters) resolve();
      operationDrainWaiters.clear();
    };
  };
  const waitForOperations = () =>
    activeOperations === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => operationDrainWaiters.add(resolve));
  const close = () => {
    if (closePromise) return closePromise;
    active = false;
    closePromise = withAuthorityFailure(
      'lock_failed',
      'Unable to close the storage root lock',
      async () => {
        await waitForOperations();
        const errors: unknown[] = [];
        let quarantined:
          | Extract<QuarantineRootControlDirectoryResult, { kind: 'quarantined' }>
          | undefined;
        if (access === 'write') {
          try {
            const result = await quarantineRootControlDirectory({
              controlRoot: resolve(resolveRootControlNamespace()),
              rootId: capabilityRecord.rootId,
              heldOwnerHandle: compatibilityHandle,
            });
            if (result.kind === 'quarantined') quarantined = result;
          } catch {
            // A disposable-cache cleanup failure must not fail Runtime Host shutdown.
          }
        }
        releaseLock(compatibilityHandle);
        await compatibilityHandle.close().catch((error: unknown) => errors.push(error));
        releaseLock(durableHandle);
        await durableHandle.close().catch((error: unknown) => errors.push(error));
        if (quarantined) {
          try {
            // Removal is bounded on shutdown as well. A partial claim is safe to
            // resume at a later Host startup.
            const deadline = performance.now() + ROOT_CONTROL_REAP_MAX_DURATION_MS;
            let workItems = 0;
            for await (const _event of removeRootControlClaim(
              resolve(resolveRootControlNamespace()),
              quarantined.claimDirectory,
              quarantined.claimHandle,
            )) {
              if (++workItems >= ROOT_CONTROL_REAP_MAX_ENTRIES || performance.now() >= deadline)
                break;
            }
          } catch {
            // Retain the claim for a later sweep.
          } finally {
            await closeReapLock(quarantined.claimHandle);
          }
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'Unable to close every State Root owner lock');
        }
      },
    );
    return closePromise;
  };
  return createStateRootLock(
    capability,
    capabilityRecord,
    access,
    controlDirectory,
    lockPath,
    () => active,
    beginOperation,
    close,
  );
}

async function tryAcquireStableRootLock(
  lockPath: string,
  access: StorageRootAccess,
): Promise<FileHandle | undefined> {
  const existingLock = await lstatPathIfPresent(lockPath);
  if (existingLock && !existingLock.isFile()) throw invalidLockArtifact(lockPath);
  const handle = await open(lockPath, 'a+', 0o600);
  try {
    await assertStableLockArtifact(handle, lockPath);
    await handle.chmod(0o600);
    if (!tryLock(handle.fd, { shared: access === 'read' })) {
      await handle.close();
      return undefined;
    }
    await assertStableLockArtifact(handle, lockPath);
    return handle;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

type QuarantineRootControlDirectoryResult =
  | { kind: 'quarantined'; claimDirectory: string; claimHandle: FileHandle }
  | { kind: 'busy' }
  | { kind: 'skipped' };

interface QuarantineRootControlDirectoryInput {
  controlRoot: string;
  rootId: string;
  expectedDirectoryIdentity?: BigIntStats;
  minimumDirectoryAgeMs?: number;
  heldOwnerHandle?: FileHandle;
}

async function quarantineRootControlDirectory(
  input: QuarantineRootControlDirectoryInput,
): Promise<QuarantineRootControlDirectoryResult> {
  if (!ROOT_ID_PATTERN.test(input.rootId)) return { kind: 'skipped' };
  const controlRoot = resolve(input.controlRoot);
  const controlDirectory = join(controlRoot, input.rootId);
  if (parse(controlDirectory).dir !== controlRoot) return { kind: 'skipped' };

  const initialDirectoryStat =
    input.expectedDirectoryIdentity ?? (await lstatPathIfPresent(controlDirectory));
  if (!initialDirectoryStat?.isDirectory() || initialDirectoryStat.isSymbolicLink()) {
    return { kind: 'skipped' };
  }

  let ownerHandle = input.heldOwnerHandle;
  const ownsOwnerHandle = ownerHandle === undefined;
  let writerHandle: FileHandle | undefined;
  try {
    if (ownerHandle) {
      await assertStableLockArtifact(ownerHandle, join(controlDirectory, 'owner.lock'));
    } else {
      ownerHandle = await tryAcquireStableRootLock(join(controlDirectory, 'owner.lock'), 'write');
      if (!ownerHandle) return { kind: 'busy' };
    }

    writerHandle = await tryAcquireStableRootLock(
      join(controlDirectory, ARTIFACT_WRITER_LOCK_FILE),
      'write',
    );
    if (!writerHandle) return { kind: 'busy' };

    const currentDirectoryStat = await lstatPathIfPresent(controlDirectory);
    if (!sameFilesystemIdentity(initialDirectoryStat, currentDirectoryStat)) {
      return { kind: 'skipped' };
    }
    if (!(await containsOnlyDisposableRootControlEntries(controlDirectory))) {
      return { kind: 'skipped' };
    }
    const directoryStatBeforeClaim = await lstatPathIfPresent(controlDirectory);
    if (
      directoryStatBeforeClaim === undefined ||
      !sameFilesystemIdentity(initialDirectoryStat, directoryStatBeforeClaim)
    ) {
      return { kind: 'skipped' };
    }
    await Promise.all([
      assertStableLockArtifact(ownerHandle, join(controlDirectory, 'owner.lock')),
      assertStableLockArtifact(writerHandle, join(controlDirectory, ARTIFACT_WRITER_LOCK_FILE)),
    ]);

    const claimDirectory = await createRootControlReapClaim(controlRoot);
    const claimHandle = await tryAcquireStableRootLock(
      join(claimDirectory, ROOT_CONTROL_CLAIM_LOCK),
      'write',
    );
    if (!claimHandle) return { kind: 'busy' };
    try {
      await assertDirectoryIdentity(controlDirectory, initialDirectoryStat);
      await assertStableLockArtifact(ownerHandle, join(controlDirectory, 'owner.lock'));
      await assertStableLockArtifact(
        writerHandle,
        join(controlDirectory, ARTIFACT_WRITER_LOCK_FILE),
      );
      if (!(await containsOnlyDisposableRootControlEntries(controlDirectory))) {
        await closeReapLock(claimHandle);
        await unlink(join(claimDirectory, ROOT_CONTROL_CLAIM_LOCK));
        await rmdir(claimDirectory);
        return { kind: 'skipped' };
      }
      const preRenameDirectoryStat = await lstatPathIfPresent(controlDirectory);
      if (
        input.minimumDirectoryAgeMs !== undefined &&
        (preRenameDirectoryStat === undefined ||
          !sameFilesystemIdentity(initialDirectoryStat, preRenameDirectoryStat) ||
          (preRenameDirectoryStat.mtimeNs !== directoryStatBeforeClaim.mtimeNs &&
            Date.now() - Number(preRenameDirectoryStat.mtimeMs) < input.minimumDirectoryAgeMs))
      ) {
        await closeReapLock(claimHandle);
        await unlink(join(claimDirectory, ROOT_CONTROL_CLAIM_LOCK));
        await rmdir(claimDirectory);
        return { kind: 'skipped' };
      }
      await rename(controlDirectory, join(claimDirectory, input.rootId));
    } catch (error) {
      await closeReapLock(claimHandle);
      if (isMissingPathError(error) || isNodeError(error, 'EBUSY') || isNodeError(error, 'EPERM')) {
        return isMissingPathError(error) ? { kind: 'skipped' } : { kind: 'busy' };
      }
      throw error;
    }
    return { kind: 'quarantined', claimDirectory, claimHandle };
  } finally {
    if (writerHandle) {
      releaseLock(writerHandle);
      await writerHandle.close().catch(() => undefined);
    }
    if (ownsOwnerHandle && ownerHandle) {
      releaseLock(ownerHandle);
      await ownerHandle.close().catch(() => undefined);
    }
  }
}

/** Unknown entries are retained: the control directory also hosts durable Runtime Host data. */
async function containsOnlyDisposableRootControlEntries(
  controlDirectory: string,
): Promise<boolean> {
  const directory = await opendir(controlDirectory);
  try {
    for await (const entry of directory) {
      if (!isDisposableRootControlEntry(entry.name)) return false;
    }
    return true;
  } finally {
    await directory.close().catch(() => undefined);
  }
}

function isDisposableRootControlEntry(name: string): boolean {
  return (
    name === 'owner.lock' ||
    name === ARTIFACT_WRITER_LOCK_FILE ||
    name === 'registration.json' ||
    name === 'bundle-imports-v1' ||
    /^registration\.json\.\d+\.[0-9a-f-]{36}\.tmp$/u.test(name) ||
    /^startup-diagnostic(?:\.[0-9a-f-]{36})?\.json(?:\.\d+\.[0-9a-f-]{36}\.tmp)?$/u.test(name) ||
    /^runtime-host-access-delivery-[0-9a-f-]{36}\.json$/u.test(name)
  );
}

async function createRootControlReapClaim(controlRoot: string): Promise<string> {
  const reapRoot = join(controlRoot, ROOT_CONTROL_REAP_DIRECTORY);
  try {
    await mkdir(reapRoot, { mode: 0o700 });
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error;
  }
  await assertPrivateDirectory(reapRoot);

  for (let attempt = 0; attempt < ROOT_CONTROL_REAP_CLAIM_RETRIES; attempt += 1) {
    const claimDirectory = join(reapRoot, randomUUID());
    try {
      await mkdir(claimDirectory, { mode: 0o700 });
      return claimDirectory;
    } catch (error) {
      if (!isNodeError(error, 'EEXIST')) throw error;
    }
  }
  throw new Error('Unable to allocate a unique Runtime Host control-directory reap claim');
}

async function closeReapLock(handle: FileHandle): Promise<void> {
  releaseLock(handle);
  await handle.close().catch(() => undefined);
}

async function assertDirectoryIdentity(path: string, expected: BigIntStats): Promise<void> {
  if (!sameFilesystemIdentity(expected, await lstatPathIfPresent(path))) {
    throw invalidLockArtifact(path);
  }
}

/**
 * The claim lock serializes deletion, including against a quarantiner paused
 * after rename. Each filesystem entry yields back to the batch budget.
 */
async function* removeRootControlClaim(
  controlRoot: string,
  claimDirectory: string,
  heldClaimHandle?: FileHandle,
): AsyncGenerator<ReapEvent> {
  const reapRoot = join(controlRoot, ROOT_CONTROL_REAP_DIRECTORY);
  if (parse(claimDirectory).dir !== reapRoot || !isReapClaimName(parse(claimDirectory).base)) {
    throw invalidLockArtifact(claimDirectory);
  }
  await assertPrivateDirectory(controlRoot);
  await assertPrivateDirectory(reapRoot);
  await assertPrivateDirectory(claimDirectory);
  const rootIdentity = await lstat(controlRoot, { bigint: true });
  const reapIdentity = await lstat(reapRoot, { bigint: true });
  const claimIdentity = await lstat(claimDirectory, { bigint: true });
  const lockPath = join(claimDirectory, ROOT_CONTROL_CLAIM_LOCK);
  const handle = heldClaimHandle ?? (await tryAcquireStableRootLock(lockPath, 'write'));
  if (!handle) {
    yield { busy: 1 };
    return;
  }
  try {
    const guard = async () => {
      await assertDirectoryIdentity(controlRoot, rootIdentity);
      await assertDirectoryIdentity(reapRoot, reapIdentity);
      await assertDirectoryIdentity(claimDirectory, claimIdentity);
      await assertStableLockArtifact(handle, lockPath);
    };
    await guard();
    yield* removeClaimContents(claimDirectory, guard, 0);
    await guard();
  } finally {
    if (!heldClaimHandle) await closeReapLock(handle);
  }
  // No payload remains. Closing the claim lock here permits only competing
  // removers of this empty claim, never an opener of the original root path.
  if (heldClaimHandle) await closeReapLock(heldClaimHandle);
  await unlink(lockPath).catch((error: unknown) => {
    if (!isMissingPathError(error)) throw error;
  });
  await rmdir(claimDirectory).catch((error: unknown) => {
    if (!isMissingPathError(error)) throw error;
  });
  yield { reaped: 1 };
}

async function* removeClaimContents(
  path: string,
  guard: () => Promise<void>,
  depth: number,
): AsyncGenerator<ReapEvent> {
  // Bound open directory handles and call-stack depth independently of width.
  if (depth > 64) throw new Error('Runtime Host tombstone exceeds deletion depth limit');
  await guard();
  const identity = await lstat(path, { bigint: true });
  if (!identity.isDirectory()) throw invalidLockArtifact(path);
  const guardCurrent = async () => {
    await guard();
    await assertDirectoryIdentity(path, identity);
  };
  const directory = await opendir(path);
  try {
    for await (const entry of directory) {
      if (depth === 0 && entry.name === ROOT_CONTROL_CLAIM_LOCK) continue;
      yield {};
      await guardCurrent();
      const child = join(path, entry.name);
      const metadata = await lstatPathIfPresent(child);
      if (!metadata) continue;
      if (metadata.isDirectory()) {
        yield* removeClaimContents(child, guardCurrent, depth + 1);
        await guardCurrent();
        await assertDirectoryIdentity(child, metadata);
        await rmdir(child);
      } else {
        // unlink removes symlinks themselves, never their targets.
        await unlink(child);
      }
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

function isReapClaimName(name: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(name);
}

function sameFilesystemIdentity(expected: BigIntStats, actual: BigIntStats | undefined): boolean {
  return (
    actual?.isDirectory() === true &&
    !actual.isSymbolicLink() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

function requireNonNegativeFiniteOption(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function requireNonNegativeIntegerOption(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
  return value;
}

function createStateRootLock<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
  capabilityRecord: CapabilityRecord<K>,
  access: StorageRootAccess,
  controlDirectory: string,
  lockPath: string,
  isActive: () => boolean,
  beginOperation: () => () => void,
  close: () => Promise<void>,
): StateRootOwner<K> | StateRootReader<K> {
  const lock = Object.freeze({
    capability,
    lease: createLease(capabilityRecord, access, isActive, beginOperation),
    controlDirectory,
    lockPath,
    get closed() {
      return !isActive();
    },
    close,
  }) as StateRootOwner<K> | StateRootReader<K>;
  stateRootLocks.set(lock, { kind: capabilityRecord.kind, access });
  return lock;
}

function createLease<K extends StorageRootKind, A extends StorageRootAccess>(
  capability: CapabilityRecord<K>,
  access: A,
  isActive: () => boolean,
  beginOperation: () => () => void = () => {
    if (!isActive()) throw invalidLease(capability.kind, access);
    return () => {};
  },
): StorageRootLease<K, A> {
  const lease = Object.freeze({
    kind: capability.kind,
    access,
    canonicalPath: capability.canonicalPath,
    rootId: capability.rootId,
  }) as StorageRootLease<K, A>;
  leases.set(lease, { ...capability, access, isActive, beginOperation });
  return lease;
}

function requireCapability<K extends StorageRootKind>(
  capability: StorageRootCapability<K>,
  expectedKind: K,
): CapabilityRecord<K> {
  const record = capabilities.get(capability);
  if (!record || record.kind !== expectedKind) {
    throw new StorageRootAuthorityError(
      'invalid_capability',
      `Expected a ${expectedKind} storage root capability`,
    );
  }
  return record as CapabilityRecord<K>;
}

function requireLease<K extends StorageRootKind, A extends StorageRootAccess>(
  lease: StorageRootLease<K, A>,
  expectedKind: K,
  expectedAccess: A,
): LeaseRecord<K, A> {
  const record = leases.get(lease);
  if (
    !record ||
    record.kind !== expectedKind ||
    record.access !== expectedAccess ||
    !record.isActive()
  ) {
    throw invalidLease(expectedKind, expectedAccess);
  }
  return record as LeaseRecord<K, A>;
}

function invalidLease(kind: StorageRootKind, access: StorageRootAccess): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lease',
    `Expected an active ${kind} ${access} storage root lease`,
  );
}

async function prepareStorageRootControlDirectoryForRecord(
  record: CapabilityRecord,
): Promise<{ controlRoot: string; controlDirectory: string }> {
  await assertRootIdentity(record);
  const controlRoot = await preparePrivateControlRoot();
  const controlDirectory = join(controlRoot, record.rootId);
  await ensurePrivateDirectory(controlDirectory);
  await assertRootIdentity(record);
  return { controlRoot, controlDirectory };
}

async function prepareArtifactWriterLockAuthorityForRecord(
  record: CapabilityRecord,
): Promise<ArtifactWriterLockAuthority> {
  const { controlRoot, controlDirectory } =
    await prepareStorageRootControlDirectoryForRecord(record);
  const bootstrapLockPath = await prepareArtifactWriterBootstrapLockPathForIdentity(
    controlRoot,
    record.identity,
  );
  await assertRootIdentity(record);
  return createArtifactWriterLockAuthority(record, bootstrapLockPath, controlDirectory);
}

function createArtifactWriterLockAuthority(
  record: CapabilityRecord,
  bootstrapLockPath: string,
  controlDirectory: string,
): ArtifactWriterLockAuthority {
  return Object.freeze({
    bootstrapLockPath,
    controlDirectory,
    assertCurrentRoot: () => assertRootIdentity(record),
    [artifactWriterLockAuthorityBrand]: true as const,
  });
}

async function preparePrivateControlRoot(): Promise<string> {
  const controlRoot = resolve(resolveRootControlNamespace());
  await ensurePrivateDirectory(controlRoot);
  return controlRoot;
}

async function ensureDurablePrivateDirectory(path: string): Promise<void> {
  let existingAncestor = path;
  while ((await lstatPathIfPresent(existingAncestor)) === undefined) {
    const parent = parse(existingAncestor).dir;
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  await ensurePrivateDirectory(path);
  await syncDirectoryChain(path, existingAncestor);
}

async function prepareArtifactWriterBootstrapLockPathForIdentity(
  controlRoot: string,
  identity: RootIdentity,
): Promise<string> {
  const directory = join(controlRoot, ARTIFACT_WRITER_BOOTSTRAP_DIRECTORY);
  await ensurePrivateDirectory(directory);
  const identityHash = createHash('sha256')
    .update(`${identity.dev.toString()}:${identity.ino.toString()}`)
    .digest('hex');
  return join(directory, `${identityHash}.lock`);
}

async function assertRootIdentity(record: CapabilityRecord): Promise<void> {
  await withAuthorityFailure(
    'root_io_failed',
    `Unable to validate storage root identity: ${record.canonicalPath}`,
    async () => {
      await confirmRootSnapshot({
        root: record.canonicalPath,
        identity: record.identity,
        readMarker: () => readAndValidateRootMarker(record.canonicalPath, record.kind),
        expectedRootId: record.rootId,
        markerMismatchCode: 'root_identity_changed',
        markerMismatchMessage: `Storage root marker identity changed: ${record.canonicalPath}`,
      });
    },
  );
}

interface ConfirmRootSnapshotInput {
  root: string;
  identity: RootIdentity;
  readMarker(): Promise<RootMarker>;
  expectedRootId?: string;
  markerMismatchCode: 'root_identity_collision' | 'root_identity_changed';
  markerMismatchMessage: string;
}

async function confirmRootSnapshot(input: ConfirmRootSnapshotInput): Promise<RootMarker> {
  const identityChangedMessage = `Storage root identity changed while validating its marker: ${input.root}`;
  await assertRootPathIdentity(input.root, input.identity, identityChangedMessage);
  let marker: RootMarker;
  try {
    marker = await input.readMarker();
  } catch (error) {
    await assertRootPathIdentity(input.root, input.identity, identityChangedMessage);
    throw error;
  }
  await assertRootPathIdentity(input.root, input.identity, identityChangedMessage);
  if (
    (input.expectedRootId !== undefined && marker.rootId !== input.expectedRootId) ||
    !markerMatchesIdentity(marker, input.identity)
  ) {
    throw new StorageRootAuthorityError(input.markerMismatchCode, input.markerMismatchMessage);
  }
  return marker;
}

async function ensureRootMarker(
  root: string,
  kind: StorageRootKind,
  identity: RootIdentity,
): Promise<RootMarker> {
  const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
  try {
    await lstat(markerPath);
    return await readAndValidateRootMarker(root, kind);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  const marker: RootMarker = {
    schemaVersion: STORAGE_ROOT_MARKER_SCHEMA_VERSION,
    kind,
    rootId: randomBytes(32).toString('hex'),
    rootIdentity: {
      dev: identity.dev.toString(),
      ino: identity.ino.toString(),
    },
  };
  await publishMarkerFile({
    root,
    markerFile: STORAGE_ROOT_MARKER_FILE,
    contents: `${JSON.stringify(marker)}\n`,
    maxBytes: MAX_STORAGE_ROOT_MARKER_BYTES,
    publication: 'create',
    beforePublish: () =>
      assertRootPathIdentity(
        root,
        identity,
        `Storage root identity changed before publishing its marker: ${root}`,
      ),
    invalidFile: () =>
      new StorageRootAuthorityError(
        'invalid_marker',
        `Storage root marker candidate exceeds the size limit: ${markerPath}`,
      ),
  });
  return readAndValidateRootMarker(root, kind);
}

async function replaceRootMarkerIdentity(
  root: string,
  identity: RootIdentity,
  sourceMarker: RootMarker,
): Promise<RootMarker> {
  return withExclusiveRootMarker(root, identity, sourceMarker.kind, async (current) => {
    assertRootMarkerUnchanged(root, current, sourceMarker);
    const marker: RootMarker = {
      ...current,
      rootIdentity: {
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
      },
    };
    const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
    await publishMarkerFile({
      root,
      markerFile: STORAGE_ROOT_MARKER_FILE,
      contents: `${JSON.stringify(marker)}\n`,
      maxBytes: MAX_STORAGE_ROOT_MARKER_BYTES,
      publication: 'replace',
      beforePublish: async () => {
        await assertRootPathIdentity(
          root,
          identity,
          `Storage root identity changed before updating its marker: ${root}`,
        );
        assertRootMarkerUnchanged(
          root,
          await readAndValidateRootMarker(root, sourceMarker.kind),
          sourceMarker,
        );
      },
      invalidFile: () =>
        new StorageRootAuthorityError(
          'invalid_marker',
          `Storage root marker candidate exceeds the size limit: ${markerPath}`,
        ),
    });
    await assertRootPathIdentity(
      root,
      identity,
      `Storage root identity changed after updating its marker: ${root}`,
    );
    const adopted = await readAndValidateRootMarker(root, sourceMarker.kind);
    if (adopted.rootId !== sourceMarker.rootId || !markerMatchesIdentity(adopted, identity)) {
      throw new StorageRootAuthorityError(
        'root_identity_changed',
        `Storage root marker changed while updating its identity: ${root}`,
      );
    }
    return adopted;
  });
}

async function withExclusiveRootMarker<T>(
  root: string,
  identity: RootIdentity,
  expectedKind: StorageRootKind,
  operation: (marker: RootMarker) => Promise<T>,
): Promise<T> {
  const controlRoot = await preparePrivateControlRoot();
  const lockPath = await prepareArtifactWriterBootstrapLockPathForIdentity(controlRoot, identity);
  return withArtifactWriterBootstrapLock(lockPath, async () => {
    await assertRootPathIdentity(
      root,
      identity,
      `Storage root identity changed while acquiring its marker publication lock: ${root}`,
    );
    const marker = await readAndValidateRootMarker(root, expectedKind);
    return operation(marker);
  });
}

function assertRootMarkerUnchanged(root: string, current: RootMarker, expected: RootMarker): void {
  if (!rootMarkersEqual(current, expected)) {
    throw new StorageRootAuthorityError(
      'root_identity_collision',
      `Storage root marker changed while updating its identity: ${root}`,
    );
  }
}

function invalidRootMarker(markerPath: string, cause?: unknown): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_marker',
    `Invalid storage root marker at ${markerPath}${cause instanceof Error ? `: ${cause.message}` : ''}`,
    cause === undefined ? undefined : { cause },
  );
}

async function assertRootPathIdentity(
  root: string,
  identity: RootIdentity,
  message: string,
): Promise<void> {
  const rootStat = await statRootIfPresent(root);
  if (!rootStat?.isDirectory() || rootStat.dev !== identity.dev || rootStat.ino !== identity.ino) {
    throw new StorageRootAuthorityError('root_identity_changed', message);
  }
}

async function readAndValidateRootMarker(
  root: string,
  _expectedKind: StorageRootKind,
): Promise<RootMarker> {
  return readRootMarker(root);
}

async function readRootMarker(root: string): Promise<RootMarker> {
  const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
  let contents: string;
  try {
    contents = await readBoundedMarkerFile({
      path: markerPath,
      maxBytes: MAX_STORAGE_ROOT_MARKER_BYTES,
      invalidFile: () =>
        new StorageRootAuthorityError(
          'invalid_marker',
          `Storage root marker must be one bounded regular file: ${markerPath}`,
        ),
    });
  } catch (error) {
    if (error instanceof StorageRootAuthorityError) throw error;
    if (isNodeError(error, 'ENOENT')) {
      throw new StorageRootAuthorityError('root_unmarked', `Storage root is not marked: ${root}`);
    }
    if (isInvalidMarkerPathError(error)) throw invalidRootMarker(markerPath, error);
    throw error;
  }
  return parseRootMarker(contents, markerPath);
}

function parseRootMarker(contents: string, markerPath: string): RootMarker {
  let marker: unknown;
  try {
    marker = JSON.parse(contents);
  } catch (error) {
    throw invalidRootMarker(markerPath, error);
  }
  if (!isRootMarker(marker)) {
    throw invalidRootMarker(markerPath);
  }
  return marker;
}

function isRootMarker(value: unknown): value is RootMarker {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Record<string, unknown>;
  return (
    marker.schemaVersion === STORAGE_ROOT_MARKER_SCHEMA_VERSION &&
    marker.kind === 'interactive' &&
    typeof marker.rootId === 'string' &&
    /^[a-f0-9]{64}$/.test(marker.rootId) &&
    isMarkerRootIdentity(marker.rootIdentity)
  );
}

function isMarkerRootIdentity(value: unknown): value is RootMarker['rootIdentity'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity.dev === 'string' &&
    /^\d+$/.test(identity.dev) &&
    typeof identity.ino === 'string' &&
    /^\d+$/.test(identity.ino)
  );
}

/**
 * Whether the marker describes the directory that was just stat'd.
 *
 * Both fields, and no classification of how a mismatch came about. A moved
 * `dev` with a matching `ino` reads like a remount — the kernel hands out a
 * device number per mount, so an unmoved directory reports a new one after its
 * volume is mounted again — but a workspace restored onto another volume
 * presents the same pair, because inode numbers are unique only within one
 * mounted filesystem. Naming that case a remount would let a second, unrelated
 * directory inherit the original's rootId without anyone confirming it, and
 * nothing in the marker can tell the two apart. It stays a question for the
 * person; `adoptStorageRootOnImport` is the sanctioned way in for a copy,
 * where the caller states the rootId it expects.
 */
function markerMatchesIdentity(marker: RootMarker, identity: RootIdentity): boolean {
  return (
    marker.rootIdentity.dev === identity.dev.toString() &&
    marker.rootIdentity.ino === identity.ino.toString()
  );
}

function rootMarkersEqual(left: RootMarker, right: RootMarker): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.rootId === right.rootId &&
    left.rootIdentity.dev === right.rootIdentity.dev &&
    left.rootIdentity.ino === right.rootIdentity.ino
  );
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  let directoryStat = await lstat(path);
  if (!directoryStat.isDirectory()) {
    throw new StorageRootAuthorityError(
      'insecure_control_directory',
      `Runtime Host control path is not a directory: ${path}`,
    );
  }
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new StorageRootAuthorityError(
      'insecure_control_directory',
      `Runtime Host control path is not owned by the current user: ${path}`,
    );
  }
  await chmod(path, 0o700);
  directoryStat = await lstat(path);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new StorageRootAuthorityError(
      'insecure_control_directory',
      `Runtime Host control path is not private: ${path}`,
    );
  }
}

async function assertPrivateDirectory(path: string): Promise<void> {
  const directoryStat = await lstat(path);
  if (!directoryStat.isDirectory()) {
    throw new StorageRootAuthorityError(
      'insecure_control_directory',
      `Runtime Host control path is not a directory: ${path}`,
    );
  }
  if (process.platform === 'win32') return;
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new StorageRootAuthorityError(
      'insecure_control_directory',
      `Runtime Host control path is not owned by the current user: ${path}`,
    );
  }
  if ((directoryStat.mode & 0o077) !== 0) {
    throw new StorageRootAuthorityError(
      'insecure_control_directory',
      `Runtime Host control path is not private: ${path}`,
    );
  }
}

async function assertStableLockArtifact(handle: FileHandle, path: string): Promise<void> {
  let stable = false;
  try {
    const [handleStat, pathStat] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    stable =
      handleStat.isFile() &&
      pathStat.isFile() &&
      handleStat.dev === pathStat.dev &&
      handleStat.ino === pathStat.ino;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
  if (!stable) {
    throw invalidLockArtifact(path);
  }
}

function invalidLockArtifact(path: string): StorageRootAuthorityError {
  return new StorageRootAuthorityError(
    'invalid_lock_artifact',
    `Storage root lock path is not one stable regular file: ${path}`,
  );
}

function releaseLock(handle: FileHandle): void {
  try {
    unlock(handle.fd);
  } catch {
    // Closing the OS handle is the authoritative release path.
  }
}

function canonicalizePath(path: string): string {
  const normalized = normalize(path);
  const root = parse(normalized).root;
  return normalized === root ? normalized : normalized.replace(/[\\/]+$/, '');
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error, 'ENOENT') || isNodeError(error, 'ENOTDIR');
}

function isInvalidMarkerPathError(error: unknown): boolean {
  return isMissingPathError(error) || isNodeError(error, 'ELOOP') || isNodeError(error, 'ENXIO');
}

async function statRootIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function lstatPathIfPresent(path: string): Promise<BigIntStats | undefined> {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw error;
  }
}

async function withAuthorityFailure<T>(
  code: Extract<
    StorageRootAuthorityErrorCode,
    'root_io_failed' | 'control_io_failed' | 'lock_failed'
  >,
  message: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeAuthorityFailure(error, code, message);
  }
}

function normalizeAuthorityFailure(
  error: unknown,
  code: Extract<
    StorageRootAuthorityErrorCode,
    'root_io_failed' | 'control_io_failed' | 'lock_failed'
  >,
  message: string,
): StorageRootAuthorityError {
  if (error instanceof StorageRootAuthorityError) return error;
  return new StorageRootAuthorityError(code, message, { cause: error });
}
