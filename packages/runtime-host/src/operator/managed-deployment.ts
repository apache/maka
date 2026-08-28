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

import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type StateRootOwner,
  type StorageRootCapability,
  assertStorageRootLease,
  resolveExistingStorageRoot,
  tryAcquireStateRootOwner,
} from '@maka/storage/root-authority';
import {
  readStableBoundedFile,
  syncDirectory,
  syncDirectoryChain,
} from '@maka/storage/stable-storage';
import { z } from 'zod';
import { isCanonicalRuntimeHostWebSocketPath } from '../protocol/websocket-path.js';
import {
  isProductReleaseVersion,
  isSha512PackageIntegrity,
  resolveRuntimeHostNpmDeploymentLayout,
} from './update-package-evidence.js';

export const RUNTIME_HOST_MANAGED_DEPLOYMENT_CONFIG_FILE = 'runtime-host-deployment.json';

const SCHEMA_VERSION = 1 as const;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const boundedText = (maximumBytes: number) =>
  z
    .string()
    .min(1)
    .refine(
      (value) =>
        Buffer.byteLength(value, 'utf8') <= maximumBytes && !/[\u0000-\u001f\u007f]/u.test(value),
    );

const absolutePathSchema = boundedText(4_096).refine(isAbsolute);
const deploymentIdSchema = z.string().regex(UUID_PATTERN);
const configRevisionSchema = z.number().int().positive().safe();
const providerSchema = z.enum(['systemd_user', 'launch_agent', 'openrc_user', 'openrc_system']);
const reconciliationProviderSchema = z.enum([
  'systemd_timer',
  'launch_agent_timer',
  'openrc_supervised_loop',
]);
const packageIdentitySchema = z
  .object({
    kind: z.literal('npm_registry'),
    version: z.string().refine(isProductReleaseVersion),
    integrity: z.string().refine(isSha512PackageIntegrity),
  })
  .strict();

const lifecycleSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('on_demand'),
      availability: z.literal('activation'),
    })
    .strict(),
  z
    .object({
      mode: z.literal('supervised'),
      provider: providerSchema,
      availability: z.enum(['session', 'environment', 'machine']),
    })
    .strict(),
]);

const reconciliationSchema = z.discriminatedUnion('trigger', [
  z.object({ trigger: z.literal('manual') }).strict(),
  z.object({ trigger: z.literal('activation') }).strict(),
  z
    .object({
      trigger: z.literal('scheduled'),
      provider: reconciliationProviderSchema,
    })
    .strict(),
]);

const managedLaunchClaimSchema = z
  .object({
    deploymentId: deploymentIdSchema,
    configRevision: configRevisionSchema,
  })
  .strict();

const managedDeploymentConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    deploymentId: deploymentIdSchema,
    configRevision: configRevisionSchema,
    deploymentRoot: absolutePathSchema,
    root: z
      .object({
        path: absolutePathSchema,
        id: z.string().regex(ROOT_ID_PATTERN),
      })
      .strict(),
    projectDirectoryRoots: z
      .array(
        z
          .object({
            label: boundedText(256),
            path: absolutePathSchema,
          })
          .strict(),
      )
      .max(128),
    launch: z
      .object({
        kind: z.literal('exact_package'),
        nodePath: absolutePathSchema,
        package: packageIdentitySchema,
      })
      .strict(),
    listeners: z
      .object({
        localIpc: z.literal(true),
        websocket: z
          .object({
            host: z.literal('127.0.0.1'),
            port: z.number().int().min(0).max(65_535),
            path: boundedText(2_048).refine(isCanonicalRuntimeHostWebSocketPath),
          })
          .strict()
          .optional(),
      })
      .strict(),
    lifecycle: lifecycleSchema,
    reconciliation: reconciliationSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lifecycle.mode === 'on_demand' && value.reconciliation.trigger === 'scheduled') {
      context.addIssue({
        code: 'custom',
        message: 'An on-demand deployment cannot use scheduled reconciliation',
        path: ['reconciliation'],
      });
    }
    if (value.lifecycle.mode === 'supervised' && value.reconciliation.trigger === 'activation') {
      context.addIssue({
        code: 'custom',
        message: 'A supervised deployment cannot reconcile during Client activation',
        path: ['reconciliation'],
      });
    }
    if (value.lifecycle.mode === 'supervised' && value.reconciliation.trigger === 'scheduled') {
      const expected =
        value.lifecycle.provider === 'systemd_user'
          ? 'systemd_timer'
          : value.lifecycle.provider === 'launch_agent'
            ? 'launch_agent_timer'
            : 'openrc_supervised_loop';
      if (value.reconciliation.provider !== expected) {
        context.addIssue({
          code: 'custom',
          message: 'The reconciliation trigger does not match the persisted supervisor provider',
          path: ['reconciliation', 'provider'],
        });
      }
    }
  });

