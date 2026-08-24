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

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createRequire } from 'node:module';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, posix, relative, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { tryLock, unlock } from 'fs-native-extensions';

const MANAGED_DEPENDENCY_IDENTITY_DOMAIN = 'maka.managed_dependency_environment.v1\0';
const MANAGED_DEPENDENCY_TREE_DOMAIN = 'maka.managed_dependency_environment.tree.v1\0';
const AUTHORITY_DATABASE_NAME = 'dependency-environment-authority-v1.sqlite';
const DEPENDENCY_ROOT_NAME = 'node_modules';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MANAGED_DEPENDENCY_PRODUCER_POLICY_DOMAIN =
  'maka.managed_dependency_environment.producer_policy.v1\0';
const MANAGED_DEPENDENCY_PRODUCER_POLICY_V1 = Object.freeze({
  protocolVersion: 1 as const,
  kind: 'hermetic_dependency_builder_v1' as const,
  network: 'registry_https_only' as const,
  filesystem: 'maka_owned_staging_only' as const,
  secrets: 'none' as const,
  childProcess: 'verified_runtime_only' as const,
  lifecycleScripts: 'disabled' as const,
});
const activeAuthorityOwners = new Map<string, object>();
const RECEIPT_KEYS = [
  'protocolVersion',
  'environmentId',
  'manifestPath',
  'manifestSha256',
  'lockfilePath',
  'lockfileSha256',
  'packageManagerName',
  'packageManagerVersion',
  'nodeVersion',
  'nodeAbi',
  'platform',
  'arch',
  'producerRuntimeIdentitySha256',
  'producerPolicyIdentitySha256',
  'policyVersion',
  'dependencyRootName',
  'contentTreeSha256',
  'contentBytes',
  'contentEntries',
] as const;
const require = createRequire(import.meta.url);

export type ManagedDependencyPackageManager = 'npm' | 'pnpm' | 'yarn';

export interface ComputeManagedDependencyEnvironmentIdentityInput {
  readonly manifestPath: string;
  readonly manifestBytes: Uint8Array;
  readonly lockfilePath: string;
  readonly lockfileBytes: Uint8Array;
  readonly packageManagerName: ManagedDependencyPackageManager;
  readonly packageManagerVersion: string;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly producerRuntimeIdentitySha256: `sha256:${string}`;
  readonly producerPolicyIdentitySha256: `sha256:${string}`;
  readonly policyVersion: 'managed_dependency_environment_v1';
}

export interface ManagedDependencyEnvironmentIdentityV1 {
  readonly protocolVersion: 1;
  readonly environmentId: `sha256:${string}`;
  readonly manifestPath: string;
  readonly manifestSha256: `sha256:${string}`;
  readonly lockfilePath: string;
  readonly lockfileSha256: `sha256:${string}`;
  readonly packageManagerName: ManagedDependencyPackageManager;
  readonly packageManagerVersion: string;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly producerRuntimeIdentitySha256: `sha256:${string}`;
  readonly producerPolicyIdentitySha256: `sha256:${string}`;
  readonly policyVersion: 'managed_dependency_environment_v1';
}

export interface ManagedDependencyEnvironmentProducerCapabilityV1 {
  readonly protocolVersion: 1;
  readonly kind: 'hermetic_dependency_builder_v1';
  readonly runtimeIdentitySha256: `sha256:${string}`;
  readonly policyIdentitySha256: `sha256:${string}`;
  readonly network: 'registry_https_only';
  readonly filesystem: 'maka_owned_staging_only';
  readonly secrets: 'none';
  readonly childProcess: 'verified_runtime_only';
  readonly lifecycleScripts: 'disabled';
}

export interface ManagedDependencyEnvironmentProducerInput {
  readonly identity: ManagedDependencyEnvironmentIdentityV1;
  readonly outputRoot: string;
  readonly scratchRoot: string;
  readonly manifestBytes: Uint8Array;
  readonly lockfileBytes: Uint8Array;
  readonly abortSignal?: AbortSignal;
}

export interface ManagedDependencyEnvironmentProducer {
  readonly capability: ManagedDependencyEnvironmentProducerCapabilityV1;
  readonly packageManagerName: ManagedDependencyPackageManager;
  readonly packageManagerVersion: string;
  readonly nodeRuntime: {
    readonly version: string;
    readonly abi: string;
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  };
  provision(input: ManagedDependencyEnvironmentProducerInput): Promise<void>;
}

export function createManagedDependencyEnvironmentProducerCapability(
  runtimeIdentitySha256: `sha256:${string}`,
): ManagedDependencyEnvironmentProducerCapabilityV1 {
  if (!SHA256_PATTERN.test(runtimeIdentitySha256)) {
    throw new TypeError('Managed dependency producer runtime identity must be a SHA-256 digest');
  }
  return Object.freeze({
    ...MANAGED_DEPENDENCY_PRODUCER_POLICY_V1,
    runtimeIdentitySha256,
    policyIdentitySha256: managedDependencyProducerPolicyIdentity(),
  });
}

export interface CreateManagedDependencyEnvironmentAuthorityInput {
  readonly storageRoot: string;
  readonly producer: ManagedDependencyEnvironmentProducer;
  readonly maxCacheBytes?: number;
  readonly failpoint?: (point: ManagedDependencyEnvironmentFailpoint) => void | Promise<void>;
}

export type ManagedDependencyEnvironmentFailpoint =
  | 'before_environment_lease'
  | 'after_environment_tree_durable'
  | 'after_environment_receipt_durable'
  | 'after_environment_publish';

export interface AcquireManagedDependencyEnvironmentInput {
  readonly manifestBytes: Uint8Array;
  readonly lockfileBytes: Uint8Array;
  readonly abortSignal?: AbortSignal;
}

