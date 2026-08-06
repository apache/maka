import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
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
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, posix, relative, resolve } from 'node:path';

const MANAGED_DEPENDENCY_IDENTITY_DOMAIN = 'maka.managed_dependency_environment.v1\0';
const MANAGED_DEPENDENCY_TREE_DOMAIN = 'maka.managed_dependency_environment.tree.v1\0';
const RECEIPT_FILE = 'environment-receipt.json';
const DEPENDENCY_ROOT_NAME = 'node_modules';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
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
  'policyVersion',
  'dependencyRootName',
  'contentTreeSha256',
  'contentBytes',
] as const;

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
  readonly policyVersion: 'managed_dependency_environment_v1';
}

export interface ManagedDependencyEnvironmentProducerInput {
  readonly identity: ManagedDependencyEnvironmentIdentityV1;
  readonly outputRoot: string;
  readonly manifestBytes: Uint8Array;
  readonly lockfileBytes: Uint8Array;
}

export interface ManagedDependencyEnvironmentProducer {
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

export interface CreateManagedDependencyEnvironmentAuthorityInput {
  readonly storageRoot: string;
  readonly producer: ManagedDependencyEnvironmentProducer;
  readonly maxCacheBytes?: number;
  readonly failpoint?: (point: ManagedDependencyEnvironmentFailpoint) => void | Promise<void>;
}

export type ManagedDependencyEnvironmentFailpoint =
  | 'after_environment_receipt_durable'
  | 'after_environment_publish';

export interface AcquireManagedDependencyEnvironmentInput {
  readonly manifestBytes: Uint8Array;
  readonly lockfileBytes: Uint8Array;
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
}

interface PublishedManagedDependencyEnvironment {
  readonly receipt: ManagedDependencyEnvironmentReceiptV1;
  readonly dependencyRoot: string;
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
    policyVersion: input.policyVersion,
  });
}

export async function createManagedDependencyEnvironmentAuthority(
  input: CreateManagedDependencyEnvironmentAuthorityInput,
): Promise<ManagedDependencyEnvironmentAuthority> {
  const canonicalStorageRoot = await realpath(input.storageRoot).catch(async () => {
    await mkdir(input.storageRoot, { recursive: true });
    return await realpath(input.storageRoot);
  });
  const environmentsRoot = join(
    canonicalStorageRoot,
    'managed-workspaces',
    'dependency-environments',
  );
  const stagingRoot = join(environmentsRoot, '.staging');
  const maxCacheBytes = input.maxCacheBytes ?? 2 * 1024 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < 0) {
    throw new TypeError('Managed dependency cache quota must be a non-negative safe integer');
  }
  await mkdir(stagingRoot, { recursive: true });
  await cleanupOrphanStaging(stagingRoot);
  const inflight = new Map<string, Promise<PublishedManagedDependencyEnvironment>>();
  const leaseCounts = new Map<string, number>();
  let closed = false;
  let gcTask = Promise.resolve();

  const authority: ManagedDependencyEnvironmentAuthority = {
    async acquire(identity, source) {
      if (closed) throw new Error('Managed dependency environment authority is closed');
      if (
        identity.packageManagerName !== input.producer.packageManagerName ||
        identity.packageManagerVersion !== input.producer.packageManagerVersion ||
        identity.nodeVersion !== input.producer.nodeRuntime.version ||
        identity.nodeAbi !== input.producer.nodeRuntime.abi ||
        identity.platform !== input.producer.nodeRuntime.platform ||
        identity.arch !== input.producer.nodeRuntime.arch
      ) {
        throw new Error('Managed dependency producer does not match the requested identity');
      }
      assertSourceMatchesIdentity(identity, source);
      const digest = identity.environmentId.slice('sha256:'.length);
      let task = inflight.get(digest);
      if (!task) {
        task = openOrPublishEnvironment({
          environmentsRoot,
          stagingRoot,
          identity,
          source,
          producer: input.producer,
          failpoint: input.failpoint,
        }).finally(() => inflight.delete(digest));
        inflight.set(digest, task);
      }
      const artifact = await task;
      const now = new Date();
      await utimes(dirname(artifact.dependencyRoot), now, now);
      leaseCounts.set(digest, (leaseCounts.get(digest) ?? 0) + 1);
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
          gcTask = gcTask.then(() =>
            collectEnvironmentGarbage({
              environmentsRoot,
              maxCacheBytes,
              leaseCounts,
              protectedDigest: digest,
            }),
          );
          await gcTask;
        },
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(inflight.values());
      await gcTask;
      if (leaseCounts.size > 0) {
        closed = false;
        throw new Error('Managed dependency environment authority still has active leases');
      }
    },
  };
  return Object.freeze(authority);
}

