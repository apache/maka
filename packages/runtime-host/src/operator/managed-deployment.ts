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
import { chmod, lstat, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  prepareStorageRootControlDirectory,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import { withProcessLifetimeFileUpdateLock } from '@maka/storage/process-lifetime-file-update-lock';
import { z } from 'zod';
import {
  isRuntimeHostNpmDeploymentIdentity,
  type RuntimeHostDeploymentIdentity,
} from './update-package-evidence.js';

export const RUNTIME_HOST_MANAGED_DEPLOYMENT_CONFIG_FILE = 'runtime-host-deployment.json';
export const RUNTIME_HOST_LIFECYCLE_FENCE_FILE = 'runtime-host-managed-owner.json';

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
const packageIdentitySchema = z.custom<RuntimeHostDeploymentIdentity>(
  isRuntimeHostNpmDeploymentIdentity,
);

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

const reconciliationSchema = z.discriminatedUnion('policy', [
  z.object({ policy: z.literal('manual') }).strict(),
  z
    .object({
      policy: z.literal('automatic'),
      trigger: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('activation') }).strict(),
        z
          .object({
            kind: z.literal('scheduled'),
            provider: reconciliationProviderSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
]);

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
    if (
      value.lifecycle.mode === 'on_demand' &&
      value.reconciliation.policy === 'automatic' &&
      value.reconciliation.trigger.kind !== 'activation'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'An on-demand deployment can only reconcile during activation',
        path: ['reconciliation'],
      });
    }
    if (
      value.lifecycle.mode === 'supervised' &&
      value.reconciliation.policy === 'automatic' &&
      value.reconciliation.trigger.kind === 'activation'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A supervised deployment requires a scheduled reconciliation trigger',
        path: ['reconciliation'],
      });
    }
    if (
      value.lifecycle.mode === 'supervised' &&
      value.reconciliation.policy === 'automatic' &&
      value.reconciliation.trigger.kind === 'scheduled'
    ) {
      const expected =
        value.lifecycle.provider === 'systemd_user'
          ? 'systemd_timer'
          : value.lifecycle.provider === 'launch_agent'
            ? 'launch_agent_timer'
            : 'openrc_supervised_loop';
      if (value.reconciliation.trigger.provider !== expected) {
        context.addIssue({
          code: 'custom',
          message: 'The reconciliation trigger does not match the persisted supervisor provider',
          path: ['reconciliation', 'trigger', 'provider'],
        });
      }
    }
  });

const activeFenceStateSchema = z
  .object({
    kind: z.literal('active'),
    deploymentId: deploymentIdSchema,
    configRevision: configRevisionSchema,
    lifecycle: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('on_demand') }).strict(),
      z
        .object({
          mode: z.literal('supervised'),
          provider: providerSchema,
        })
        .strict(),
    ]),
  })
  .strict();

const lifecycleFenceSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    rootId: z.string().regex(ROOT_ID_PATTERN),
    revision: z.string().regex(UUID_PATTERN),
    state: z.discriminatedUnion('kind', [
      activeFenceStateSchema,
      z
        .object({
          kind: z.literal('transition'),
          deploymentId: deploymentIdSchema,
          transactionId: deploymentIdSchema,
          fromConfigRevision: configRevisionSchema.nullable(),
          toConfigRevision: configRevisionSchema.nullable(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('blocked'),
          deploymentId: deploymentIdSchema,
          transactionId: deploymentIdSchema,
          reasonCode: boundedText(256),
        })
        .strict(),
    ]),
  })
  .strict();

const managedLaunchClaimSchema = z
  .object({
    deploymentId: deploymentIdSchema,
    configRevision: configRevisionSchema,
    lifecycle: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('on_demand') }).strict(),
      z
        .object({
          mode: z.literal('supervised'),
          provider: providerSchema,
        })
        .strict(),
    ]),
  })
  .strict();

export type RuntimeHostSupervisorProvider = z.infer<typeof providerSchema>;
export type RuntimeHostReconciliationProvider = z.infer<typeof reconciliationProviderSchema>;
export type RuntimeHostManagedDeploymentConfig = z.infer<typeof managedDeploymentConfigSchema>;
export type RuntimeHostLifecycleFence = z.infer<typeof lifecycleFenceSchema>;
export type RuntimeHostManagedLaunchClaim = z.infer<typeof managedLaunchClaimSchema>;
export type RuntimeHostActiveLifecycleFence = RuntimeHostLifecycleFence & {
  readonly state: z.infer<typeof activeFenceStateSchema>;
};

export type RuntimeHostManagedLaunchRejection =
  | 'managed_root_requires_operator'
  | 'deployment_fence_missing'
  | 'deployment_fence_mismatch'
  | 'deployment_transition_in_progress'
  | 'deployment_needs_repair';