export type RuntimeHostSupervisorProvider = z.infer<typeof providerSchema>;
export type RuntimeHostReconciliationProvider = z.infer<typeof reconciliationProviderSchema>;
export type RuntimeHostManagedDeploymentConfig = z.infer<typeof managedDeploymentConfigSchema>;
export type RuntimeHostManagedLaunchClaim = z.infer<typeof managedLaunchClaimSchema>;

export interface RuntimeHostManagedDeploymentAuthorityOptions {
  /** Test-only or embedding override. Production uses the account-local durable default. */
  readonly authorityRoot?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
  /** Pre-existing test/embedding durability anchor for an authorityRoot override. */
  readonly durabilityBoundary?: string;
  /** Test-only durability fault injection. */
  readonly beforeDirectorySync?: (path: string) => void | Promise<void>;
}

export interface RuntimeHostManagedProcessLaunch {
  readonly executablePath: string;
  readonly entrypointPath: string;
}

export interface RuntimeHostManagedLaunchRequest {
  readonly lifecycleMode: 'on_demand' | 'supervised';
  readonly claim?: RuntimeHostManagedLaunchClaim;
  readonly processLaunch: RuntimeHostManagedProcessLaunch;
}

export function currentRuntimeHostProcessLaunch(): RuntimeHostManagedProcessLaunch {
  return {
    executablePath: process.execPath,
    entrypointPath: process.argv[1] ?? '',
  };
}

export const RUNTIME_HOST_MANAGED_LAUNCH_REJECTIONS = [
  'managed_root_requires_operator',
  'deployment_record_missing',
  'deployment_claim_mismatch',
  'deployment_lifecycle_mismatch',
  'deployment_launch_mismatch',
  'deployment_record_invalid',
] as const;

export type RuntimeHostManagedLaunchRejection =
  (typeof RUNTIME_HOST_MANAGED_LAUNCH_REJECTIONS)[number];

export class RuntimeHostManagedDeploymentError extends Error {
  constructor(
    readonly code:
      | 'invalid_config'
      | 'deployment_io_failed'
      | 'deployment_commit_unknown'
      | 'lifecycle_owner_exists'
      | 'state_root_owned'
      | RuntimeHostManagedLaunchRejection,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostManagedDeploymentError';
  }
}

export function decodeRuntimeHostManagedDeploymentConfig(
  value: unknown,
): RuntimeHostManagedDeploymentConfig {
  try {
    return managedDeploymentConfigSchema.parse(value);
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment config is invalid',
      { cause: error },
    );
  }
}

export function decodeRuntimeHostManagedLaunchClaim(value: unknown): RuntimeHostManagedLaunchClaim {
  try {
    return managedLaunchClaimSchema.parse(value);
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_claim_mismatch',
      'The Runtime Host managed launch claim is invalid',
      { cause: error },
    );
  }
}

export function runtimeHostManagedLaunchClaim(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostManagedLaunchClaim {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  return {
    deploymentId: canonical.deploymentId,
    configRevision: canonical.configRevision,
  };
}

export function resolveRuntimeHostManagedDeploymentAuthorityRoot(
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): string {
  if (options.authorityRoot !== undefined) {
    if (!isAbsolute(options.authorityRoot)) {
      throw new RuntimeHostManagedDeploymentError(
        'invalid_config',
        'The Runtime Host managed deployment authority root must be absolute',
      );
    }
    return resolve(options.authorityRoot);
  }
  const homeDir = options.homeDir ?? userInfo().homedir;
  const platform = options.platform ?? process.platform;
  const accountPath = platform === 'win32' ? win32 : posix;
  if (!accountPath.isAbsolute(homeDir)) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The OS account home must be absolute',
    );
  }
  const segments =
    platform === 'darwin'
      ? ['Library', 'Application Support', 'Maka', 'runtime-host-deployments']
      : platform === 'win32'
        ? ['AppData', 'Local', 'Maka', 'runtime-host-deployments']
        : ['.local', 'share', 'Maka', 'runtime-host-deployments'];
  return accountPath.join(accountPath.normalize(homeDir), ...segments);
}

