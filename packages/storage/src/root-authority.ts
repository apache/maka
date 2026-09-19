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

import { randomBytes, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { isAbsolute, join, normalize, parse, resolve } from 'node:path';
import { tryLock, unlock } from 'fs-native-extensions';

import { withArtifactWriterBootstrapLock } from './artifact-writer-bootstrap-lock.js';
import { publishMarkerFile, readBoundedMarkerFile } from './marker-file.js';
import { syncDirectoryChain } from './stable-storage.js';

export const STORAGE_ROOT_MARKER_FILE = '.maka-storage-root.json';
export const STORAGE_ROOT_MARKER_SCHEMA_VERSION = 2 as const;
const MAX_STORAGE_ROOT_MARKER_BYTES = 32 * 1_024;
const ARTIFACT_WRITER_BOOTSTRAP_LOCK_FILE = 'artifact-writer-bootstrap.lock';

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
  readonly lockDirectory: string;
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
  readonly hostDataDirectory: string;
  readonly lockPath: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

export interface StateRootReader<K extends StorageRootKind = StorageRootKind> {
  readonly capability: StorageRootCapability<K>;
  readonly lease: StorageRootLease<K, 'read'>;
  readonly controlDirectory: string;
  readonly hostDataDirectory: string;
  readonly lockPath: string;
  readonly closed: boolean;
  close(): Promise<void>;
}

export type InteractiveRootOwner = StateRootOwner<'interactive'>;
export type InteractiveRootReader = StateRootReader<'interactive'>;

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
  schemaVersion: 1 | typeof STORAGE_ROOT_MARKER_SCHEMA_VERSION;
  upgrade?: RootUpgrade;
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
  | 'legacy_root_requires_migration'
  | 'root_migration_busy'
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
  return withAuthorityFailure('root_io_failed', 'Unable to resolve the storage root', async () => {
    const { canonicalPath, identity, marker } = await resolveStorageRootSnapshot(input);
    assertCurrentRootFormat(canonicalPath, marker);
    return createCapability(input.kind, canonicalPath, marker.rootId, identity);
  });
}

