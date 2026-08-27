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
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type StateRootOwner,
  type StorageRootCapability,
  tryAcquireStateRootOwner,
} from '@maka/storage/root-authority';
import { withProcessLifetimeFileUpdateLock } from '@maka/storage/process-lifetime-file-update-lock';
import { syncDirectory, syncDirectoryChain } from '@maka/storage/stable-storage';
import { z } from 'zod';
import { isProductReleaseVersion, isSha512PackageIntegrity } from './update-package-evidence.js';

export const RUNTIME_HOST_MANAGED_DEPLOYMENT_CONFIG_FILE = 'runtime-host-deployment.json';

const SCHEMA_VERSION = 1 as const;
const MAX_DOCUMENT_BYTES = 64 * 1024;
const UPDATE_LOCK_TIMEOUT_MS = 60_000;
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

const launchLifecycleSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('on_demand') }).strict(),
  z
    .object({
      mode: z.literal('supervised'),
      provider: providerSchema,
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
    lifecycle: launchLifecycleSchema,
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
        cliPath: absolutePathSchema,
        package: packageIdentitySchema,
      })
      .strict(),
    listeners: z
      .object({
        localIpc: z.literal(true),
        websocket: z
          .object({
            host: z.literal('127.0.0.1'),
            port: z.number().int().min(1).max(65_535),
            path: boundedText(2_048).refine((value) => value.startsWith('/')),
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
export type RuntimeHostManagedOnDemandDeploymentConfig = RuntimeHostManagedDeploymentConfig & {
  readonly lifecycle: { readonly mode: 'on_demand'; readonly availability: 'activation' };
};
export type RuntimeHostManagedSupervisedDeploymentConfig = RuntimeHostManagedDeploymentConfig & {
  readonly lifecycle: {
    readonly mode: 'supervised';
    readonly provider: RuntimeHostSupervisorProvider;
    readonly availability: 'session' | 'environment' | 'machine';
  };
};
export type RuntimeHostManagedOnDemandLaunchClaim = RuntimeHostManagedLaunchClaim & {
  readonly lifecycle: { readonly mode: 'on_demand' };
};
export type RuntimeHostManagedSupervisedLaunchClaim = RuntimeHostManagedLaunchClaim & {
  readonly lifecycle: {
    readonly mode: 'supervised';
    readonly provider: RuntimeHostSupervisorProvider;
  };
};

export interface RuntimeHostManagedDeploymentAuthorityOptions {
  /** Test-only or embedding override. Production uses the account-local durable default. */
  readonly authorityRoot?: string;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

export type RuntimeHostManagedLaunchRejection =
  | 'managed_root_requires_operator'
  | 'deployment_record_missing'
  | 'deployment_claim_mismatch'
  | 'deployment_lifecycle_mismatch'
  | 'deployment_record_invalid';

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

export function isRuntimeHostManagedOnDemandLaunchClaim(
  claim: RuntimeHostManagedLaunchClaim,
): claim is RuntimeHostManagedOnDemandLaunchClaim {
  return claim.lifecycle.mode === 'on_demand';
}

export function runtimeHostManagedLaunchClaim(
  config: RuntimeHostManagedOnDemandDeploymentConfig,
): RuntimeHostManagedOnDemandLaunchClaim;
export function runtimeHostManagedLaunchClaim(
  config: RuntimeHostManagedSupervisedDeploymentConfig,
): RuntimeHostManagedSupervisedLaunchClaim;
export function runtimeHostManagedLaunchClaim(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostManagedLaunchClaim;
export function runtimeHostManagedLaunchClaim(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostManagedLaunchClaim {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  return {
    deploymentId: canonical.deploymentId,
    configRevision: canonical.configRevision,
    lifecycle:
      canonical.lifecycle.mode === 'on_demand'
        ? { mode: 'on_demand' }
        : { mode: 'supervised', provider: canonical.lifecycle.provider },
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
  const value = await readBoundedJson(
    resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId, options),
  );
  if (value === undefined) return undefined;
  const config = decodeRuntimeHostManagedDeploymentConfig(value);
  assertConfigTargetsCapability(config, capability);
  return config;
}

export function claimRuntimeHostManagedDeployment(
  capability: StorageRootCapability<'interactive'>,
  config: RuntimeHostManagedOnDemandDeploymentConfig,
  options?: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config: RuntimeHostManagedOnDemandDeploymentConfig;
  readonly claim: RuntimeHostManagedOnDemandLaunchClaim;
}>;
export function claimRuntimeHostManagedDeployment(
  capability: StorageRootCapability<'interactive'>,
  config: RuntimeHostManagedSupervisedDeploymentConfig,
  options?: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config: RuntimeHostManagedSupervisedDeploymentConfig;
  readonly claim: RuntimeHostManagedSupervisedLaunchClaim;
}>;
export function claimRuntimeHostManagedDeployment(
  capability: StorageRootCapability<'interactive'>,
  config: RuntimeHostManagedDeploymentConfig,
  options?: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config: RuntimeHostManagedDeploymentConfig;
  readonly claim: RuntimeHostManagedLaunchClaim;
}>;
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
  await prepareAuthorityDirectory(dirname(path), authorityRoot);
  return withProcessLifetimeFileUpdateLock(
    path,
    async () => {
      const currentValue = await readBoundedJson(path);
      if (currentValue !== undefined) {
        const current = decodeRuntimeHostManagedDeploymentConfig(currentValue);
        assertConfigTargetsCapability(current, capability);
        if (isDeepStrictEqual(current, canonical)) {
          return {
            kind: 'unchanged',
            config: current,
            claim: runtimeHostManagedLaunchClaim(current),
          };
        }
        throw new RuntimeHostManagedDeploymentError(
          'lifecycle_owner_exists',
          'The State Root already has a managed deployment',
        );
      }
      const owner = await tryAcquireStateRootOwner(capability);
      if (!owner) {
        throw new RuntimeHostManagedDeploymentError(
          'state_root_owned',
          'The State Root must be retired before it can become managed',
        );
      }
      try {
        await writePrivateJson(path, canonical);
      } finally {
        await owner.close();
      }
      return {
        kind: 'applied',
        config: canonical,
        claim: runtimeHostManagedLaunchClaim(canonical),
      };
    },
    UPDATE_LOCK_TIMEOUT_MS,
  );
}

export async function tryAcquireRuntimeHostLaunchOwner(
  capability: StorageRootCapability<'interactive'>,
  expectedLifecycleMode: 'on_demand' | 'supervised',
  claim: RuntimeHostManagedLaunchClaim | undefined,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<StateRootOwner<'interactive'> | undefined> {
  const canonicalClaim =
    claim === undefined ? undefined : decodeRuntimeHostManagedLaunchClaim(claim);
  const authorityRoot = resolveRuntimeHostManagedDeploymentAuthorityRoot(options);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId, options);
  await prepareAuthorityDirectory(dirname(path), authorityRoot);
  return withProcessLifetimeFileUpdateLock(
    path,
    async () => {
      const configValue = await readBoundedJson(path);
      let config: RuntimeHostManagedDeploymentConfig | undefined;
      if (configValue !== undefined) {
        try {
          config = decodeRuntimeHostManagedDeploymentConfig(configValue);
          assertConfigTargetsCapability(config, capability);
        } catch (error) {
          throw new RuntimeHostManagedDeploymentError(
            'deployment_record_invalid',
            'The Runtime Host managed deployment record is invalid',
            { cause: error },
          );
        }
      }
      const rejection = runtimeHostManagedLaunchRejection(
        config,
        canonicalClaim,
        expectedLifecycleMode,
      );
      if (rejection !== undefined) {
        throw new RuntimeHostManagedDeploymentError(
          rejection,
          managedLaunchRejectionMessage(rejection),
        );
      }
      return tryAcquireStateRootOwner(capability);
    },
    UPDATE_LOCK_TIMEOUT_MS,
  );
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
  if (
    expected.deploymentId !== claim.deploymentId ||
    expected.configRevision !== claim.configRevision ||
    expected.lifecycle.mode !== claim.lifecycle.mode
  ) {
    return false;
  }
  return (
    expected.lifecycle.mode !== 'supervised' ||
    (claim.lifecycle.mode === 'supervised' &&
      expected.lifecycle.provider === claim.lifecycle.provider)
  );
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
    case 'deployment_record_invalid':
      return 'The Runtime Host managed deployment record is invalid';
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
  let target: Awaited<ReturnType<typeof lstat>>;
  try {
    target = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw deploymentIo('Unable to inspect the Runtime Host managed deployment record', error);
  }
  if (!target.isFile() || target.isSymbolicLink() || target.size > MAX_DOCUMENT_BYTES) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment record must be a bounded regular file',
    );
  }
  try {
    const contents = await readFile(path, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new RuntimeHostManagedDeploymentError(
        'invalid_config',
        'The Runtime Host managed deployment record exceeds its size limit',
      );
    }
    return JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof RuntimeHostManagedDeploymentError) throw error;
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

async function prepareAuthorityDirectory(path: string, authorityRoot: string): Promise<void> {
  try {
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
    await syncDirectoryChain(path, dirname(authorityRoot));
  } catch (error) {
    throw deploymentIo('Unable to prepare the Runtime Host managed deployment authority', error);
  }
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