export function resolveRuntimeHostManagedDeploymentConfigPath(
  rootId: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): string {
  requireRootId(rootId);
  return join(
    resolveRuntimeHostManagedDeploymentAuthorityRoot(options),
    rootId,
    RUNTIME_HOST_MANAGED_DEPLOYMENT_CONFIG_FILE,
  );
}

export async function readRuntimeHostManagedDeploymentConfig(
  capability: StorageRootCapability<'interactive'>,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  return readDeploymentConfigForCapability(
    resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId, options),
    capability,
  );
}

export async function resolveRuntimeHostManagedDeployment(
  rootId: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly capability: StorageRootCapability<'interactive'>;
  readonly config: RuntimeHostManagedDeploymentConfig;
}> {
  requireRootId(rootId);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(rootId, options);
  const value = await readBoundedJson(path);
  if (value === undefined) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_record_missing',
      'The managed Runtime Host deployment is not installed',
    );
  }
  const initial = decodeRuntimeHostManagedDeploymentConfig(value);
  if (initial.root.id !== rootId) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment record has an invalid Root identity',
    );
  }
  const capability = await resolveExistingStorageRoot({
    path: initial.root.path,
    kind: 'interactive',
    expectedRootId: rootId,
  });
  const config = await readDeploymentConfigForCapability(path, capability);
  if (config === undefined) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_record_missing',
      'The managed Runtime Host deployment disappeared during activation',
    );
  }
  return { capability, config };
}

export async function claimRuntimeHostManagedDeployment(
  capability: StorageRootCapability<'interactive'>,
  config: RuntimeHostManagedDeploymentConfig,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config: RuntimeHostManagedDeploymentConfig;
  readonly claim: RuntimeHostManagedLaunchClaim;
}> {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  assertConfigTargetsCapability(canonical, capability);
  const authorityRoot = resolveRuntimeHostManagedDeploymentAuthorityRoot(options);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId, options);
  await prepareAuthorityDirectory(
    dirname(path),
    resolveAuthorityDurabilityBoundary(authorityRoot, options),
    options,
  );

  const existing = await readDeploymentConfigForCapability(path, capability);
  if (existing !== undefined) return existingDeploymentClaim(existing, canonical);

  const owner = await tryAcquireStateRootOwner(capability);
  if (!owner) {
    const raced = await readDeploymentConfigForCapability(path, capability);
    if (raced !== undefined) return existingDeploymentClaim(raced, canonical);
    throw new RuntimeHostManagedDeploymentError(
      'state_root_owned',
      'The State Root must be retired before it can become managed',
    );
  }
  try {
    return await commitRuntimeHostManagedDeployment(owner, canonical, options);
  } finally {
    await owner.close();
  }
}

export async function commitRuntimeHostManagedDeployment(
  owner: StateRootOwner<'interactive'>,
  config: RuntimeHostManagedDeploymentConfig,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config: RuntimeHostManagedDeploymentConfig;
  readonly claim: RuntimeHostManagedLaunchClaim;
}> {
  if (owner.closed) {
    throw new RuntimeHostManagedDeploymentError(
      'state_root_owned',
      'The State Root deployment owner is no longer active',
    );
  }
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  assertConfigTargetsCapability(canonical, owner.capability);
  await assertStorageRootLease(owner.lease, 'interactive', 'write');
  const authorityRoot = resolveRuntimeHostManagedDeploymentAuthorityRoot(options);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(owner.capability.rootId, options);
  await prepareAuthorityDirectory(
    dirname(path),
    resolveAuthorityDurabilityBoundary(authorityRoot, options),
    options,
  );
  const current = await readDeploymentConfigForCapability(path, owner.capability);
  if (current !== undefined) return existingDeploymentClaim(current, canonical);
  await writePrivateJson(path, canonical);
  return {
    kind: 'applied',
    config: canonical,
    claim: runtimeHostManagedLaunchClaim(canonical),
  };
}

export interface RuntimeHostLaunchOwnership {
  readonly owner: StateRootOwner<'interactive'>;
  readonly managedConfig?: RuntimeHostManagedDeploymentConfig;
}