/** Resolve or initialize identity without granting business access or upgrading an existing root. */
export async function resolveStorageRootIdentity(
  input: ResolveStorageRootInput<StorageRootKind>,
): Promise<{
  readonly canonicalPath: string;
  readonly rootId: string;
}> {
  assertStorageRootKind(input.kind);
  return withAuthorityFailure(
    'root_io_failed',
    'Unable to resolve the storage root identity',
    async () => {
      const { canonicalPath, marker } = await resolveStorageRootSnapshot(input);
      return { canonicalPath, rootId: marker.rootId };
    },
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

async function resolveStorageRootSnapshot<K extends StorageRootKind>(
  input: ResolveStorageRootInput<K>,
) {
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
  return { canonicalPath, marker, identity };
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
        readMarker: () => readRootMarker(canonicalPath),
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
      let marker = await readRootMarker(canonicalPath);
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
        readMarker: () => readRootMarker(canonicalPath),
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
        marker = await readPersistedRootMarker(canonicalPath);
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
): Promise<void> {
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
): Promise<void> {
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
      const marker = await readPersistedRootMarker(record.canonicalPath);
      await assertRootPathIdentity(record.canonicalPath, record.identity, identityChangedMessage);
      if (!rootMarkersEqual(marker, record.marker)) {
        throw new StorageRootAuthorityError(
          'root_identity_changed',
          `Storage root marker changed while awaiting repair: ${record.canonicalPath}`,
        );
      }
      await replaceRootMarkerIdentity(record.canonicalPath, record.identity, record.marker);
      await confirmRootSnapshot({
        root: record.canonicalPath,
        identity: record.identity,
        readMarker: () => readPersistedRootMarker(record.canonicalPath),
        expectedRootId: record.rootId,
        markerMismatchCode: 'root_identity_changed',
        markerMismatchMessage: `Repaired storage root identity changed: ${record.canonicalPath}`,
      });
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

export function resolveRootControlNamespace(rootPath: string): string {
  return join(resolveRootOwnershipNamespace(rootPath), 'runtime');
}

/**
 * Resolves the durable namespace that owns State Root process election.
 *
 * Endpoint registrations and diagnostics remain in the disposable control
 * namespace. The owner lock must not: deleting a cache directory while a Host
 * is running must never make the same State Root acquirable again.
 */
export function resolveRootOwnershipNamespace(rootPath: string): string {
  if (!isAbsolute(rootPath)) throw new TypeError('State Root path must be absolute');
  return join(rootPath, '.maka-host');
}

export function resolveRootHostDataDirectory(rootPath: string): string {
  return join(resolveRootOwnershipNamespace(rootPath), 'state', 'data');
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
): Promise<{ controlDirectory: string }> {
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
): Promise<{ controlDirectory: string }> {
  return withAuthorityFailure(
    'control_io_failed',
    'Unable to validate the existing Runtime Host control directory',
    async () => {
      const record = requireCapability(capability, capability.kind);
      await assertRootIdentity(record);
      const controlDirectory = resolveRootControlNamespace(record.canonicalPath);
      await assertPrivateDirectory(controlDirectory);
      await assertRootIdentity(record);
      return { controlDirectory };
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
      const controlRoot = await prepareRootOwnershipDirectory(canonicalPath);
      const lockPath = join(controlRoot, ARTIFACT_WRITER_BOOTSTRAP_LOCK_FILE);
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
  await assertRootIdentity(capabilityRecord);
  const ownershipRoot = resolveRootOwnershipNamespace(capabilityRecord.canonicalPath);
  await ensureDurablePrivateDirectory(ownershipRoot);
  const lockPath = join(ownershipRoot, `${capabilityRecord.rootId}.lock`);
  const durableHandle = await tryAcquireStableRootLock(lockPath, access);
  if (!durableHandle) return undefined;

  let controlDirectory: string;
  try {
    ({ controlDirectory } = await prepareStorageRootControlDirectory(capability));
    await ensureDurablePrivateDirectory(
      resolveRootHostDataDirectory(capabilityRecord.canonicalPath),
    );
    await assertRootIdentity(capabilityRecord);
  } catch (error) {
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
        releaseLock(durableHandle);
        await durableHandle.close();
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
    hostDataDirectory: resolveRootHostDataDirectory(capabilityRecord.canonicalPath),
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
): Promise<{ controlDirectory: string }> {
  await assertRootIdentity(record);
  await prepareRootOwnershipDirectory(record.canonicalPath);
  const controlDirectory = resolveRootControlNamespace(record.canonicalPath);
  await ensurePrivateDirectory(controlDirectory);
  await assertRootIdentity(record);
  return { controlDirectory };
}

async function prepareArtifactWriterLockAuthorityForRecord(
  record: CapabilityRecord,
): Promise<ArtifactWriterLockAuthority> {
  await assertRootIdentity(record);
  const controlRoot = await prepareRootOwnershipDirectory(record.canonicalPath);
  const bootstrapLockPath = join(controlRoot, ARTIFACT_WRITER_BOOTSTRAP_LOCK_FILE);
  await assertRootIdentity(record);
  return createArtifactWriterLockAuthority(record, bootstrapLockPath, controlRoot);
}

function createArtifactWriterLockAuthority(
  record: CapabilityRecord,
  bootstrapLockPath: string,
  lockDirectory: string,
): ArtifactWriterLockAuthority {
  return Object.freeze({
    bootstrapLockPath,
    lockDirectory,
    assertCurrentRoot: () => assertRootIdentity(record),
    [artifactWriterLockAuthorityBrand]: true as const,
  });
}

async function prepareRootOwnershipDirectory(rootPath: string): Promise<string> {
  const controlRoot = resolveRootOwnershipNamespace(rootPath);
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

async function assertRootIdentity(record: CapabilityRecord): Promise<void> {
  await withAuthorityFailure(
    'root_io_failed',
    `Unable to validate storage root identity: ${record.canonicalPath}`,
    async () => {
      await confirmRootSnapshot({
        root: record.canonicalPath,
        identity: record.identity,
        readMarker: () => readRootMarker(record.canonicalPath),
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
    return await readPersistedRootMarker(root);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }

  // Committed state without its marker means the marker was lost; a fresh
  // rootId would orphan everything bound to the old identity.
  if (await hasCommittedState(root))
    throw new StorageRootAuthorityError(
      'invalid_marker',
      `Storage root holds committed state but its marker is missing: ${root}; restore the marker from backup, or remove .maka-host to adopt the directory as a new root`,
    );

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
  return readPersistedRootMarker(root);
}

async function replaceRootMarkerIdentity(
  root: string,
  identity: RootIdentity,
  sourceMarker: RootMarker,
): Promise<RootMarker> {
  return withExclusiveRootMarker(root, identity, async (current) => {
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
        assertRootMarkerUnchanged(root, await readPersistedRootMarker(root), sourceMarker);
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
    const adopted = await readPersistedRootMarker(root);
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
  operation: (marker: RootMarker) => Promise<T>,
): Promise<T> {
  const controlRoot = await prepareRootOwnershipDirectory(root);
  const lockPath = join(controlRoot, ARTIFACT_WRITER_BOOTSTRAP_LOCK_FILE);
  return withArtifactWriterBootstrapLock(lockPath, async () => {
    await assertRootPathIdentity(
      root,
      identity,
      `Storage root identity changed while acquiring its marker publication lock: ${root}`,
    );
    const marker = await readPersistedRootMarker(root);
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

async function readRootMarker(root: string): Promise<RootMarker> {
  const marker = await readPersistedRootMarker(root);
  assertCurrentRootFormat(root, marker);
  return marker;
}

function assertCurrentRootFormat(root: string, marker: RootMarker): void {
  if (marker.schemaVersion !== STORAGE_ROOT_MARKER_SCHEMA_VERSION || marker.upgrade) {
    throw new StorageRootAuthorityError(
      'legacy_root_requires_migration',
      `State Root upgrade must complete before business access: ${root}`,
    );
  }
}

async function readPersistedRootMarker(root: string): Promise<RootMarker> {
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
    (marker.schemaVersion === 1 || marker.schemaVersion === STORAGE_ROOT_MARKER_SCHEMA_VERSION) &&
    (!('upgrade' in marker) ||
      (marker.schemaVersion === STORAGE_ROOT_MARKER_SCHEMA_VERSION &&
        isRootUpgrade(marker.upgrade))) &&
    Object.keys(marker).every((key) =>
      ['schemaVersion', 'kind', 'rootId', 'rootIdentity', 'upgrade'].includes(key),
    ) &&
    marker.kind === 'interactive' &&
    typeof marker.rootId === 'string' &&
    /^[a-f0-9]{64}$/.test(marker.rootId) &&
    isMarkerRootIdentity(marker.rootIdentity)
  );
}

interface RootUpgrade {
  readonly id: string;
}

function isRootUpgrade(value: unknown): value is RootUpgrade {
  if (!value || typeof value !== 'object') return false;
  const upgrade = value as Record<string, unknown>;
  return (
    typeof upgrade.id === 'string' &&
    /^[a-f0-9-]{36}$/.test(upgrade.id) &&
    Object.keys(upgrade).every((key) => key === 'id')
  );
}

/** A format transition fence, never a business writer capability. */
export interface StorageRootUpgradeSession {
  readonly canonicalPath: string;
  readonly rootId: string;
  readonly upgrade: RootUpgrade | undefined;
  acquireLegacyLock(path: string): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
}

/** Identity-only inspection for the installer; this grants no read/write lease. */
export async function inspectStorageRootFormat(path: string): Promise<{
  readonly canonicalPath: string;
  readonly rootId: string;
  readonly format: 'legacy' | 'upgrading' | 'current';
}> {
  return withAuthorityFailure('root_io_failed', 'Unable to inspect the storage root', async () => {
    const { canonicalPath, rootStat } = await resolveExistingRootPath(path);
    const marker = await readPersistedRootMarker(canonicalPath);
    if (!markerMatchesIdentity(marker, { dev: rootStat.dev, ino: rootStat.ino })) {
      throw new StorageRootAuthorityError(
        'root_identity_collision',
        'State Root identity must be repaired before opening',
      );
    }
    await assertRootPathIdentity(
      canonicalPath,
      { dev: rootStat.dev, ino: rootStat.ino },
      'Root moved during inspection',
    );
    return {
      canonicalPath,
      rootId: marker.rootId,
      format: marker.schemaVersion === 1 ? 'legacy' : marker.upgrade ? 'upgrading' : 'current',
    };
  });
}

/** Storage owns exclusion/publication; the Host owns interpretation of legacy data. */
export async function withStorageRootUpgrade(
  path: string,
  operation: (session: StorageRootUpgradeSession) => Promise<void>,
): Promise<void> {
  const { canonicalPath: root, rootStat } = await withAuthorityFailure(
    'root_io_failed',
    'Unable to open the storage root for upgrade',
    () => resolveExistingRootPath(path),
  );
  const identity = { dev: rootStat.dev, ino: rootStat.ino };
  const markerPath = join(root, STORAGE_ROOT_MARKER_FILE);
  const read = () =>
    readBoundedMarkerFile({
      path: markerPath,
      maxBytes: MAX_STORAGE_ROOT_MARKER_BYTES,
      invalidFile: () => invalidRootMarker(markerPath),
    }).catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT'))
        throw new StorageRootAuthorityError('root_unmarked', `Storage root is not marked: ${root}`);
      throw normalizeAuthorityFailure(
        error,
        'root_io_failed',
        `Unable to read the storage root marker: ${markerPath}`,
      );
    });
  let encoded = await read();
  const decode = (text: string) => {
    const raw = parseRootMarker(text, markerPath);
    const { upgrade, ...fields } = raw;
    const ready = { ...fields, schemaVersion: STORAGE_ROOT_MARKER_SCHEMA_VERSION };
    if (!markerMatchesIdentity(ready, identity))
      throw new StorageRootAuthorityError(
        'root_identity_collision',
        'State Root identity must be repaired before its format is upgraded',
      );
    return { ready, upgrade, legacy: raw.schemaVersion === 1 };
  };
  let state = decode(encoded);
  if (!state.legacy && !state.upgrade) return;
  // A legacy marker without a fence next to a formed state directory is not a
  // legacy root: the original marker was lost and something re-marked the
  // root. Migrating it would stage empty sources and delete the committed
  // state.
  if (state.legacy && !state.upgrade && (await hasCommittedState(root)))
    throw new StorageRootAuthorityError(
      'invalid_marker',
      `Storage root holds committed state but its marker declares the legacy format: ${root}; the marker was likely lost and recreated — restore the original marker, or remove .maka-host to rebuild`,
    );
  const authority = await withAuthorityFailure(
    'control_io_failed',
    `Unable to prepare the control directory for storage root: ${root}`,
    () => prepareRootOwnershipDirectory(root),
  );
  const handles: FileHandle[] = [];
  let active = true;
  const check = async () => {
    if (!active) throw new StorageRootAuthorityError('invalid_lease', 'Upgrade fence is closed');
    await assertRootPathIdentity(root, identity, 'State Root moved during upgrade');
    if ((await read()) !== encoded)
      throw new StorageRootAuthorityError(
        'root_identity_changed',
        'State Root marker changed during upgrade',
      );
  };
  const acquire = async (lockPath: string) => {
    const handle = await tryAcquireStableRootLock(lockPath, 'write').catch((error: unknown) => {
      throw normalizeAuthorityFailure(
        error,
        'lock_failed',
        `Unable to acquire the root lock: ${lockPath}`,
      );
    });
    if (!handle)
      throw new StorageRootAuthorityError(
        'root_migration_busy',
        'State Root upgrade is waiting for its existing owner',
      );
    handles.push(handle);
  };
  const publish = async (value: unknown) => {
    await check();
    const contents = `${JSON.stringify(value)}\n`;
    await publishMarkerFile({
      root,
      markerFile: STORAGE_ROOT_MARKER_FILE,
      contents,
      maxBytes: MAX_STORAGE_ROOT_MARKER_BYTES,
      publication: 'replace',
      beforePublish: check,
      invalidFile: () => invalidRootMarker(markerPath),
    });
    await syncDirectoryChain(root, root);
    encoded = contents;
    state = decode(encoded);
  };
  let failed = true;
  try {
    const lockedRootId = state.ready.rootId;
    await acquire(join(authority, `${state.ready.rootId}.lock`));
    // Marker repair/adoption holds only the bootstrap lock; acquire it before
    // re-reading so no writer can republish between the read and the checks.
    await acquire(join(authority, ARTIFACT_WRITER_BOOTSTRAP_LOCK_FILE));
    encoded = await read();
    state = decode(encoded);
    if (state.ready.rootId !== lockedRootId)
      throw new StorageRootAuthorityError(
        'root_identity_changed',
        'Root id changed while acquiring upgrade ownership',
      );
    if (!state.legacy && !state.upgrade) {
      failed = false;
      return;
    }
    await operation({
      canonicalPath: root,
      rootId: state.ready.rootId,
      get upgrade() {
        return state.upgrade;
      },
      async acquireLegacyLock(lockPath) {
        await check();
        // Absence is handled by the legacy owner, never by creating an account home here.
        await acquire(lockPath);
      },
      async begin() {
        await check();
        if (state.upgrade) return;
        await publish({ ...state.ready, upgrade: { id: randomUUID() } });
      },
      async commit() {
        if (!state.upgrade)
          throw new StorageRootAuthorityError('invalid_marker', 'Upgrade has not taken ownership');
        await publish(state.ready);
      },
    });
    failed = false;
  } finally {
    active = false;
    const errors: unknown[] = [];
    for (const handle of handles.reverse()) {
      releaseLock(handle);
      await handle.close().catch((error: unknown) => errors.push(error));
    }
    if (errors.length && !failed)
      throw errors.length === 1
        ? errors[0]
        : new AggregateError(errors, 'Unable to release upgrade locks');
  }
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
    left.rootIdentity.ino === right.rootIdentity.ino &&
    JSON.stringify(left.upgrade) === JSON.stringify(right.upgrade)
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

// A formed state directory is the single witness that a root was marked and
// committed: minting a fresh marker over it would orphan the durable state
// and every record bound to the old identity. A bare .maka-host is just
// bootstrap debris and may be marked normally.
async function hasCommittedState(root: string): Promise<boolean> {
  return (
    (await lstatPathIfPresent(join(resolveRootOwnershipNamespace(root), 'state'))) !== undefined
  );
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