export interface ManagedDependencyEnvironmentLease {
  readonly environmentId: `sha256:${string}`;
  readonly dependencyRoot: string;
  release(): Promise<void>;
}

export interface ManagedDependencyEnvironmentAuthority {
  acquire(
    identity: ManagedDependencyEnvironmentIdentityV1,
    input: AcquireManagedDependencyEnvironmentInput,
  ): Promise<ManagedDependencyEnvironmentLease>;
  close(): Promise<void>;
}

interface ManagedDependencyEnvironmentReceiptV1 extends ManagedDependencyEnvironmentIdentityV1 {
  readonly dependencyRootName: typeof DEPENDENCY_ROOT_NAME;
  readonly contentTreeSha256: `sha256:${string}`;
  readonly contentBytes: number;
  readonly contentEntries: number;
}

interface PublishedManagedDependencyEnvironment {
  readonly receipt: ManagedDependencyEnvironmentReceiptV1;
  readonly dependencyRoot: string;
}

interface DependencyReceiptAuthority {
  read(digest: string): ManagedDependencyEnvironmentReceiptV1 | undefined;
  list(): readonly ManagedDependencyEnvironmentReceiptV1[];
  write(receipt: ManagedDependencyEnvironmentReceiptV1): void;
  delete(digest: string): void;
  close(): void;
}

interface DependencyAuthorityOwnerLock {
  release(): Promise<void>;
}