export class RuntimeHostManagedDeploymentError extends Error {
  constructor(
    readonly code:
      | 'invalid_config'
      | 'invalid_fence'
      | 'deployment_io_failed'
      | 'lifecycle_owner_exists'
      | 'lifecycle_owner_changed'
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

export function decodeRuntimeHostLifecycleFence(
  value: unknown,
  expectedRootId?: string,
): RuntimeHostLifecycleFence {
  try {
    const fence = lifecycleFenceSchema.parse(value);
    if (expectedRootId !== undefined && fence.rootId !== expectedRootId) {
      throw new Error('The lifecycle fence belongs to a different State Root');
    }
    return fence;
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_fence',
      'The Runtime Host lifecycle fence is invalid',
      { cause: error },
    );
  }
}

export function decodeRuntimeHostManagedLaunchClaim(value: unknown): RuntimeHostManagedLaunchClaim {
  try {
    return managedLaunchClaimSchema.parse(value);
  } catch (error) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_fence_mismatch',
      'The Runtime Host managed launch claim is invalid',
      { cause: error },
    );
  }
}

export function resolveRuntimeHostManagedDeploymentConfigPath(clientDataRoot: string): string {
  if (!isAbsolute(clientDataRoot)) {
    throw new RuntimeHostManagedDeploymentError(
      'invalid_config',
      'The Runtime Host client data root must be absolute',
    );
  }
  return join(resolve(clientDataRoot), RUNTIME_HOST_MANAGED_DEPLOYMENT_CONFIG_FILE);
}

export async function readRuntimeHostManagedDeploymentConfig(
  path: string,
): Promise<RuntimeHostManagedDeploymentConfig | undefined> {
  const value = await readBoundedJson(path, 'config');
  return value === undefined ? undefined : decodeRuntimeHostManagedDeploymentConfig(value);
}

export async function writeRuntimeHostManagedDeploymentConfig(
  path: string,
  config: RuntimeHostManagedDeploymentConfig,
): Promise<void> {
  const canonical = decodeRuntimeHostManagedDeploymentConfig(config);
  await withProcessLifetimeFileUpdateLock(path, () => writePrivateJson(path, canonical));
}

export async function readRuntimeHostLifecycleFence(
  capability: StorageRootCapability<'interactive'>,
): Promise<RuntimeHostLifecycleFence | undefined> {
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const value = await readBoundedJson(
    join(controlDirectory, RUNTIME_HOST_LIFECYCLE_FENCE_FILE),
    'fence',
  );
  return value === undefined
    ? undefined
    : decodeRuntimeHostLifecycleFence(value, capability.rootId);
}

export async function claimRuntimeHostLifecycleFence(
  capability: StorageRootCapability<'interactive'>,
  claim: RuntimeHostManagedLaunchClaim,
): Promise<{
  readonly kind: 'applied' | 'unchanged';
  readonly fence: RuntimeHostLifecycleFence;
}> {
  const canonicalClaim = decodeRuntimeHostManagedLaunchClaim(claim);
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const path = join(controlDirectory, RUNTIME_HOST_LIFECYCLE_FENCE_FILE);
  return withProcessLifetimeFileUpdateLock(path, async () => {
    const currentValue = await readBoundedJson(path, 'fence');
    const current =
      currentValue === undefined
        ? undefined
        : decodeRuntimeHostLifecycleFence(currentValue, capability.rootId);
    if (current !== undefined) {
      if (current.state.kind === 'active' && sameManagedLaunch(current.state, canonicalClaim)) {
        return { kind: 'unchanged', fence: current };
      }
      throw new RuntimeHostManagedDeploymentError(
        'lifecycle_owner_exists',
        'The State Root already has a managed lifecycle owner',
      );
    }
    const fence: RuntimeHostLifecycleFence = {
      schemaVersion: SCHEMA_VERSION,
      rootId: capability.rootId,
      revision: randomUUID(),
      state: {
        kind: 'active',
        ...canonicalClaim,
      },
    };
    await writePrivateJson(path, fence);
    return { kind: 'applied', fence };
  });
}

export async function releaseRuntimeHostLifecycleFence(
  capability: StorageRootCapability<'interactive'>,
  expected: {
    readonly revision: string;
    readonly deploymentId: string;
    readonly configRevision: number;
  },
): Promise<'released' | 'unchanged'> {
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const path = join(controlDirectory, RUNTIME_HOST_LIFECYCLE_FENCE_FILE);
  return withProcessLifetimeFileUpdateLock(path, async () => {
    const currentValue = await readBoundedJson(path, 'fence');
    if (currentValue === undefined) return 'unchanged';
    const current = decodeRuntimeHostLifecycleFence(currentValue, capability.rootId);
    if (
      current.revision !== expected.revision ||
      current.state.kind !== 'active' ||
      current.state.deploymentId !== expected.deploymentId ||
      current.state.configRevision !== expected.configRevision
    ) {
      throw new RuntimeHostManagedDeploymentError(
        'lifecycle_owner_changed',
        'The Runtime Host lifecycle owner changed before release',
      );
    }
    await removePrivateJson(path);
    return 'released';
  });
}