export async function tryAcquireRuntimeHostLaunch(
  capability: StorageRootCapability<'interactive'>,
  request: RuntimeHostManagedLaunchRequest,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<RuntimeHostLaunchOwnership | undefined> {
  const canonicalClaim =
    request.claim === undefined ? undefined : decodeRuntimeHostManagedLaunchClaim(request.claim);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId, options);
  const owner = await tryAcquireStateRootOwner(capability);
  if (!owner) return undefined;
  try {
    let config: RuntimeHostManagedDeploymentConfig | undefined;
    try {
      config = await readDeploymentConfigForCapability(path, capability);
    } catch (error) {
      if (
        !(error instanceof RuntimeHostManagedDeploymentError) ||
        error.code !== 'invalid_config'
      ) {
        throw error;
      }
      throw new RuntimeHostManagedDeploymentError(
        'deployment_record_invalid',
        'The Runtime Host managed deployment record is invalid',
        { cause: error },
      );
    }
    const rejection = runtimeHostManagedLaunchRejection(
      config,
      canonicalClaim,
      request.lifecycleMode,
    );
    if (rejection !== undefined) {
      throw new RuntimeHostManagedDeploymentError(
        rejection,
        managedLaunchRejectionMessage(rejection),
      );
    }
    if (config && !(await matchesManagedProcessLaunch(config, request))) {
      throw new RuntimeHostManagedDeploymentError(
        'deployment_launch_mismatch',
        managedLaunchRejectionMessage('deployment_launch_mismatch'),
      );
    }
    return config === undefined ? { owner } : { owner, managedConfig: config };
  } catch (error) {
    await owner.close();
    throw error;
  }
}

export async function tryAcquireRuntimeHostLaunchOwner(
  capability: StorageRootCapability<'interactive'>,
  request: RuntimeHostManagedLaunchRequest,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<StateRootOwner<'interactive'> | undefined> {
  return (await tryAcquireRuntimeHostLaunch(capability, request, options))?.owner;
}

export function runtimeHostManagedLaunchRejection(
  config: RuntimeHostManagedDeploymentConfig | undefined,
  claim: RuntimeHostManagedLaunchClaim | undefined,
  expectedLifecycleMode: 'on_demand' | 'supervised',
): RuntimeHostManagedLaunchRejection | undefined {
  if (config === undefined) return claim === undefined ? undefined : 'deployment_record_missing';
  if (claim === undefined) return 'managed_root_requires_operator';
  if (!sameManagedLaunch(runtimeHostManagedLaunchClaim(config), claim)) {
    return 'deployment_claim_mismatch';
  }
  return config.lifecycle.mode === expectedLifecycleMode
    ? undefined
    : 'deployment_lifecycle_mismatch';
}

function sameManagedLaunch(
  expected: RuntimeHostManagedLaunchClaim,
  claim: RuntimeHostManagedLaunchClaim,
): boolean {
  return (
    expected.deploymentId === claim.deploymentId && expected.configRevision === claim.configRevision
  );
}

function existingDeploymentClaim(
  existing: RuntimeHostManagedDeploymentConfig,
  requested: RuntimeHostManagedDeploymentConfig,
): {
  readonly kind: 'unchanged';
  readonly config: RuntimeHostManagedDeploymentConfig;
  readonly claim: RuntimeHostManagedLaunchClaim;
} {
  if (!isDeepStrictEqual(existing, requested)) {
    throw new RuntimeHostManagedDeploymentError(
      'lifecycle_owner_exists',
      'The State Root already has a managed deployment',
    );
  }
  return {
    kind: 'unchanged',
    config: existing,
    claim: runtimeHostManagedLaunchClaim(existing),
  };
}

async function readDeploymentConfigForCapability(
  path: string,
  capability: StorageRootCapability<'interactive'>,
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  const value = await readBoundedJson(path);
  if (value === undefined) return undefined;
  const config = decodeRuntimeHostManagedDeploymentConfig(value);
  assertConfigTargetsCapability(config, capability);
  return config;
}

function managedLaunchRejectionMessage(rejection: RuntimeHostManagedLaunchRejection): string {
  switch (rejection) {
    case 'managed_root_requires_operator':
      return 'The State Root is managed and must be activated through its operator';
    case 'deployment_record_missing':
      return 'The managed Runtime Host launch has no deployment record';
    case 'deployment_claim_mismatch':
      return 'The Runtime Host launch does not match the managed deployment';
    case 'deployment_lifecycle_mismatch':
      return 'The Runtime Host launch path cannot honor the configured lifecycle';
    case 'deployment_launch_mismatch':
      return 'The Runtime Host process was not launched from the configured exact package';
    case 'deployment_record_invalid':
      return 'The Runtime Host managed deployment record is invalid';
  }
}

async function matchesManagedProcessLaunch(
  config: RuntimeHostManagedDeploymentConfig,
  request: RuntimeHostManagedLaunchRequest,
): Promise<boolean> {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const expectedEntrypoint =
    request.lifecycleMode === 'on_demand' ? layout.candidateEntrypoint : layout.cliPath;
  const [actualExecutable, expectedExecutable, actualEntrypoint, canonicalExpectedEntrypoint] =
    await Promise.all([
      canonicalLaunchPath(request.processLaunch.executablePath),
      canonicalLaunchPath(config.launch.nodePath),
      canonicalLaunchPath(request.processLaunch.entrypointPath),
      canonicalLaunchPath(expectedEntrypoint),
    ]);
  return (
    actualExecutable !== undefined &&
    actualExecutable === expectedExecutable &&
    actualEntrypoint !== undefined &&
    actualEntrypoint === canonicalExpectedEntrypoint
  );
}

async function canonicalLaunchPath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (
      isNodeError(error, 'ENOENT') ||
      isNodeError(error, 'ENOTDIR') ||
      isNodeError(error, 'ELOOP')
    ) {
      return undefined;
    }
    throw deploymentIo('Unable to verify the Runtime Host managed launch path', error);
  }
}