function openDependencyReceiptAuthority(path: string): DependencyReceiptAuthority {
  const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  const database: DatabaseSync = new Database(path);
  database.exec('PRAGMA synchronous = FULL');
  const version = Number(
    (
      database.prepare('PRAGMA user_version').get() as {
        user_version?: unknown;
      }
    ).user_version,
  );
  if (version !== 0 && version !== 1) {
    database.close();
    throw new Error(`Unsupported managed dependency receipt authority version ${version}`);
  }
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE IF NOT EXISTS managed_dependency_environment_receipts (
      environment_digest TEXT PRIMARY KEY NOT NULL CHECK (
        length(environment_digest) = 64 AND
        environment_digest NOT GLOB '*[^0-9a-f]*'
      ),
      receipt_json TEXT NOT NULL
    ) STRICT;
    PRAGMA user_version = 1;
    COMMIT;
  `);
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error('Managed dependency receipt authority is closed');
  };
  return Object.freeze({
    read(digest: string) {
      assertOpen();
      requireDigest(digest);
      const row = database
        .prepare(
          'SELECT receipt_json FROM managed_dependency_environment_receipts WHERE environment_digest = ?',
        )
        .get(digest) as { receipt_json?: unknown } | undefined;
      if (!row) return undefined;
      if (typeof row.receipt_json !== 'string') {
        throw new Error('Managed dependency receipt authority contains an invalid row');
      }
      return decodeReceipt(JSON.parse(row.receipt_json));
    },
    list() {
      assertOpen();
      return Object.freeze(
        (
          database
            .prepare(
              'SELECT environment_digest, receipt_json FROM managed_dependency_environment_receipts ORDER BY environment_digest',
            )
            .all() as Array<{
            environment_digest?: unknown;
            receipt_json?: unknown;
          }>
        ).map((row) => {
          if (typeof row.environment_digest !== 'string' || typeof row.receipt_json !== 'string') {
            throw new Error('Managed dependency receipt authority contains an invalid row');
          }
          const receipt = decodeReceipt(JSON.parse(row.receipt_json));
          if (receipt.environmentId !== `sha256:${row.environment_digest}`) {
            throw new Error('Managed dependency receipt row does not match its payload identity');
          }
          return receipt;
        }),
      );
    },
    write(receipt: ManagedDependencyEnvironmentReceiptV1) {
      assertOpen();
      const digest = receipt.environmentId.slice('sha256:'.length);
      requireDigest(digest);
      database.exec('BEGIN IMMEDIATE');
      try {
        database
          .prepare(
            'INSERT INTO managed_dependency_environment_receipts (environment_digest, receipt_json) VALUES (?, ?)',
          )
          .run(digest, JSON.stringify(receipt));
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    delete(digest: string) {
      assertOpen();
      requireDigest(digest);
      database
        .prepare('DELETE FROM managed_dependency_environment_receipts WHERE environment_digest = ?')
        .run(digest);
    },
    close() {
      if (closed) return;
      closed = true;
      database.close();
    },
  });
}

function requireDigest(value: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error('Managed dependency receipt digest is invalid');
  }
}

export function computeManagedDependencyEnvironmentIdentity(
  input: ComputeManagedDependencyEnvironmentIdentityInput,
): ManagedDependencyEnvironmentIdentityV1 {
  const manifestPath = normalizeTrackedPath(input.manifestPath, 'manifestPath');
  const lockfilePath = normalizeTrackedPath(input.lockfilePath, 'lockfilePath');
  const manifestSha256 = sha256(input.manifestBytes);
  const lockfileSha256 = sha256(input.lockfileBytes);
  assertIdentityText(input.packageManagerVersion, 'packageManagerVersion');
  assertIdentityText(input.nodeVersion, 'nodeVersion');
  assertIdentityText(input.nodeAbi, 'nodeAbi');
  assertIdentityText(input.platform, 'platform');
  assertIdentityText(input.arch, 'arch');
  assertSha256(input.producerRuntimeIdentitySha256, 'producerRuntimeIdentitySha256');
  assertSha256(input.producerPolicyIdentitySha256, 'producerPolicyIdentitySha256');

  const canonicalIdentity = JSON.stringify({
    manifestPath,
    manifestSha256,
    lockfilePath,
    lockfileSha256,
    packageManagerName: input.packageManagerName,
    packageManagerVersion: input.packageManagerVersion,
    nodeVersion: input.nodeVersion,
    nodeAbi: input.nodeAbi,
    platform: input.platform,
    arch: input.arch,
    producerRuntimeIdentitySha256: input.producerRuntimeIdentitySha256,
    producerPolicyIdentitySha256: input.producerPolicyIdentitySha256,
    policyVersion: input.policyVersion,
  });
  const environmentId = sha256(
    Buffer.concat([
      Buffer.from(MANAGED_DEPENDENCY_IDENTITY_DOMAIN, 'utf8'),
      Buffer.from(canonicalIdentity, 'utf8'),
    ]),
  );

  return Object.freeze({
    protocolVersion: 1,
    environmentId,
    manifestPath,
    manifestSha256,
    lockfilePath,
    lockfileSha256,
    packageManagerName: input.packageManagerName,
    packageManagerVersion: input.packageManagerVersion,
    nodeVersion: input.nodeVersion,
    nodeAbi: input.nodeAbi,
    platform: input.platform,
    arch: input.arch,
    producerRuntimeIdentitySha256: input.producerRuntimeIdentitySha256,
    producerPolicyIdentitySha256: input.producerPolicyIdentitySha256,
    policyVersion: input.policyVersion,
  });
}

export async function createManagedDependencyEnvironmentAuthority(
  input: CreateManagedDependencyEnvironmentAuthorityInput,
): Promise<ManagedDependencyEnvironmentAuthority> {
  assertProducerCapability(input.producer.capability);
  const canonicalStorageRoot = await realpath(input.storageRoot).catch(async () => {
    await mkdir(input.storageRoot, { recursive: true });
    return await realpath(input.storageRoot);
  });
  const ownerKey = canonicalAuthorityOwnerKey(canonicalStorageRoot);
  if (activeAuthorityOwners.has(ownerKey)) {
    throw new Error('Managed dependency storage root already has an active owner');
  }
  const ownerClaim = {};
  activeAuthorityOwners.set(ownerKey, ownerClaim);
  let ownerLock: DependencyAuthorityOwnerLock | undefined;
  try {
    const managedWorkspacesRoot = await ensureOwnedDirectory(
      join(canonicalStorageRoot, 'managed-workspaces'),
      canonicalStorageRoot,
    );
    ownerLock = await acquireDependencyAuthorityOwnerLock(managedWorkspacesRoot);
    return await createManagedDependencyEnvironmentAuthorityForOwner(
      input,
      canonicalStorageRoot,
      ownerKey,
      ownerClaim,
      ownerLock,
    );
  } catch (error) {
    try {
      await ownerLock?.release();
    } finally {
      if (activeAuthorityOwners.get(ownerKey) === ownerClaim) {
        activeAuthorityOwners.delete(ownerKey);
      }
    }
    throw error;
  }
}

async function createManagedDependencyEnvironmentAuthorityForOwner(
  input: CreateManagedDependencyEnvironmentAuthorityInput,
  canonicalStorageRoot: string,
  ownerKey: string,
  ownerClaim: object,
  ownerLock: DependencyAuthorityOwnerLock,
): Promise<ManagedDependencyEnvironmentAuthority> {
  const environmentsRoot = join(
    canonicalStorageRoot,
    'managed-workspaces',
    'dependency-environments',
  );
  const authorityDatabasePath = join(
    canonicalStorageRoot,
    'managed-workspaces',
    AUTHORITY_DATABASE_NAME,
  );
  const stagingRoot = join(environmentsRoot, '.staging');
  const maxCacheBytes = input.maxCacheBytes ?? 2 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) {
    throw new TypeError('Managed dependency cache quota must be a non-negative safe integer');
  }
  await Promise.all([ensureOwnedDirectory(environmentsRoot, canonicalStorageRoot)]);
  await ensureOwnedDirectory(stagingRoot, environmentsRoot);
  await cleanupOrphanStaging(stagingRoot);
  const receiptAuthority = openDependencyReceiptAuthority(authorityDatabasePath);
  try {
    await cleanupIncompletePublications(environmentsRoot, receiptAuthority);
  } catch (error) {
    receiptAuthority.close();
    throw error;
  }
  const inflight = new Map<string, Promise<PublishedManagedDependencyEnvironment>>();
  const leaseCounts = new Map<string, number>();
  const pendingCounts = new Map<string, number>();
  let state: 'open' | 'draining' | 'closed' = 'open';
  let activeAcquisitions = 0;
  const acquisitionDrainWaiters = new Set<() => void>();
  let closeTask: Promise<void> | undefined;
  let gcTask = Promise.resolve();

  const beginAcquisition = () => {
    if (state !== 'open') {
      throw new Error(`Managed dependency environment authority is ${state}`);
    }
    activeAcquisitions += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      activeAcquisitions -= 1;
      if (activeAcquisitions !== 0) return;
      for (const resolveWaiter of acquisitionDrainWaiters) resolveWaiter();
      acquisitionDrainWaiters.clear();
    };
  };
  const waitForAcquisitions = () =>
    activeAcquisitions === 0
      ? Promise.resolve()
      : new Promise<void>((resolveWaiter) => acquisitionDrainWaiters.add(resolveWaiter));

  const authority: ManagedDependencyEnvironmentAuthority = {
    async acquire(identity, source) {
      const finishAcquisition = beginAcquisition();
      try {
        assertCanonicalIdentity(identity, source);
        if (
          identity.packageManagerName !== input.producer.packageManagerName ||
          identity.packageManagerVersion !== input.producer.packageManagerVersion ||
          identity.nodeVersion !== input.producer.nodeRuntime.version ||
          identity.nodeAbi !== input.producer.nodeRuntime.abi ||
          identity.platform !== input.producer.nodeRuntime.platform ||
          identity.arch !== input.producer.nodeRuntime.arch ||
          identity.producerRuntimeIdentitySha256 !==
            input.producer.capability.runtimeIdentitySha256 ||
          identity.producerPolicyIdentitySha256 !== input.producer.capability.policyIdentitySha256
        ) {
          throw new Error('Managed dependency producer does not match the requested identity');
        }
        assertSourceMatchesIdentity(identity, source);
        const digest = identity.environmentId.slice('sha256:'.length);
        pendingCounts.set(digest, (pendingCounts.get(digest) ?? 0) + 1);
        let artifact: PublishedManagedDependencyEnvironment;
        try {
          let task = inflight.get(digest);
          if (!task) {
            task = openOrPublishEnvironment({
              environmentsRoot,
              receiptAuthority,
              stagingRoot,
              identity,
              source,
              producer: input.producer,
              failpoint: input.failpoint,
            }).finally(() => inflight.delete(digest));
            inflight.set(digest, task);
          }
          artifact = await task;
          const now = new Date();
          await utimes(dirname(artifact.dependencyRoot), now, now);
          await input.failpoint?.('before_environment_lease');
          leaseCounts.set(digest, (leaseCounts.get(digest) ?? 0) + 1);
        } finally {
          decrementCount(pendingCounts, digest);
        }
        let released = false;
        return Object.freeze({
          environmentId: identity.environmentId,
          dependencyRoot: artifact.dependencyRoot,
          async release() {
            if (released) return;
            released = true;
            const remaining = (leaseCounts.get(digest) ?? 1) - 1;
            if (remaining > 0) leaseCounts.set(digest, remaining);
            else leaseCounts.delete(digest);
            gcTask = gcTask
              .catch(() => undefined)
              .then(() =>
                collectEnvironmentGarbage({
                  environmentsRoot,
                  receiptAuthority,
                  maxCacheBytes,
                  leaseCounts,
                  pendingCounts,
                  protectedDigest: digest,
                }),
              );
            await gcTask;
          },
        });
      } finally {
        finishAcquisition();
      }
    },
    close() {
      if (state === 'closed') return Promise.resolve();
      if (closeTask) return closeTask;
      state = 'draining';
      closeTask = (async () => {
        await waitForAcquisitions();
        let gcError: unknown;
        try {
          await gcTask;
        } catch (error) {
          gcError = error;
        }
        if (leaseCounts.size > 0) {
          throw new Error('Managed dependency environment authority still has active leases');
        }
        receiptAuthority.close();
        state = 'closed';
        try {
          await ownerLock.release();
        } finally {
          if (activeAuthorityOwners.get(ownerKey) === ownerClaim) {
            activeAuthorityOwners.delete(ownerKey);
          }
        }
        if (gcError) throw gcError;
      })().catch((error: unknown) => {
        if (state === 'draining') state = 'open';
        closeTask = undefined;
        throw error;
      });
      return closeTask;
    },
  };
  return Object.freeze(authority);
}

function canonicalAuthorityOwnerKey(canonicalStorageRoot: string): string {
  const normalized = normalize(canonicalStorageRoot);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function acquireDependencyAuthorityOwnerLock(
  managedWorkspacesRoot: string,
): Promise<DependencyAuthorityOwnerLock> {
  const lockPath = join(managedWorkspacesRoot, 'dependency-environment-authority-v1.lock');
  const handle = await open(lockPath, 'a+', 0o600);
  let locked = false;
  try {
    const [opened, current] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(lockPath, { bigint: true }),
    ]);
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    ) {
      throw new Error('Managed dependency authority owner lock is not a stable file');
    }
    await handle.chmod(0o600);
    locked = tryLock(handle.fd);
    if (!locked) {
      throw new Error('Managed dependency storage root already has an active owner');
    }
  } catch (error) {
    if (locked) unlock(handle.fd);
    await handle.close();
    throw error;
  }

  let released = false;
  return Object.freeze({
    async release() {
      if (released) return;
      released = true;
      try {
        unlock(handle.fd);
      } finally {
        await handle.close();
      }
    },
  });
}

async function openOrPublishEnvironment(input: {
  readonly environmentsRoot: string;
  readonly receiptAuthority: DependencyReceiptAuthority;
  readonly stagingRoot: string;
  readonly identity: ManagedDependencyEnvironmentIdentityV1;
  readonly source: AcquireManagedDependencyEnvironmentInput;
  readonly producer: ManagedDependencyEnvironmentProducer;
  readonly failpoint?: (point: ManagedDependencyEnvironmentFailpoint) => void | Promise<void>;
}): Promise<PublishedManagedDependencyEnvironment> {
  const digest = input.identity.environmentId.slice('sha256:'.length);
  const artifactRoot = publicationPath(input.environmentsRoot, digest);
  const existing = await openPublishedEnvironment(
    artifactRoot,
    input.environmentsRoot,
    input.receiptAuthority,
    input.identity,
  );
  if (existing) return existing;

  const transactionRoot = join(input.stagingRoot, `${digest}-${randomUUID()}`);
  const producerRoot = join(transactionRoot, 'producer');
  const projectRoot = join(producerRoot, 'project');
  const producerOutputRoot = join(projectRoot, DEPENDENCY_ROOT_NAME);
  const scratchRoot = join(projectRoot, '.maka-runtime');
  const artifactStagingRoot = join(transactionRoot, 'artifact');
  const dependencyRoot = join(artifactStagingRoot, DEPENDENCY_ROOT_NAME);
  await Promise.all([
    mkdir(producerOutputRoot, { recursive: true }),
    mkdir(scratchRoot, { recursive: true }),
    mkdir(artifactStagingRoot, { recursive: true }),
  ]);
  try {
    await input.producer.provision({
      identity: input.identity,
      outputRoot: producerOutputRoot,
      scratchRoot,
      manifestBytes: input.source.manifestBytes,
      lockfileBytes: input.source.lockfileBytes,
      ...(input.source.abortSignal ? { abortSignal: input.source.abortSignal } : {}),
    });
    const canonicalOutput = await realpath(producerOutputRoot);
    if (!isPathWithin(canonicalOutput, producerRoot)) {
      throw new Error('Managed dependency producer output escapes its staging authority');
    }
    await cp(producerOutputRoot, dependencyRoot, {
      recursive: true,
      dereference: false,
      errorOnExist: true,
      force: false,
      verbatimSymlinks: true,
    });
    await rm(producerRoot, { recursive: true, force: true });
    const content = await hashDependencyTree(dependencyRoot, { durable: true });
    const receipt: ManagedDependencyEnvironmentReceiptV1 = Object.freeze({
      ...input.identity,
      dependencyRootName: DEPENDENCY_ROOT_NAME,
      contentTreeSha256: content.sha256,
      contentBytes: content.bytes,
      contentEntries: content.entries,
    });
    await syncDirectory(artifactStagingRoot);
    await input.failpoint?.('after_environment_tree_durable');
    await rename(artifactStagingRoot, artifactRoot);
    await syncDirectory(input.environmentsRoot);
    await input.failpoint?.('after_environment_publish');
    input.receiptAuthority.write(receipt);
    await input.failpoint?.('after_environment_receipt_durable');
    await rm(transactionRoot, { recursive: true, force: true });
    return await requirePublishedEnvironment(
      artifactRoot,
      input.environmentsRoot,
      input.receiptAuthority,
      input.identity,
    );
  } catch (error) {
    await rm(transactionRoot, { recursive: true, force: true }).catch(() => undefined);
    const raced = await openPublishedEnvironment(
      artifactRoot,
      input.environmentsRoot,
      input.receiptAuthority,
      input.identity,
    );
    if (raced) return raced;
    const receiptExists = input.receiptAuthority.read(digest) !== undefined;
    if (!receiptExists) {
      await rm(artifactRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function cleanupOrphanStaging(stagingRoot: string): Promise<void> {
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(stagingRoot, entry.name);
    const info = await lstat(path);
    if (!entry.isDirectory() || info.isSymbolicLink()) {
      throw new Error('Managed dependency staging contains an unowned entry');
    }
    await rm(path, { recursive: true, force: true });
  }
}

async function ensureOwnedDirectory(path: string, parentRoot: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Managed dependency authority path is not an owned directory');
  }
  const canonical = normalize(await realpath(path));
  const canonicalParent = normalize(await realpath(parentRoot));
  if (!isPathWithin(canonical, canonicalParent)) {
    throw new Error('Managed dependency authority path escapes its storage root');
  }
  return canonical;
}

async function cleanupIncompletePublications(
  environmentsRoot: string,
  receiptAuthority: DependencyReceiptAuthority,
): Promise<void> {
  const receipts = new Set<string>();
  for (const receipt of receiptAuthority.list()) {
    const digest = receipt.environmentId.slice('sha256:'.length);
    if (receipt.environmentId !== `sha256:${digest}`) {
      throw new Error('Managed dependency authority receipt has the wrong identity');
    }
    receipts.add(digest);
  }
  const artifacts = new Set<string>();
  for (const entry of await readdir(environmentsRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === '.staging') continue;
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
      throw new Error('Managed dependency cache contains an unowned entry');
    }
    const info = await lstat(join(environmentsRoot, entry.name));
    if (info.isSymbolicLink()) {
      throw new Error('Managed dependency cache contains a reparse point');
    }
    artifacts.add(entry.name);
  }
  for (const digest of artifacts) {
    if (!receipts.has(digest)) {
      await rm(join(environmentsRoot, digest), {
        recursive: true,
        force: true,
      });
    }
  }
  for (const digest of receipts) {
    if (!artifacts.has(digest)) {
      receiptAuthority.delete(digest);
    }
  }
}

function publicationPath(environmentsRoot: string, digest: string) {
  if (!/^[0-9a-f]{64}$/u.test(digest)) {
    throw new Error('Managed dependency environment identity is not a canonical SHA-256 digest');
  }
  const artifactRoot = join(environmentsRoot, digest);
  if (!isPathWithin(artifactRoot, environmentsRoot)) {
    throw new Error('Managed dependency publication path escapes its authority root');
  }
  return artifactRoot;
}

async function openPublishedEnvironment(
  artifactRoot: string,
  environmentsRoot: string,
  receiptAuthority: DependencyReceiptAuthority,
  identity: ManagedDependencyEnvironmentIdentityV1,
): Promise<PublishedManagedDependencyEnvironment | undefined> {
  try {
    return await requirePublishedEnvironment(
      artifactRoot,
      environmentsRoot,
      receiptAuthority,
      identity,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requirePublishedEnvironment(
  artifactRoot: string,
  environmentsRoot: string,
  receiptAuthority: DependencyReceiptAuthority,
  identity: ManagedDependencyEnvironmentIdentityV1,
): Promise<PublishedManagedDependencyEnvironment> {
  const artifactInfo = await lstat(artifactRoot);
  if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) {
    throw new Error('Managed dependency environment artifact root is not an owned directory');
  }
  const canonicalArtifactRoot = normalize(await realpath(artifactRoot));
  if (!isPathWithin(canonicalArtifactRoot, environmentsRoot)) {
    throw new Error('Managed dependency environment artifact escapes its authority root');
  }
  const artifactEntries = await readdir(artifactRoot);
  if (artifactEntries.length !== 1 || artifactEntries[0] !== DEPENDENCY_ROOT_NAME) {
    throw new Error('Managed dependency environment artifact contains an unowned entry');
  }
  const receipt = receiptAuthority.read(identity.environmentId.slice('sha256:'.length));
  if (!receipt)
    throw Object.assign(new Error('Managed dependency receipt is unavailable'), { code: 'ENOENT' });
  if (!sameIdentity(receipt, identity)) {
    throw new Error('Managed dependency environment receipt identity does not match the request');
  }
  const dependencyRoot = join(artifactRoot, receipt.dependencyRootName);
  const dependencyInfo = await lstat(dependencyRoot);
  if (!dependencyInfo.isDirectory() || dependencyInfo.isSymbolicLink()) {
    throw new Error('Managed dependency environment content root is unavailable');
  }
  const content = await hashDependencyTree(dependencyRoot);
  if (
    content.sha256 !== receipt.contentTreeSha256 ||
    content.bytes !== receipt.contentBytes ||
    content.entries !== receipt.contentEntries
  ) {
    throw new Error('Managed dependency environment content does not match its receipt');
  }
  return Object.freeze({
    receipt,
    dependencyRoot: await realpath(dependencyRoot),
  });
}

function assertSourceMatchesIdentity(
  identity: ManagedDependencyEnvironmentIdentityV1,
  input: AcquireManagedDependencyEnvironmentInput,
): void {
  if (
    sha256(input.manifestBytes) !== identity.manifestSha256 ||
    sha256(input.lockfileBytes) !== identity.lockfileSha256
  ) {
    throw new Error('Managed dependency source bytes do not match the requested identity');
  }
}

function assertCanonicalIdentity(
  identity: ManagedDependencyEnvironmentIdentityV1,
  source: AcquireManagedDependencyEnvironmentInput,
): void {
  const expected = computeManagedDependencyEnvironmentIdentity({
    manifestPath: identity.manifestPath,
    manifestBytes: source.manifestBytes,
    lockfilePath: identity.lockfilePath,
    lockfileBytes: source.lockfileBytes,
    packageManagerName: identity.packageManagerName,
    packageManagerVersion: identity.packageManagerVersion,
    nodeVersion: identity.nodeVersion,
    nodeAbi: identity.nodeAbi,
    platform: identity.platform,
    arch: identity.arch,
    producerRuntimeIdentitySha256: identity.producerRuntimeIdentitySha256,
    producerPolicyIdentitySha256: identity.producerPolicyIdentitySha256,
    policyVersion: identity.policyVersion,
  });
  if (!sameEnvironmentIdentity(expected, identity)) {
    throw new Error('Managed dependency environment identity is not canonical');
  }
}

async function hashDependencyTree(
  root: string,
  options: { readonly durable?: boolean } = {},
): Promise<{
  readonly sha256: `sha256:${string}`;
  readonly bytes: number;
  readonly entries: number;
}> {
  const hash = createHash('sha256');
  const counter = { bytes: 0, entries: 0 };
  hash.update(MANAGED_DEPENDENCY_TREE_DOMAIN);
  await hashDirectory(root, '', hash, counter, options.durable === true);
  if (process.platform === 'win32') await assertNoWindowsAlternateStreams(root);
  return Object.freeze({
    sha256: `sha256:${hash.digest('hex')}`,
    bytes: counter.bytes,
    entries: counter.entries,
  });
}

async function hashDirectory(
  root: string,
  relativeRoot: string,
  hash: ReturnType<typeof createHash>,
  counter: { bytes: number; entries: number },
  durable: boolean,
) {
  const directory = relativeRoot ? join(root, relativeRoot) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    if (entry.name.includes(':') || entry.name.includes('\0')) {
      throw new Error('Managed dependency environment contains a non-portable path');
    }
    counter.entries += 1;
    const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    const portablePath = relativePath.replaceAll('\\', '/');
    const absolutePath = join(root, relativePath);
    const info = await lstat(absolutePath);
    const mode = process.platform === 'win32' ? 0 : info.mode & 0o777;
    if (entry.isDirectory()) {
      hash.update(`d\0${portablePath}\0${mode}\0`);
      await hashDirectory(root, relativePath, hash, counter, durable);
      continue;
    }
    if (entry.isFile()) {
      hash.update(`f\0${portablePath}\0${mode}\0${info.size}\0`);
      counter.bytes += info.size;
      for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
      hash.update('\0');
      if (durable) await syncRegularFile(absolutePath, info.mode);
      continue;
    }
    if (entry.isSymbolicLink()) {
      if (process.platform === 'win32') {
        throw new Error('Managed dependency environment contains a Windows reparse point');
      }
      const target = await readlink(absolutePath);
      if (isAbsolute(target) || !isPathWithin(resolve(dirname(absolutePath), target), root)) {
        throw new Error('Managed dependency environment contains an escaping symbolic link');
      }
      hash.update(`l\0${portablePath}\0${target.replaceAll('\\', '/')}\0`);
      continue;
    }
    throw new Error('Managed dependency environment contains an unsupported filesystem entry');
  }
  if (durable) await syncDirectory(directory);
}

/**
 * Reject NTFS alternate data streams under a dependency tree.
 *
 * Previously this shellled out to a recursive PowerShell `Get-ChildItem -Recurse`
 * + `Get-Item -Stream *` walk. On GitHub-hosted Windows runners that path
 * routinely hung until the 30s `execFile` timeout, which misreported every
 * timeout as "contains an alternate data stream" and burned ~5 minutes across
 * managed-dependency crash recovery tests. Walk the tree in Node (no reparse
 * follow) and query streams per file with `fsutil`, which is bounded and
 * does not recurse through junctions.
 */
async function assertNoWindowsAlternateStreams(root: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    throw new Error('Cannot verify Windows alternate streams without SystemRoot');
  }
  const fsutil = join(systemRoot, 'System32', 'fsutil.exe');
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      // Dirent for a reparse point reports as directory/file without following.
      // Do not recurse into reparse points; hashDirectory already rejects them
      // on win32, and following junctions can hang or leave the tree.
      if (entry.isSymbolicLink()) {
        throw new Error('Managed dependency environment contains a Windows reparse point');
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      await assertWindowsFileHasOnlyDefaultStream(fsutil, absolutePath);
    }
  }
}

async function assertWindowsFileHasOnlyDefaultStream(
  fsutil: string,
  filePath: string,
): Promise<void> {
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      fsutil,
      ['file', 'queryStreams', filePath],
      {
        windowsHide: true,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error, out) => {
        if (error) {
          const execError = error as Error & { killed?: boolean; code?: string | number | null };
          const timedOut =
            execError.killed === true ||
            execError.code === 'ETIMEDOUT' ||
            /ETIMEDOUT|timeout/i.test(execError.message);
          rejectPromise(
            new Error(
              timedOut
                ? `Timed out querying alternate data streams for ${filePath}`
                : `Unable to query alternate data streams for ${filePath}`,
              { cause: error },
            ),
          );
          return;
        }
        resolvePromise(typeof out === 'string' ? out : String(out ?? ''));
      },
    );
  });
  for (const rawLine of stdout.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    // Verbose form: "Name         : :$DATA" or "Name : :unhashed:$DATA"
    const nameMatch = /^Name\s*:\s*(.+)$/iu.exec(line);
    if (nameMatch) {
      if (isDefaultWindowsDataStreamName(nameMatch[1]!.trim())) continue;
      throw new Error('Managed dependency environment contains an alternate data stream');
    }
    // Compact form used by some fsutil builds: ":$DATA" / "Zone.Identifier:$DATA"
    if (/:\$DATA\b/iu.test(line) && !isDefaultWindowsDataStreamName(line.split(/\s+/u)[0]!)) {
      throw new Error('Managed dependency environment contains an alternate data stream');
    }
  }
}

function isDefaultWindowsDataStreamName(name: string): boolean {
  return name === ':$DATA' || name === '::$DATA';
}

function isPathWithin(candidate: string, root: string): boolean {
  const path = relative(normalize(root), normalize(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function decodeReceipt(value: unknown): ManagedDependencyEnvironmentReceiptV1 {
  if (!value || typeof value !== 'object') throw new Error('Invalid dependency receipt');
  const receipt = value as Partial<ManagedDependencyEnvironmentReceiptV1>;
  const keys = Object.keys(value).sort();
  const expectedKeys = [...RECEIPT_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index]) ||
    receipt.protocolVersion !== 1 ||
    receipt.dependencyRootName !== DEPENDENCY_ROOT_NAME ||
    typeof receipt.environmentId !== 'string' ||
    !SHA256_PATTERN.test(receipt.environmentId) ||
    typeof receipt.contentTreeSha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.contentTreeSha256) ||
    typeof receipt.contentBytes !== 'number' ||
    !Number.isSafeInteger(receipt.contentBytes) ||
    receipt.contentBytes < 0 ||
    typeof receipt.contentEntries !== 'number' ||
    !Number.isSafeInteger(receipt.contentEntries) ||
    receipt.contentEntries < 0 ||
    typeof receipt.manifestSha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.manifestSha256) ||
    typeof receipt.lockfileSha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.lockfileSha256) ||
    typeof receipt.manifestPath !== 'string' ||
    typeof receipt.lockfilePath !== 'string' ||
    (receipt.packageManagerName !== 'npm' &&
      receipt.packageManagerName !== 'pnpm' &&
      receipt.packageManagerName !== 'yarn') ||
    typeof receipt.packageManagerVersion !== 'string' ||
    typeof receipt.nodeVersion !== 'string' ||
    typeof receipt.nodeAbi !== 'string' ||
    typeof receipt.platform !== 'string' ||
    typeof receipt.arch !== 'string' ||
    typeof receipt.producerRuntimeIdentitySha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.producerRuntimeIdentitySha256) ||
    typeof receipt.producerPolicyIdentitySha256 !== 'string' ||
    !SHA256_PATTERN.test(receipt.producerPolicyIdentitySha256) ||
    receipt.policyVersion !== 'managed_dependency_environment_v1'
  ) {
    throw new Error('Invalid dependency receipt');
  }
  return Object.freeze(receipt as ManagedDependencyEnvironmentReceiptV1);
}

async function collectEnvironmentGarbage(input: {
  readonly environmentsRoot: string;
  readonly receiptAuthority: DependencyReceiptAuthority;
  readonly maxCacheBytes: number;
  readonly leaseCounts: ReadonlyMap<string, number>;
  readonly pendingCounts: ReadonlyMap<string, number>;
  readonly protectedDigest: string;
}): Promise<void> {
  const artifacts: Array<{
    readonly digest: string;
    readonly root: string;
    readonly bytes: number;
    readonly lastUsedMs: number;
  }> = [];
  for (const entry of await readdir(input.environmentsRoot, {
    withFileTypes: true,
  })) {
    if (entry.name === '.staging') continue;
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
      throw new Error('Managed dependency cache contains an unowned entry');
    }
    const root = join(input.environmentsRoot, entry.name);
    const receipt = input.receiptAuthority.read(entry.name);
    if (!receipt) throw new Error('Managed dependency cache is missing its authority receipt');
    if (receipt.environmentId !== `sha256:${entry.name}`) {
      throw new Error('Managed dependency cache directory does not match its receipt');
    }
    artifacts.push({
      digest: entry.name,
      root,
      // Empty files and directories consume filesystem metadata even when
      // contentBytes is zero. Charge one conservative 4 KiB unit per entry so
      // inode-only trees cannot bypass the cache quota.
      bytes: receipt.contentBytes + receipt.contentEntries * 4_096,
      lastUsedMs: (await stat(root)).mtimeMs,
    });
  }
  let totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  artifacts.sort(
    (left, right) => left.lastUsedMs - right.lastUsedMs || left.digest.localeCompare(right.digest),
  );
  for (const artifact of artifacts) {
    if (totalBytes <= input.maxCacheBytes) break;
    if (
      artifact.digest === input.protectedDigest ||
      input.leaseCounts.has(artifact.digest) ||
      input.pendingCounts.has(artifact.digest)
    )
      continue;
    await rm(artifact.root, { recursive: true, force: true });
    input.receiptAuthority.delete(artifact.digest);
    totalBytes -= artifact.bytes;
  }
}

function sameIdentity(
  receipt: ManagedDependencyEnvironmentReceiptV1,
  identity: ManagedDependencyEnvironmentIdentityV1,
): boolean {
  return (
    receipt.environmentId === identity.environmentId &&
    receipt.manifestPath === identity.manifestPath &&
    receipt.manifestSha256 === identity.manifestSha256 &&
    receipt.lockfilePath === identity.lockfilePath &&
    receipt.lockfileSha256 === identity.lockfileSha256 &&
    receipt.packageManagerName === identity.packageManagerName &&
    receipt.packageManagerVersion === identity.packageManagerVersion &&
    receipt.nodeVersion === identity.nodeVersion &&
    receipt.nodeAbi === identity.nodeAbi &&
    receipt.platform === identity.platform &&
    receipt.arch === identity.arch &&
    receipt.producerRuntimeIdentitySha256 === identity.producerRuntimeIdentitySha256 &&
    receipt.producerPolicyIdentitySha256 === identity.producerPolicyIdentitySha256 &&
    receipt.policyVersion === identity.policyVersion
  );
}

function sameEnvironmentIdentity(
  left: ManagedDependencyEnvironmentIdentityV1,
  right: ManagedDependencyEnvironmentIdentityV1,
): boolean {
  return (
    left.protocolVersion === right.protocolVersion &&
    left.environmentId === right.environmentId &&
    left.manifestPath === right.manifestPath &&
    left.manifestSha256 === right.manifestSha256 &&
    left.lockfilePath === right.lockfilePath &&
    left.lockfileSha256 === right.lockfileSha256 &&
    left.packageManagerName === right.packageManagerName &&
    left.packageManagerVersion === right.packageManagerVersion &&
    left.nodeVersion === right.nodeVersion &&
    left.nodeAbi === right.nodeAbi &&
    left.platform === right.platform &&
    left.arch === right.arch &&
    left.producerRuntimeIdentitySha256 === right.producerRuntimeIdentitySha256 &&
    left.producerPolicyIdentitySha256 === right.producerPolicyIdentitySha256 &&
    left.policyVersion === right.policyVersion
  );
}

function decrementCount(counts: Map<string, number>, key: string): void {
  const remaining = (counts.get(key) ?? 1) - 1;
  if (remaining > 0) counts.set(key, remaining);
  else counts.delete(key);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle.close();
  }
}

async function syncRegularFile(path: string, mode: number): Promise<void> {
  if (process.platform !== 'win32') {
    await syncOpenedFile(path, 'r');
    return;
  }

  const originalMode = mode & 0o777;
  const writableMode = originalMode | 0o200;
  if (writableMode !== originalMode) await chmod(path, writableMode);
  try {
    await syncOpenedFile(path, 'r+');
  } finally {
    if (writableMode !== originalMode) await chmod(path, originalMode);
  }
}

async function syncOpenedFile(path: string, flags: 'r' | 'r+'): Promise<void> {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sha256(value: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizeTrackedPath(value: string, field: string): string {
  assertIdentityText(value, field);
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  if (
    normalized === '.' ||
    normalized.startsWith('/') ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    throw new TypeError(`${field} must be a workspace-relative tracked path`);
  }
  return normalized;
}

function assertIdentityText(value: string, field: string): void {
  if (!value || value.includes('\0')) {
    throw new TypeError(`${field} must be non-empty text without NUL bytes`);
  }
}

function assertSha256(value: string, field: string): void {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`);
  }
}

function managedDependencyProducerPolicyIdentity(): `sha256:${string}` {
  return sha256(
    Buffer.concat([
      Buffer.from(MANAGED_DEPENDENCY_PRODUCER_POLICY_DOMAIN, 'utf8'),
      Buffer.from(JSON.stringify(MANAGED_DEPENDENCY_PRODUCER_POLICY_V1), 'utf8'),
    ]),
  );
}

function assertProducerCapability(
  capability: ManagedDependencyEnvironmentProducerCapabilityV1,
): void {
  const expected = createManagedDependencyEnvironmentProducerCapability(
    capability.runtimeIdentitySha256,
  );
  if (
    Object.keys(capability).sort().join('\0') !== Object.keys(expected).sort().join('\0') ||
    Object.entries(expected).some(
      ([key, value]) =>
        capability[key as keyof ManagedDependencyEnvironmentProducerCapabilityV1] !== value,
    )
  ) {
    throw new Error('Managed dependency producer capability is invalid');
  }
}