export function runtimeHostManagedLaunchRejection(
  fence: RuntimeHostLifecycleFence | undefined,
  claim: RuntimeHostManagedLaunchClaim | undefined,
): RuntimeHostManagedLaunchRejection | undefined {
  if (fence === undefined) return claim === undefined ? undefined : 'deployment_fence_missing';
  if (fence.state.kind === 'transition') return 'deployment_transition_in_progress';
  if (fence.state.kind === 'blocked') return 'deployment_needs_repair';
  if (claim === undefined) return 'managed_root_requires_operator';
  return sameManagedLaunch(fence.state, claim) ? undefined : 'deployment_fence_mismatch';
}

export async function assertRuntimeHostManagedLaunchAuthorized(
  capability: StorageRootCapability<'interactive'>,
  claim: RuntimeHostManagedLaunchClaim | undefined,
): Promise<void> {
  const canonicalClaim =
    claim === undefined ? undefined : decodeRuntimeHostManagedLaunchClaim(claim);
  const rejection = runtimeHostManagedLaunchRejection(
    await readRuntimeHostLifecycleFence(capability),
    canonicalClaim,
  );
  if (rejection !== undefined) {
    throw new RuntimeHostManagedDeploymentError(
      rejection,
      managedLaunchRejectionMessage(rejection),
    );
  }
}

function sameManagedLaunch(
  active: z.infer<typeof activeFenceStateSchema>,
  claim: RuntimeHostManagedLaunchClaim,
): boolean {
  if (
    active.deploymentId !== claim.deploymentId ||
    active.configRevision !== claim.configRevision ||
    active.lifecycle.mode !== claim.lifecycle.mode
  ) {
    return false;
  }
  return (
    active.lifecycle.mode !== 'supervised' ||
    (claim.lifecycle.mode === 'supervised' &&
      active.lifecycle.provider === claim.lifecycle.provider)
  );
}

function managedLaunchRejectionMessage(rejection: RuntimeHostManagedLaunchRejection): string {
  switch (rejection) {
    case 'managed_root_requires_operator':
      return 'The State Root is managed and must be activated through its operator';
    case 'deployment_fence_missing':
      return 'The managed Runtime Host deployment has no lifecycle fence';
    case 'deployment_fence_mismatch':
      return 'The Runtime Host launch does not match the active lifecycle owner';
    case 'deployment_transition_in_progress':
      return 'The Runtime Host deployment is changing lifecycle owner';
    case 'deployment_needs_repair':
      return 'The Runtime Host deployment requires repair before activation';
  }
}

async function readBoundedJson(
  path: string,
  kind: 'config' | 'fence',
): Promise<unknown | undefined> {
  let target: Awaited<ReturnType<typeof lstat>>;
  try {
    target = await lstat(path);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return undefined;
    throw deploymentIo('Unable to inspect the Runtime Host managed deployment ' + kind, error);
  }
  if (!target.isFile() || target.isSymbolicLink() || target.size > MAX_DOCUMENT_BYTES) {
    throw new RuntimeHostManagedDeploymentError(
      kind === 'config' ? 'invalid_config' : 'invalid_fence',
      'The Runtime Host managed deployment ' + kind + ' must be a bounded regular file',
    );
  }
  try {
    const contents = await readFile(path, 'utf8');
    if (Buffer.byteLength(contents, 'utf8') > MAX_DOCUMENT_BYTES) {
      throw new RuntimeHostManagedDeploymentError(
        kind === 'config' ? 'invalid_config' : 'invalid_fence',
        'The Runtime Host managed deployment ' + kind + ' exceeds its size limit',
      );
    }
    return JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof RuntimeHostManagedDeploymentError) throw error;
    throw new RuntimeHostManagedDeploymentError(
      kind === 'config' ? 'invalid_config' : 'invalid_fence',
      'The Runtime Host managed deployment ' + kind + ' is not valid JSON',
      { cause: error },
    );
  }
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const contents = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(contents, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new RuntimeHostManagedDeploymentError(
      'deployment_io_failed',
      'The Runtime Host managed deployment document exceeds its size limit',
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
    throw deploymentIo('Unable to publish the Runtime Host managed deployment document', error);
  } finally {
    if (!published) await rm(temporaryPath, { force: true });
  }
}

async function removePrivateJson(path: string): Promise<void> {
  try {
    await unlink(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw deploymentIo('Unable to remove the Runtime Host lifecycle fence', error);
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
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
