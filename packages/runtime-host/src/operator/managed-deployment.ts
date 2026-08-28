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
  repairStorageRootAfterRemount,
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
const MAX_DOCUMENT_BYTES = 256 * 1024;
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

const deploymentTransitionOperationSchema = z.enum([
  'install',
  'legacy_migration',
  'lifecycle_change',
  'provider_change',
  'configure',
  'update',
  'uninstall',
]);
const deploymentTransitionRecoverySchema = z.enum(['restore_from', 'complete_to']);

const deploymentAuthorityRootSchema = z
  .object({
    path: absolutePathSchema,
    id: z.string().regex(ROOT_ID_PATTERN),
  })
  .strict();

const managedDeploymentConfigSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    state: z.literal('active'),
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
        directPeer: z
          .object({
            enabled: z.boolean(),
            keyPath: absolutePathSchema,
            peerId: boundedText(256),
            listenAddresses: z.array(boundedText(2_048)).min(1).max(16),
            coordinationRelays: z.array(boundedText(2_048)).max(16),
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
    if (value.lifecycle.mode === 'on_demand' && value.listeners.directPeer?.enabled === true) {
      context.addIssue({
        code: 'custom',
        message: 'An on-demand deployment cannot enable a direct peer listener',
        path: ['listeners', 'directPeer'],
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

const managedDeploymentTransitionSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    state: z.literal('transition'),
    transactionId: deploymentIdSchema,
    operation: deploymentTransitionOperationSchema,
    recovery: deploymentTransitionRecoverySchema,
    root: deploymentAuthorityRootSchema,
    from: managedDeploymentConfigSchema.nullable(),
    to: managedDeploymentConfigSchema.nullable(),
  })
  .strict()
  .superRefine(validateDeploymentTransitionEndpoints);

const managedDeploymentBlockedSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    state: z.literal('blocked'),
    transactionId: deploymentIdSchema,
    operation: deploymentTransitionOperationSchema,
    recovery: deploymentTransitionRecoverySchema,
    root: deploymentAuthorityRootSchema,
    from: managedDeploymentConfigSchema.nullable(),
    to: managedDeploymentConfigSchema.nullable(),
    reason: boundedText(1_024),
  })
  .strict()
  .superRefine(validateDeploymentTransitionEndpoints);

const managedDeploymentAuthorityRecordSchema = z.union([
  managedDeploymentConfigSchema,
  managedDeploymentTransitionSchema,
  managedDeploymentBlockedSchema,
]);

function validateDeploymentTransitionEndpoints(
  value: {
    readonly operation: z.infer<typeof deploymentTransitionOperationSchema>;
    readonly root: z.infer<typeof deploymentAuthorityRootSchema>;
    readonly from: RuntimeHostManagedDeploymentConfig | null;
    readonly to: RuntimeHostManagedDeploymentConfig | null;
  },
  context: z.RefinementCtx,
): void {
  const operationShapeValid =
    (value.operation === 'install' && value.from === null && value.to !== null) ||
    (value.operation === 'uninstall' && value.from !== null && value.to === null) ||
    (value.operation === 'legacy_migration' &&
      ((value.from === null && value.to !== null) || (value.from !== null && value.to === null))) ||
    ((value.operation === 'lifecycle_change' ||
      value.operation === 'provider_change' ||
      value.operation === 'configure' ||
      value.operation === 'update') &&
      value.from !== null &&
      value.to !== null &&
      value.from.deploymentId === value.to.deploymentId &&
      value.to.configRevision > value.from.configRevision);
  const endpointsTargetAuthority = [value.from, value.to].every(
    (config) =>
      config === null || (config.root.id === value.root.id && config.root.path === value.root.path),
  );
  if (!operationShapeValid || !endpointsTargetAuthority) {
    context.addIssue({
      code: 'custom',
      message: 'The managed deployment transition endpoints do not match its operation',
      path: ['operation'],
    });
  }
}

export type RuntimeHostSupervisorProvider = z.infer<typeof providerSchema>;
export type RuntimeHostReconciliationProvider = z.infer<typeof reconciliationProviderSchema>;
export type RuntimeHostManagedDeploymentConfig = z.infer<typeof managedDeploymentConfigSchema>;
export type RuntimeHostManagedLaunchClaim = z.infer<typeof managedLaunchClaimSchema>;
export type RuntimeHostManagedDeploymentTransitionOperation = z.infer<
  typeof deploymentTransitionOperationSchema
>;
export type RuntimeHostManagedDeploymentTransitionRecovery = z.infer<
  typeof deploymentTransitionRecoverySchema
>;
export type RuntimeHostManagedDeploymentTransition = z.infer<
  typeof managedDeploymentTransitionSchema
>;
export type RuntimeHostManagedDeploymentBlocked = z.infer<typeof managedDeploymentBlockedSchema>;
export type RuntimeHostManagedDeploymentAuthorityRecord =
  | RuntimeHostManagedDeploymentConfig
  | RuntimeHostManagedDeploymentTransition
  | RuntimeHostManagedDeploymentBlocked;

export interface RuntimeHostManagedDeploymentTransitionInput {
  readonly transactionId: string;
  readonly operation: RuntimeHostManagedDeploymentTransitionOperation;
  readonly recovery: RuntimeHostManagedDeploymentTransitionRecovery;
  readonly expected?: RuntimeHostManagedDeploymentConfig;
  readonly desired?: RuntimeHostManagedDeploymentConfig;
}

export interface RuntimeHostManagedDeploymentAuthorityOptions {
  /** Explicitly accept a device-only root identity change at a known remount boundary. */
  readonly repairRootAfterRemount?: true;
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
  'deployment_transition_in_progress',
  'deployment_needs_repair',
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
      | 'deployment_transaction_mismatch'
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

export function decodeRuntimeHostManagedDeploymentAuthorityRecord(
  value: unknown,
): RuntimeHostManagedDeploymentAuthorityRecord {
  try {
    return managedDeploymentAuthorityRecordSchema.parse(
      value,
    ) as RuntimeHostManagedDeploymentAuthorityRecord;
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment authority record is invalid',
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

export async function readRuntimeHostManagedDeploymentAuthorityRecord(
  capability: StorageRootCapability<'interactive'>,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<RuntimeHostManagedDeploymentAuthorityRecord | undefined> {
  return readDeploymentAuthorityForCapability(
    resolveRuntimeHostManagedDeploymentConfigPath(capability.rootId, options),
    capability,
  );
}

export async function assertRuntimeHostManagedDeploymentAuthorityDurablyAbsent(
  owner: StateRootOwner<'interactive'>,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<void> {
  if (owner.closed) {
    throw new RuntimeHostManagedDeploymentError(
      'state_root_owned',
      'The State Root deployment owner is no longer active',
    );
  }
  await assertStorageRootLease(owner.lease, 'interactive', 'write');
  const path = resolveRuntimeHostManagedDeploymentConfigPath(owner.capability.rootId, options);
  if ((await readDeploymentAuthorityForCapability(path, owner.capability)) !== undefined) {
    throw new RuntimeHostManagedDeploymentError(
      'lifecycle_owner_exists',
      'Runtime Host lifecycle authority still exists',
    );
  }
  await options.beforeDirectorySync?.(dirname(path));
  await syncDirectory(dirname(path));
  if ((await readDeploymentAuthorityForCapability(path, owner.capability)) !== undefined) {
    throw new RuntimeHostManagedDeploymentError(
      'lifecycle_owner_exists',
      'Runtime Host lifecycle authority reappeared while confirming its removal',
    );
  }
}

export async function resolveRuntimeHostManagedDeployment(
  rootId: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly capability: StorageRootCapability<'interactive'>;
  readonly config: RuntimeHostManagedDeploymentConfig;
}> {
  const resolved = await resolveRuntimeHostManagedDeploymentAuthority(rootId, options);
  if (!resolved) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_record_missing',
      'The managed Runtime Host deployment is not installed',
    );
  }
  const { capability, record } = resolved;
  if (record.state !== 'active') {
    throw transitionStateError(record);
  }
  return { capability, config: record };
}

export async function resolveRuntimeHostManagedDeploymentAuthority(
  rootId: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<
  | {
      readonly capability: StorageRootCapability<'interactive'>;
      readonly record: RuntimeHostManagedDeploymentAuthorityRecord;
    }
  | undefined
> {
  requireRootId(rootId);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(rootId, options);
  const value = await readBoundedJson(path);
  if (value === undefined) return undefined;
  const initial = decodeRuntimeHostManagedDeploymentAuthorityRecord(value);
  if (initial.root.id !== rootId) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment record has an invalid Root identity',
    );
  }
  if (options.repairRootAfterRemount) {
    await repairStorageRootAfterRemount({
      path: initial.root.path,
      kind: 'interactive',
      expectedRootId: rootId,
    });
  }
  const capability = await resolveExistingStorageRoot({
    path: initial.root.path,
    kind: 'interactive',
    expectedRootId: rootId,
  });
  const record = await readRuntimeHostManagedDeploymentAuthorityRecord(capability, options);
  if (!record) return undefined;
  return { capability, record };
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
  await writePrivateJson(path, canonical, options.beforeDirectorySync);
  return {
    kind: 'applied',
    config: canonical,
    claim: runtimeHostManagedLaunchClaim(canonical),
  };
}

export async function beginRuntimeHostManagedDeploymentTransition(
  owner: StateRootOwner<'interactive'>,
  input: RuntimeHostManagedDeploymentTransitionInput,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly record: RuntimeHostManagedDeploymentTransition;
}> {
  const transition = deploymentTransitionRecord(owner.capability, input);
  await assertManagedDeploymentOwner(owner);
  const path = await prepareManagedDeploymentAuthorityPath(owner.capability.rootId, options);
  const current = await readDeploymentAuthorityForCapability(path, owner.capability);
  if (current && current.state !== 'active') {
    if (current.state === 'blocked') throw deploymentNeedsRepair(current);
    if (isDeepStrictEqual(current, transition)) return { kind: 'unchanged', record: current };
    throw deploymentTransactionMismatch('A different managed deployment transition is active');
  }
  const expected = input.expected && decodeRuntimeHostManagedDeploymentConfig(input.expected);
  if (!isDeepStrictEqual(current, expected)) {
    throw deploymentTransactionMismatch('The managed deployment changed before transition began');
  }
  await writePrivateJson(path, transition, options.beforeDirectorySync);
  return { kind: 'applied', record: transition };
}

export async function commitRuntimeHostManagedDeploymentTransition(
  owner: StateRootOwner<'interactive'>,
  transactionId: string,
  desired: RuntimeHostManagedDeploymentConfig | undefined,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config?: RuntimeHostManagedDeploymentConfig;
}> {
  return finishRuntimeHostManagedDeploymentTransition(owner, transactionId, 'to', desired, options);
}

export async function rollbackRuntimeHostManagedDeploymentTransition(
  owner: StateRootOwner<'interactive'>,
  transactionId: string,
  previous: RuntimeHostManagedDeploymentConfig | undefined,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config?: RuntimeHostManagedDeploymentConfig;
}> {
  return finishRuntimeHostManagedDeploymentTransition(
    owner,
    transactionId,
    'from',
    previous,
    options,
  );
}

export async function blockRuntimeHostManagedDeploymentTransition(
  owner: StateRootOwner<'interactive'>,
  transactionId: string,
  reason: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions = {},
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly record: RuntimeHostManagedDeploymentBlocked;
}> {
  await assertManagedDeploymentOwner(owner);
  const path = await prepareManagedDeploymentAuthorityPath(owner.capability.rootId, options);
  const current = await readDeploymentAuthorityForCapability(path, owner.capability);
  if (!current || current.state === 'active' || current.transactionId !== transactionId) {
    throw deploymentTransactionMismatch('The managed deployment transition is no longer current');
  }
  const record = decodeRuntimeHostManagedDeploymentAuthorityRecord({
    ...current,
    state: 'blocked',
    reason,
  });
  if (record.state !== 'blocked') {
    throw deploymentTransactionMismatch('The managed deployment blocked record is invalid');
  }
  if (isDeepStrictEqual(current, record)) return { kind: 'unchanged', record };
  await writePrivateJson(path, record, options.beforeDirectorySync);
  return { kind: 'applied', record };
}

async function finishRuntimeHostManagedDeploymentTransition(
  owner: StateRootOwner<'interactive'>,
  transactionId: string,
  endpoint: 'from' | 'to',
  value: RuntimeHostManagedDeploymentConfig | undefined,
  options: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly config?: RuntimeHostManagedDeploymentConfig;
}> {
  await assertManagedDeploymentOwner(owner);
  const config = value && decodeRuntimeHostManagedDeploymentConfig(value);
  if (config) assertConfigTargetsCapability(config, owner.capability);
  const path = await prepareManagedDeploymentAuthorityPath(owner.capability.rootId, options);
  const current = await readDeploymentAuthorityForCapability(path, owner.capability);
  if (current === undefined) {
    if (config === undefined) return { kind: 'unchanged' };
    throw deploymentTransactionMismatch('The managed deployment transition record is missing');
  }
  if (current.state === 'active') {
    if (config && isDeepStrictEqual(current, config)) {
      return { kind: 'unchanged', config: current };
    }
    throw deploymentTransactionMismatch('The managed deployment transition is no longer current');
  }
  if (current.transactionId !== transactionId) {
    throw deploymentTransactionMismatch('The managed deployment transaction identity changed');
  }
  if (!isDeepStrictEqual(current[endpoint], config ?? null)) {
    throw deploymentTransactionMismatch('The managed deployment transition target changed');
  }
  if (config) await writePrivateJson(path, config, options.beforeDirectorySync);
  else await removePrivateJson(path, options.beforeDirectorySync);
  return { kind: 'applied', ...(config ? { config } : {}) };
}

function deploymentTransitionRecord(
  capability: StorageRootCapability<'interactive'>,
  input: RuntimeHostManagedDeploymentTransitionInput,
): RuntimeHostManagedDeploymentTransition {
  const expected = input.expected && decodeRuntimeHostManagedDeploymentConfig(input.expected);
  const desired = input.desired && decodeRuntimeHostManagedDeploymentConfig(input.desired);
  if (expected) assertConfigTargetsCapability(expected, capability);
  if (desired) assertConfigTargetsCapability(desired, capability);
  const record = decodeRuntimeHostManagedDeploymentAuthorityRecord({
    schemaVersion: SCHEMA_VERSION,
    state: 'transition',
    transactionId: input.transactionId,
    operation: input.operation,
    recovery: input.recovery,
    root: { path: capability.canonicalPath, id: capability.rootId },
    from: expected ?? null,
    to: desired ?? null,
  });
  if (record.state !== 'transition') {
    throw deploymentTransactionMismatch('The managed deployment transition is invalid');
  }
  return record;
}

async function assertManagedDeploymentOwner(owner: StateRootOwner<'interactive'>): Promise<void> {
  if (owner.closed) {
    throw new RuntimeHostManagedDeploymentError(
      'state_root_owned',
      'The State Root deployment owner is no longer active',
    );
  }
  await assertStorageRootLease(owner.lease, 'interactive', 'write');
}

async function prepareManagedDeploymentAuthorityPath(
  rootId: string,
  options: RuntimeHostManagedDeploymentAuthorityOptions,
): Promise<string> {
  const authorityRoot = resolveRuntimeHostManagedDeploymentAuthorityRoot(options);
  const path = resolveRuntimeHostManagedDeploymentConfigPath(rootId, options);
  await prepareAuthorityDirectory(
    dirname(path),
    resolveAuthorityDurabilityBoundary(authorityRoot, options),
    options,
  );
  return path;
}

function deploymentTransactionMismatch(message: string): RuntimeHostManagedDeploymentError {
  return new RuntimeHostManagedDeploymentError('deployment_transaction_mismatch', message);
}

function deploymentNeedsRepair(
  record: RuntimeHostManagedDeploymentBlocked,
): RuntimeHostManagedDeploymentError {
  return new RuntimeHostManagedDeploymentError(
    'deployment_needs_repair',
    `The managed deployment transaction ${record.transactionId} requires repair`,
  );
}

function transitionStateError(
  record: RuntimeHostManagedDeploymentTransition | RuntimeHostManagedDeploymentBlocked,
): RuntimeHostManagedDeploymentError {
  return record.state === 'transition'
    ? new RuntimeHostManagedDeploymentError(
        'deployment_transition_in_progress',
        `The managed deployment transaction ${record.transactionId} is in progress`,
      )
    : deploymentNeedsRepair(record);
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
  const record = await readDeploymentAuthorityForCapability(path, capability);
  if (record === undefined || record.state === 'active') return record;
  throw transitionStateError(record);
}

async function readDeploymentAuthorityForCapability(
  path: string,
  capability: StorageRootCapability<'interactive'>,
): Promise<RuntimeHostManagedDeploymentAuthorityRecord | undefined> {
  const value = await readBoundedJson(path);
  if (value === undefined) return undefined;
  const record = decodeRuntimeHostManagedDeploymentAuthorityRecord(value);
  assertAuthorityTargetsCapability(record, capability);
  return record;
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
    case 'deployment_transition_in_progress':
      return 'The Runtime Host managed deployment is changing and cannot be launched';
    case 'deployment_needs_repair':
      return 'The Runtime Host managed deployment requires repair before it can be launched';
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

function assertAuthorityTargetsCapability(
  record: RuntimeHostManagedDeploymentAuthorityRecord,
  capability: StorageRootCapability<'interactive'>,
): void {
  if (
    record.root.id !== capability.rootId ||
    resolve(record.root.path) !== capability.canonicalPath
  ) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host managed deployment authority targets a different State Root',
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

async function writePrivateJson(
  path: string,
  value: unknown,
  beforeDirectorySync?: (path: string) => void | Promise<void>,
): Promise<void> {
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
    await beforeDirectorySync?.(dirname(path));
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

async function removePrivateJson(
  path: string,
  beforeDirectorySync?: (path: string) => void | Promise<void>,
): Promise<void> {
  let removed = false;
  try {
    await rm(path);
    removed = true;
    await beforeDirectorySync?.(dirname(path));
    await syncDirectory(dirname(path));
  } catch (error) {
    if (removed) {
      throw new RuntimeHostManagedDeploymentError(
        'deployment_commit_unknown',
        'The Runtime Host managed deployment may have been removed; re-read it before retrying',
        { cause: error },
      );
    }
    if (isNodeError(error, 'ENOENT')) return;
    throw deploymentIo('Unable to remove the Runtime Host managed deployment record', error);
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
    : new RuntimeHostManagedDeploymentError('deployment_io_failed', message, {
        cause,
      });
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