function assertConfigTargetsCapability(
  config: RuntimeHostManagedDeploymentConfig,
  capability: StorageRootCapability<'interactive'>,
): void {
  if (
    config.root.id !== capability.rootId ||
    resolve(config.root.path) !== capability.canonicalPath
  ) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment targets a different State Root',
    );
  }
}

async function readBoundedJson(path: string): Promise<unknown | undefined> {
  let document: Buffer;
  try {
    document = await readStableBoundedFile({
      path,
      maxBytes: MAX_DOCUMENT_BYTES,
      invalidFile: () =>
        new RuntimeHostManagedDeploymentError(
          'invalid_config',
          'The Runtime Host managed deployment record must be one stable bounded regular file',
        ),
    });
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    if (error instanceof RuntimeHostManagedDeploymentError) throw error;
    throw deploymentIo('Unable to inspect the Runtime Host managed deployment record', error);
  }
  let contents: string;
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(document);
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment record is not valid UTF-8',
      { cause: error },
    );
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment record is not valid JSON',
      { cause: error },
    );
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(contents, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_io_failed',
      'The Runtime Host managed deployment record exceeds its size limit',
    );
  }
  const temporaryPath = path + '.' + process.pid + '.' + randomUUID() + '.tmp';
  let published = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    published = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    if (error instanceof RuntimeHostManagedDeploymentError) throw error;
    if (published) {
      throw new RuntimeHostManagedDeploymentError(
        'deployment_commit_unknown',
        'The Runtime Host managed deployment may have been persisted; re-read it before retrying',
        { cause: error },
      );
    }
    throw deploymentIo('Unable to publish the Runtime Host managed deployment record', error);
  } finally {
    if (!published) await rm(temporaryPath, { force: true });
  }
}

async function prepareAuthorityDirectory(
  path: string,
  durabilityBoundary: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<void> {
  try {
    const boundaryMetadata = await lstat(durabilityBoundary);
    if (!boundaryMetadata.isDirectory() || boundaryMetadata.isSymbolicLink()) {
      throw new Error('Managed deployment durability boundary is not a directory');
    }
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('Managed deployment authority path is not a directory');
    }
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
        throw new Error('Managed deployment authority path belongs to a different user');
      }
      await chmod(path, 0o700);
    }
    await syncDirectoryChain(path, durabilityBoundary, options.beforeDirectorySync);
  } catch (error) {
    throw deploymentIo('Unable to prepare the Runtime Host managed deployment authority', error);
  }
}

function resolveAuthorityDurabilityBoundary(
  authorityRoot: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions,
): string {
  if (options.durabilityBoundary !== undefined && !isAbsolute(options.durabilityBoundary)) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment durability boundary must be absolute',
    );
  }
  const boundary = resolve(
    options.durabilityBoundary ??
      (options.authorityRoot === undefined
        ? (options.homeDir ?? userInfo().homedir)
        : parse(authorityRoot).root),
  );
  const pathFromBoundary = relative(boundary, authorityRoot);
  if (
    pathFromBoundary === '..' ||
    pathFromBoundary.startsWith(`..${sep}`) ||
    isAbsolute(pathFromBoundary)
  ) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment durability boundary must contain the authority root',
    );
  }
  return boundary;
}

function requireRootId(rootId: string): void {
  if (!ROOT_ID_PATTERN.test(rootId)) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host State Root ID is invalid',
    );
  }
}

function deploymentIo(message: string, cause: unknown): RuntimeHostManagedDeploymentError {
  return cause instanceof RuntimeHostManagedDeploymentError
    ? cause
    : new RuntimeHostManagedDeploymentError('deployment_io_failed', message, { cause });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