async function openOrPublishEnvironment(input: {
  readonly environmentsRoot: string;
  readonly stagingRoot: string;
  readonly identity: ManagedDependencyEnvironmentIdentityV1;
  readonly source: AcquireManagedDependencyEnvironmentInput;
  readonly producer: ManagedDependencyEnvironmentProducer;
  readonly failpoint?: (point: ManagedDependencyEnvironmentFailpoint) => void | Promise<void>;
}): Promise<PublishedManagedDependencyEnvironment> {
  const digest = input.identity.environmentId.slice('sha256:'.length);
  const artifactRoot = join(input.environmentsRoot, digest);
  const existing = await openPublishedEnvironment(artifactRoot, input.identity);
  if (existing) return existing;

  const staging = join(input.stagingRoot, `${digest}-${randomUUID()}`);
  const dependencyRoot = join(staging, DEPENDENCY_ROOT_NAME);
  await mkdir(dependencyRoot, { recursive: true });
  try {
    await input.producer.provision({
      identity: input.identity,
      outputRoot: dependencyRoot,
      manifestBytes: input.source.manifestBytes,
      lockfileBytes: input.source.lockfileBytes,
    });
    const content = await hashDependencyTree(dependencyRoot);
    const receipt: ManagedDependencyEnvironmentReceiptV1 = Object.freeze({
      ...input.identity,
      dependencyRootName: DEPENDENCY_ROOT_NAME,
      contentTreeSha256: content.sha256,
      contentBytes: content.bytes,
    });
    await writeFile(join(staging, RECEIPT_FILE), `${JSON.stringify(receipt)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    });
    await syncFile(join(staging, RECEIPT_FILE));
    await syncDirectory(staging);
    await input.failpoint?.('after_environment_receipt_durable');
    await rename(staging, artifactRoot);
    await syncDirectory(input.environmentsRoot);
    await input.failpoint?.('after_environment_publish');
    return await requirePublishedEnvironment(artifactRoot, input.identity);
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    const raced = await openPublishedEnvironment(artifactRoot, input.identity);
    if (raced) return raced;
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

async function openPublishedEnvironment(
  artifactRoot: string,
  identity: ManagedDependencyEnvironmentIdentityV1,
): Promise<PublishedManagedDependencyEnvironment | undefined> {
  try {
    return await requirePublishedEnvironment(artifactRoot, identity);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function requirePublishedEnvironment(
  artifactRoot: string,
  identity: ManagedDependencyEnvironmentIdentityV1,
): Promise<PublishedManagedDependencyEnvironment> {
  const artifactInfo = await lstat(artifactRoot);
  if (!artifactInfo.isDirectory() || artifactInfo.isSymbolicLink()) {
    throw new Error('Managed dependency environment artifact root is not an owned directory');
  }
  const raw = await readFile(join(artifactRoot, RECEIPT_FILE), 'utf8');
  const receipt = decodeReceipt(JSON.parse(raw));
  if (!sameIdentity(receipt, identity)) {
    throw new Error('Managed dependency environment receipt identity does not match the request');
  }
  const dependencyRoot = join(artifactRoot, receipt.dependencyRootName);
  const dependencyInfo = await lstat(dependencyRoot);
  if (!dependencyInfo.isDirectory() || dependencyInfo.isSymbolicLink()) {
    throw new Error('Managed dependency environment content root is unavailable');
  }
  const content = await hashDependencyTree(dependencyRoot);
  if (content.sha256 !== receipt.contentTreeSha256 || content.bytes !== receipt.contentBytes) {
    throw new Error('Managed dependency environment content does not match its receipt');
  }
  return Object.freeze({ receipt, dependencyRoot: await realpath(dependencyRoot) });
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

async function hashDependencyTree(
  root: string,
): Promise<{ readonly sha256: `sha256:${string}`; readonly bytes: number }> {
  const hash = createHash('sha256');
  const counter = { bytes: 0 };
  hash.update(MANAGED_DEPENDENCY_TREE_DOMAIN);
  await hashDirectory(root, '', hash, counter);
  return Object.freeze({ sha256: `sha256:${hash.digest('hex')}`, bytes: counter.bytes });
}

async function hashDirectory(
  root: string,
  relativeRoot: string,
  hash: ReturnType<typeof createHash>,
  counter: { bytes: number },
) {
  const directory = relativeRoot ? join(root, relativeRoot) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  for (const entry of entries) {
    const relativePath = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    const portablePath = relativePath.replaceAll('\\', '/');
    const absolutePath = join(root, relativePath);
    const info = await lstat(absolutePath);
    const mode = process.platform === 'win32' ? 0 : info.mode & 0o777;
    if (entry.isDirectory()) {
      hash.update(`d\0${portablePath}\0${mode}\0`);
      await hashDirectory(root, relativePath, hash, counter);
      continue;
    }
    if (entry.isFile()) {
      hash.update(`f\0${portablePath}\0${mode}\0${info.size}\0`);
      counter.bytes += info.size;
      for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
      hash.update('\0');
      continue;
    }
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolutePath);
      if (isAbsolute(target) || !isPathWithin(resolve(dirname(absolutePath), target), root)) {
        throw new Error('Managed dependency environment contains an escaping symbolic link');
      }
      hash.update(`l\0${portablePath}\0${target.replaceAll('\\', '/')}\0`);
      continue;
    }
    throw new Error('Managed dependency environment contains an unsupported filesystem entry');
  }
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
    receipt.policyVersion !== 'managed_dependency_environment_v1'
  ) {
    throw new Error('Invalid dependency receipt');
  }
  return Object.freeze(receipt as ManagedDependencyEnvironmentReceiptV1);
}

async function collectEnvironmentGarbage(input: {
  readonly environmentsRoot: string;
  readonly maxCacheBytes: number;
  readonly leaseCounts: ReadonlyMap<string, number>;
  readonly protectedDigest: string;
}): Promise<void> {
  const artifacts: Array<{
    readonly digest: string;
    readonly root: string;
    readonly bytes: number;
    readonly lastUsedMs: number;
  }> = [];
  for (const entry of await readdir(input.environmentsRoot, { withFileTypes: true })) {
    if (entry.name === '.staging') continue;
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) {
      throw new Error('Managed dependency cache contains an unowned entry');
    }
    const root = join(input.environmentsRoot, entry.name);
    const receipt = decodeReceipt(JSON.parse(await readFile(join(root, RECEIPT_FILE), 'utf8')));
    if (receipt.environmentId !== `sha256:${entry.name}`) {
      throw new Error('Managed dependency cache directory does not match its receipt');
    }
    artifacts.push({
      digest: entry.name,
      root,
      bytes: receipt.contentBytes,
      lastUsedMs: (await stat(root)).mtimeMs,
    });
  }
  let totalBytes = artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0);
  artifacts.sort(
    (left, right) => left.lastUsedMs - right.lastUsedMs || left.digest.localeCompare(right.digest),
  );
  for (const artifact of artifacts) {
    if (totalBytes <= input.maxCacheBytes) break;
    if (artifact.digest === input.protectedDigest || input.leaseCounts.has(artifact.digest))
      continue;
    await rm(artifact.root, { recursive: true, force: true });
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
    receipt.policyVersion === identity.policyVersion
  );
}

async function syncFile(path: string): Promise<void> {
  // Windows rejects fsync on a read-only file handle. The receipt was just
  // created by this owner, so reopen it read/write solely for durability.
  const handle = await open(path, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
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
