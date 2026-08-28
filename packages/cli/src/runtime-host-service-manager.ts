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

import { createHash, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { realpathSync } from 'node:fs';
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  unlink,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  canonicalProjectDirectoryRootSpec,
  isCanonicalRuntimeHostWebSocketPath,
  PROJECT_DIRECTORY_MAX_ROOTS,
  projectDirectoryRootSpecValid,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import {
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
} from '@maka/runtime-host/client';
import {
  resolveRuntimeHostManagedServiceId,
  RUNTIME_HOST_SERVICE_LOG_MAX_BYTES,
} from '@maka/runtime-host/operator';
import {
  withLegacyFileUpdateLockLease,
  withProcessLifetimeFileUpdateLock,
} from '@maka/storage/process-lifetime-file-update-lock';
import {
  resolveExistingStorageRoot,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
  type StorageRootCapability,
} from '@maka/storage/root-authority';
import {
  isRuntimeHostManagedDeploymentCli,
  removeRuntimeHostManagedDeployment,
  resolveExistingRuntimeHostManagedDeploymentRoot,
  resolveRuntimeHostManagedDeploymentForCli,
  resolveRuntimeHostManagedDeploymentRoot,
} from './runtime-host-managed-deployment.js';
import { writeRuntimeHostManagedUpdatePolicy } from './runtime-host-update-policy-store.js';
import { isTemporaryNpxInstallation } from './runtime-host-cli-installation.js';

const SERVICE_CONFIG_FILE = 'runtime-host-service.json';
const SERVICE_LIFECYCLE_LOCK_FILE = 'runtime-host-setup';
const SERVICE_DEPLOYMENT_LOCK_FILE = 'runtime-host-deployment';
const DEFAULT_WEBSOCKET_PATH = '/runtime-host';
const SERVICE_OPERATION_LOCK_TIMEOUT_MS = 60_000;
const SERVICE_READY_TIMEOUT_MS = 45_000;
const SERVICE_READY_POLL_MS = 50;

export interface RuntimeHostManagedServiceConfig {
  readonly schemaVersion: 1 | 2;
  readonly managedDeploymentRoot?: string;
  readonly rootPath: string;
  readonly projectDirectoryRoots: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly websocket: {
    readonly host: '127.0.0.1';
    readonly port: number;
    readonly path: string;
  };
  readonly launch: {
    readonly nodePath: string;
    readonly cliPath: string;
  };
}

export type RuntimeHostServiceState =
  | 'not_installed'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'failed';

export interface RuntimeHostServiceObservedStatus {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: RuntimeHostServiceState;
  readonly pid: number | null;
  readonly lastExitCode: number | null;
}

export interface RuntimeHostServiceBackendStatus extends RuntimeHostServiceObservedStatus {
  readonly manager: 'systemd_user' | 'launch_agent';
}

export interface RuntimeHostServiceBackend {
  preflightDeployment(): Promise<void>;
  stageDeployment(): Promise<RuntimeHostServiceDeployment>;
  /** A rejected replacement must restore the previous deployment or report update_incomplete. */
  replace(config: RuntimeHostManagedServiceConfig): Promise<void>;
  /** Reject partial or drifted scheduler state before replacement begins. */
  verifyReplacementPreconditions(config: RuntimeHostManagedServiceConfig): Promise<void>;
  /** Verify the deployment definition and, when requested, its scheduler readiness. */
  verifyDeployment(
    config: RuntimeHostManagedServiceConfig,
    options?: {
      readonly requireSchedulerReady?: boolean;
      readonly acceptLegacyConfigLaunch?: boolean;
    },
  ): Promise<void>;
  status(): Promise<RuntimeHostServiceBackendStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Stop only the Runtime Host process while preserving deployment scheduling. */
  retire(): Promise<void>;
  logs(): Promise<string>;
  uninstall(): Promise<void>;
}

export interface RuntimeHostServiceDeployment {
  apply(config: RuntimeHostManagedServiceConfig, activate: boolean): Promise<void>;
  rollback(): Promise<void>;
}

export interface RuntimeHostManagedServiceStatus extends RuntimeHostServiceObservedStatus {
  readonly manager: 'systemd_user' | 'launch_agent' | 'on_demand' | 'none';
  readonly config: RuntimeHostManagedServiceConfig | null;
  readonly installedVersion: string | null;
  readonly lifecycle?: {
    readonly mode: 'on_demand' | 'supervised';
    readonly availability: 'activation' | 'session' | 'environment' | 'machine';
    readonly provider?: 'systemd_user' | 'launch_agent' | 'openrc_user' | 'openrc_system';
  };
  readonly reconciliation?: {
    readonly trigger: 'manual' | 'activation' | 'scheduled';
    readonly provider?: 'systemd_timer' | 'launch_agent_timer' | 'openrc_supervised_loop';
  };
}

export type RuntimeHostManagedServiceAction =
  | 'install'
  | 'configure'
  | 'status'
  | 'start'
  | 'stop'
  | 'restart'
  | 'retire'
  | 'logs'
  | 'uninstall';

export type RuntimeHostRetirementResult =
  | { readonly kind: 'active_tasks' }
  | {
      readonly kind: 'retired';
      readonly hostEpoch: string;
      readonly pid: number;
    }
  | { readonly kind: 'stopped' };

interface RuntimeHostManagedServiceResultBase {
  readonly schemaVersion: 1;
  readonly service: RuntimeHostManagedServiceStatus;
  readonly retainedStateRoot?: string;
  readonly logs?: string;
}

export type RuntimeHostManagedServiceResult =
  | (RuntimeHostManagedServiceResultBase & {
      readonly action: 'retire';
      readonly retirement: RuntimeHostRetirementResult;
    })
  | (RuntimeHostManagedServiceResultBase & {
      readonly action: 'configure';
      readonly configuration: { readonly kind: 'unchanged' | 'configured' | 'active_tasks' };
      readonly retirement?: never;
    })
  | (RuntimeHostManagedServiceResultBase & {
      readonly action: 'uninstall';
      readonly retirement: RuntimeHostRetirementResult;
      readonly configuration?: never;
    })
  | (RuntimeHostManagedServiceResultBase & {
      readonly action: Exclude<
        RuntimeHostManagedServiceAction,
        'retire' | 'configure' | 'uninstall'
      >;
      readonly retirement?: never;
      readonly configuration?: never;
    });

export interface RuntimeHostManagedServiceInput {
  readonly action: RuntimeHostManagedServiceAction;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly retainManagedDeployment?: boolean;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
  readonly expectedConfigFingerprint?: string;
  readonly allowInterruptActiveTasks?: boolean;
}

export interface RuntimeHostManagedServiceTarget {
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
  readonly deploymentId?: string;
}

export interface RuntimeHostManagedDeploymentCleanupInput {
  readonly clientDataRoot: string;
  readonly cliPath: string;
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
}

export interface RuntimeHostManagedServiceReplacementInput
  extends Omit<RuntimeHostManagedServiceInput, 'action' | 'expectedTarget'> {
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
}

interface RuntimeHostServiceManagerDeps {
  readonly allocateLoopbackPort: () => Promise<number>;
  readonly waitForReady: (
    config: RuntimeHostManagedServiceConfig,
    backend: RuntimeHostServiceBackend,
  ) => Promise<void>;
  readonly prepareRetirement: (
    config: RuntimeHostManagedServiceConfig,
    expectedPid: number,
    allowInterruptActiveTasks: boolean,
  ) => Promise<
    | { readonly kind: 'active_tasks' }
    | {
        readonly kind: 'prepared';
        readonly hostEpoch: string;
        readonly pid: number;
      }
  >;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
}

export type RuntimeHostServiceManagerOverrides = Partial<RuntimeHostServiceManagerDeps>;

export class RuntimeHostServiceManagerError extends Error {
  constructor(
    readonly code:
      | 'unsupported_platform'
      | 'service_manager_unavailable'
      | 'linger_disabled'
      | 'not_installed'
      | 'invalid_config'
      | 'invalid_launch'
      | 'target_mismatch'
      | 'configuration_changed'
      | 'configuration_incomplete'
      | 'retirement_failed'
      | 'update_requires_retirement'
      | 'update_incomplete'
      | 'service_manager_operation_failed'
      | 'uninstall_incomplete',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostServiceManagerError';
  }
}

function runtimeHostServiceManagerDeps(
  overrides: Partial<RuntimeHostServiceManagerDeps>,
): RuntimeHostServiceManagerDeps {
  return {
    allocateLoopbackPort,
    waitForReady: verifyRuntimeHostManagedServiceReady,
    prepareRetirement: prepareRuntimeHostRetirement,
    environment: process.env,
    homeDir: homedir(),
    platform: process.platform,
    ...overrides,
  };
}

export async function manageRuntimeHostService(
  input: RuntimeHostManagedServiceInput,
  backend: RuntimeHostServiceBackend,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostManagedServiceResult> {
  const deps = runtimeHostServiceManagerDeps(overrides);
  const configPath = resolveRuntimeHostManagedServiceConfigPath(input.clientDataRoot);
  const configDirectory = dirname(configPath);
  if (input.action === 'status' && !(await isExistingDirectory(configDirectory))) {
    return manageRuntimeHostServiceLocked(input, backend, deps, configPath);
  }
  await mkdir(configDirectory, { recursive: true, mode: 0o700 });

  return withProcessLifetimeFileUpdateLock(
    configPath,
    () => manageRuntimeHostServiceLocked(input, backend, deps, configPath),
    SERVICE_OPERATION_LOCK_TIMEOUT_MS,
  );
}

export async function withRuntimeHostManagedServiceLifecycleLock<T>(
  clientDataRoot: string,
  operation: () => Promise<T>,
  timeoutMs = SERVICE_OPERATION_LOCK_TIMEOUT_MS,
): Promise<T> {
  await mkdir(clientDataRoot, { recursive: true, mode: 0o700 });
  return withProcessLifetimeFileUpdateLock(
    join(clientDataRoot, SERVICE_LIFECYCLE_LOCK_FILE),
    operation,
    timeoutMs,
  );
}

export async function withRuntimeHostManagedServiceDeploymentLock<T>(
  clientDataRoot: string,
  operation: () => Promise<T>,
  timeoutMs = SERVICE_OPERATION_LOCK_TIMEOUT_MS,
): Promise<T> {
  await mkdir(clientDataRoot, { recursive: true, mode: 0o700 });
  return withProcessLifetimeFileUpdateLock(
    join(clientDataRoot, SERVICE_DEPLOYMENT_LOCK_FILE),
    operation,
    timeoutMs,
  );
}

export async function withRuntimeHostManagedServiceLegacyOperatorLeases<T>(
  clientDataRoot: string,
  operation: (inheritedFds: readonly number[]) => Promise<T>,
  timeoutMs = SERVICE_OPERATION_LOCK_TIMEOUT_MS,
): Promise<T> {
  const configPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  return withLegacyFileUpdateLockLease(
    join(clientDataRoot, SERVICE_LIFECYCLE_LOCK_FILE),
    (lifecycleFd) =>
      withLegacyFileUpdateLockLease(
        configPath,
        (configFd) => operation([lifecycleFd, configFd]),
        timeoutMs,
      ),
    timeoutMs,
  );
}

export async function replaceRuntimeHostManagedService(
  input: RuntimeHostManagedServiceReplacementInput,
  backend: RuntimeHostServiceBackend,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostManagedServiceStatus> {
  const deps = runtimeHostServiceManagerDeps(overrides);
  const configPath = resolveRuntimeHostManagedServiceConfigPath(input.clientDataRoot);
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  return withProcessLifetimeFileUpdateLock(
    configPath,
    () => replaceRuntimeHostManagedServiceLocked(input, backend, deps, configPath),
    SERVICE_OPERATION_LOCK_TIMEOUT_MS,
  );
}

export async function cleanupRuntimeHostManagedDeployment(
  input: RuntimeHostManagedDeploymentCleanupInput,
  backend: RuntimeHostServiceBackend,
): Promise<void> {
  await withRuntimeHostManagedServiceLifecycleLock(input.clientDataRoot, async () => {
    const configPath = resolveRuntimeHostManagedServiceConfigPath(input.clientDataRoot);
    await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
    await withProcessLifetimeFileUpdateLock(
      configPath,
      async () => {
        const serviceId = resolveRuntimeHostManagedServiceId(input.clientDataRoot);
        assertExpectedServiceIdentity(serviceId, input.expectedTarget);
        const service = await readServiceStatus(configPath, backend);
        if (service.installed || service.active || service.enabled || service.config !== null) {
          throw new RuntimeHostServiceManagerError(
            'uninstall_incomplete',
            'Runtime Host service was installed again; refusing to remove its managed deployment',
          );
        }
        const deploymentRoot = resolveRuntimeHostManagedDeploymentForCli(serviceId, input.cliPath);
        if (!deploymentRoot) {
          throw new RuntimeHostServiceManagerError(
            'invalid_launch',
            'The Runtime Host operator does not belong to the expected managed deployment',
          );
        }
        await removeRuntimeHostManagedDeployment(deploymentRoot, serviceId);
      },
      SERVICE_OPERATION_LOCK_TIMEOUT_MS,
    );
  });
}

async function manageRuntimeHostServiceLocked(
  input: RuntimeHostManagedServiceInput,
  backend: RuntimeHostServiceBackend,
  deps: RuntimeHostServiceManagerDeps,
  configPath: string,
): Promise<RuntimeHostManagedServiceResult> {
  const serviceId = resolveRuntimeHostManagedServiceId(input.clientDataRoot);
  if (input.expectedTarget) assertExpectedServiceIdentity(serviceId, input.expectedTarget);
  if (input.action === 'install') {
    const previous = await readServiceConfigForRepair(configPath);
    const expectedRoot = await resolveExpectedServiceRoot(previous, input);
    await backend.preflightDeployment();
    const config = await prepareServiceConfig(
      expectedRoot ? { ...input, rootPath: expectedRoot.canonicalPath } : input,
      previous,
      deps,
    );
    if (
      previous &&
      input.projectDirectoryRoots !== undefined &&
      !sameProjectDirectoryRoots(previous, config)
    ) {
      throw new RuntimeHostServiceManagerError(
        'configuration_changed',
        'An existing Runtime Host Project root policy must be changed through the configuration workflow',
      );
    }
    await deployRuntimeHostServiceConfiguration({
      backend,
      deps,
      configPath,
      previous,
      desired: config,
      activate: true,
    });
    return result(input.action, await readServiceStatus(configPath, backend));
  }

  if (input.action === 'status') {
    const service = await readServiceStatus(configPath, backend);
    await resolveExpectedServiceRoot(service.config, input);
    if (service.installed && service.config?.schemaVersion === 2) {
      await backend.verifyDeployment(service.config);
    }
    return result(input.action, service);
  }

  if (input.action === 'uninstall') {
    if (!input.expectedTarget) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Runtime Host uninstall requires the expected managed service identity',
      );
    }
    const { config: before, invalid: invalidConfig } =
      await readServiceConfigForUninstall(configPath);
    const retirementRoot =
      before === null && !invalidConfig
        ? undefined
        : await resolveExpectedServiceRoot(before, input);
    const retainedStateRoot =
      before === null && !invalidConfig && input.expectedTarget
        ? input.expectedTarget.rootPath
        : retirementRoot?.canonicalPath;
    let retirement: RuntimeHostRetirementResult = { kind: 'stopped' };
    const beforeStatus: RuntimeHostManagedServiceStatus = {
      ...(await backend.status()),
      config: before,
      installedVersion: before ? await readInstalledVersion(before.launch.cliPath) : null,
    };
    if (beforeStatus.installed && before && retirementRoot) {
      const retired = await retireManagedRuntimeHostService(
        { ...beforeStatus, config: before },
        retirementRoot,
        backend,
        deps,
        input.allowInterruptActiveTasks ?? false,
      );
      retirement = retired.retirement;
      if (retirement.kind === 'active_tasks') {
        return {
          schemaVersion: 1,
          action: input.action,
          service: beforeStatus,
          retirement,
          ...(retainedStateRoot ? { retainedStateRoot } : {}),
        };
      }
    }
    const managedDeploymentRoot =
      before?.managedDeploymentRoot ??
      resolveRuntimeHostManagedDeploymentForCli(serviceId, input.cliPath);
    let policyDeploymentRoot: string | undefined;
    try {
      policyDeploymentRoot = await resolveExistingRuntimeHostManagedDeploymentRoot(
        managedDeploymentRoot ??
          resolveRuntimeHostManagedDeploymentRoot(serviceId, {
            env: deps.environment,
            homeDir: deps.homeDir,
            platform: deps.platform,
          }),
        serviceId,
      );
    } catch (error) {
      throw new RuntimeHostServiceManagerError(
        'uninstall_incomplete',
        'Unable to safely inspect the managed Runtime Host deployment before revoking automatic update policy',
        { cause: error },
      );
    }
    if (!policyDeploymentRoot && invalidConfig && !managedDeploymentRoot) {
      throw new RuntimeHostServiceManagerError(
        'uninstall_incomplete',
        'Unable to confirm automatic update policy revocation because the service config is invalid and its managed deployment could not be located',
      );
    }
    if (policyDeploymentRoot) {
      await writeRuntimeHostManagedUpdatePolicy(policyDeploymentRoot, null);
    }
    await backend.uninstall();
    await removeRuntimeHostServiceFile(configPath, 'service config');
    if (managedDeploymentRoot && !input.retainManagedDeployment) {
      try {
        await removeRuntimeHostManagedDeployment(managedDeploymentRoot, serviceId);
      } catch (error) {
        throw new RuntimeHostServiceManagerError(
          'uninstall_incomplete',
          `Unable to remove the managed Runtime Host deployment at ${managedDeploymentRoot}`,
          { cause: error },
        );
      }
    }
    const service = await readServiceStatus(configPath, backend);
    if (service.installed || service.active || service.enabled || service.config !== null) {
      throw new RuntimeHostServiceManagerError(
        'uninstall_incomplete',
        `Runtime Host service still has managed state: ${service.state}`,
      );
    }
    return {
      schemaVersion: 1,
      action: input.action,
      service,
      retirement,
      ...((before?.rootPath ?? retainedStateRoot)
        ? { retainedStateRoot: before?.rootPath ?? retainedStateRoot }
        : {}),
    };
  }

  if (input.action === 'logs') {
    const service = await readServiceStatus(configPath, backend);
    await resolveExpectedServiceRoot(service.config, input);
    const logs = truncateUtf8(await backend.logs(), RUNTIME_HOST_SERVICE_LOG_MAX_BYTES);
    return result(input.action, service, undefined, logs);
  }
  if (input.action === 'configure') {
    if (!input.expectedTarget || input.projectDirectoryRoots === undefined) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Runtime Host configuration requires the expected service identity and a complete Project root policy',
      );
    }
    if (!input.expectedConfigFingerprint) {
      throw new RuntimeHostServiceManagerError(
        'configuration_changed',
        'Runtime Host configuration requires the observed service configuration fingerprint',
      );
    }
    const service = await readServiceStatus(configPath, backend);
    const currentConfig = service.config;
    const root = await resolveExpectedServiceRoot(currentConfig, input);
    if (!service.installed || !currentConfig || !root) {
      throw new RuntimeHostServiceManagerError(
        'not_installed',
        'Runtime Host service is not installed',
      );
    }
    if (
      runtimeHostManagedServiceConfigFingerprint(currentConfig) !== input.expectedConfigFingerprint
    ) {
      throw new RuntimeHostServiceManagerError(
        'configuration_changed',
        'The managed Runtime Host configuration changed; refresh it before applying this edit',
      );
    }
    const desired = await prepareServiceConfig(
      {
        ...input,
        rootPath: currentConfig.rootPath,
        nodePath: currentConfig.launch.nodePath,
        cliPath: currentConfig.launch.cliPath,
      },
      currentConfig,
      deps,
    );
    if (sameProjectDirectoryRoots(currentConfig, desired)) {
      return configurationResult('unchanged', service);
    }
    await backend.preflightDeployment();
    await backend.verifyDeployment(currentConfig, { acceptLegacyConfigLaunch: true });
    const deployment = await backend.stageDeployment();
    const retired = await retireManagedRuntimeHostService(
      { ...service, config: currentConfig },
      root,
      backend,
      deps,
      input.allowInterruptActiveTasks ?? false,
    );
    if (retired.retirement.kind === 'active_tasks') {
      return configurationResult('active_tasks', service);
    }
    try {
      await writeRuntimeHostServiceFile(configPath, `${JSON.stringify(desired, null, 2)}\n`, 0o600);
      await deployment.apply(desired, true);
      await deps.waitForReady(desired, backend);
    } catch (error) {
      await rollbackRuntimeHostConfiguration(
        { configPath, currentConfig, desiredConfig: desired, root, deployment },
        backend,
        deps,
        input.allowInterruptActiveTasks ?? false,
        error,
      );
    }
    return configurationResult('configured', await readServiceStatus(configPath, backend));
  }
  if (input.action === 'retire') {
    if (!input.expectedTarget) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Runtime Host retirement requires the expected managed service identity',
      );
    }
    const service = await readServiceStatus(configPath, backend);
    const currentConfig = service.config;
    const root = await resolveExpectedServiceRoot(currentConfig, input);
    if (!service.installed || !currentConfig || !root) {
      throw new RuntimeHostServiceManagerError(
        'not_installed',
        'Runtime Host service is not installed',
      );
    }
    const retired = await retireManagedRuntimeHostService(
      { ...service, config: currentConfig },
      root,
      backend,
      deps,
      input.allowInterruptActiveTasks ?? false,
    );
    return { schemaVersion: 1, action: input.action, ...retired };
  }
  const config = await readServiceConfig(configPath);
  if (!config) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host service is not installed',
    );
  }
  await resolveExpectedServiceRoot(config, input);
  if (input.action === 'start' || input.action === 'restart') {
    try {
      if (config.schemaVersion === 2) await backend.verifyDeployment(config);
      await backend[input.action]();
      await deps.waitForReady(config, backend);
    } catch (error) {
      try {
        await backend.stop();
      } catch (stopError) {
        throw new RuntimeHostServiceManagerError(
          'service_manager_operation_failed',
          'Starting the Runtime Host managed deployment failed and its partial state could not be stopped',
          { cause: new AggregateError([error, stopError]) },
        );
      }
      throw error;
    }
  } else {
    await backend[input.action]();
  }
  return result(input.action, await readServiceStatus(configPath, backend));
}

async function replaceRuntimeHostManagedServiceLocked(
  input: RuntimeHostManagedServiceReplacementInput,
  backend: RuntimeHostServiceBackend,
  deps: RuntimeHostServiceManagerDeps,
  configPath: string,
): Promise<RuntimeHostManagedServiceStatus> {
  const serviceId = resolveRuntimeHostManagedServiceId(input.clientDataRoot);
  assertExpectedServiceIdentity(serviceId, input.expectedTarget);
  const service = await readServiceStatus(configPath, backend);
  const root = await resolveExpectedServiceRoot(service.config, input);
  if (!service.installed || !service.config || !root) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host service is not installed',
    );
  }
  if (
    service.active ||
    service.pid !== null ||
    (service.state !== 'stopped' && service.state !== 'failed')
  ) {
    throw new RuntimeHostServiceManagerError(
      'update_requires_retirement',
      'Retire the managed Runtime Host service before replacing its package',
    );
  }
  await backend.preflightDeployment();
  const config = await prepareServiceConfig(input, service.config, deps);
  let rootFence: InteractiveRootOwner | undefined =
    await acquireRuntimeHostRootRetirementFence(root);
  try {
    await writeRuntimeHostServiceFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    await releaseRuntimeHostRootRetirementFence(rootFence);
    rootFence = undefined;
  } finally {
    await rootFence?.close().catch(() => undefined);
  }
  try {
    await backend.replace(config);
  } catch (error) {
    if (error instanceof RuntimeHostServiceManagerError && error.code === 'update_incomplete') {
      await backend.retire().catch(() => undefined);
      throw error;
    }
    try {
      await writeRuntimeHostServiceFile(
        configPath,
        `${JSON.stringify(service.config, null, 2)}\n`,
        0o600,
      );
    } catch (restoreError) {
      await backend.retire().catch(() => undefined);
      throw new RuntimeHostServiceManagerError(
        'update_incomplete',
        'Replacing the Runtime Host service failed and its previous configuration could not be restored',
        { cause: new AggregateError([error, restoreError]) },
      );
    }
    throw new RuntimeHostServiceManagerError(
      'update_incomplete',
      'Replacing the Runtime Host service failed; the previous deployment was restored and remains stopped',
      { cause: error },
    );
  }
  try {
    await deps.waitForReady(config, backend);
  } catch (error) {
    try {
      await backend.retire();
    } catch (stopError) {
      throw new RuntimeHostServiceManagerError(
        'update_incomplete',
        'The replacement Runtime Host did not become ready and could not be stopped; inspect the service state before retrying',
        { cause: new AggregateError([error, stopError]) },
      );
    }
    throw new RuntimeHostServiceManagerError(
      'update_incomplete',
      'The replacement Runtime Host did not become ready; the selected deployment was retained but stopped because rolling back across an unknown storage boundary is unsafe',
      { cause: error },
    );
  }
  return readServiceStatus(configPath, backend);
}

function assertExpectedServiceIdentity(
  serviceId: string,
  expectedTarget: RuntimeHostManagedServiceTarget,
): void {
  if (!/^[a-f0-9]{64}$/u.test(expectedTarget.serviceId) || expectedTarget.serviceId !== serviceId) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'The managed Runtime Host service does not match the expected service identity',
    );
  }
}

async function resolveExpectedServiceRoot(
  config: RuntimeHostManagedServiceConfig | null,
  input: Pick<RuntimeHostManagedServiceInput, 'expectedTarget'>,
): Promise<StorageRootCapability<'interactive'> | undefined> {
  if (!input.expectedTarget) return undefined;
  try {
    const root = await resolveExistingStorageRoot({
      path: input.expectedTarget.rootPath,
      kind: 'interactive',
      expectedRootId: input.expectedTarget.rootId,
    });
    if (config && resolve(config.rootPath) !== root.canonicalPath) {
      throw new Error('The service config points to a different State Root path');
    }
    return root;
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'The managed Runtime Host service does not match the expected State Root',
      { cause: error },
    );
  }
}

export function resolveRuntimeHostManagedServiceConfigPath(clientDataRoot: string): string {
  return join(clientDataRoot, SERVICE_CONFIG_FILE);
}

export { resolveRuntimeHostManagedServiceId };

export async function writeRuntimeHostServiceFile(
  path: string,
  contents: string,
  mode: number,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, 'wx', mode);
    try {
      await file.writeFile(contents, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, path);
    await syncRuntimeHostServiceDirectory(directory);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function removeRuntimeHostServiceFile(path: string, label: string): Promise<void> {
  let absent = false;
  try {
    await unlink(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') absent = true;
    else {
      throw new RuntimeHostServiceManagerError(
        'uninstall_incomplete',
        `Unable to remove Runtime Host ${label} at ${path}`,
        { cause: error },
      );
    }
  }
  try {
    await syncRuntimeHostServiceDirectory(dirname(path));
  } catch (error) {
    if (absent && error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new RuntimeHostServiceManagerError(
      'uninstall_incomplete',
      `Unable to persist removal of Runtime Host ${label} at ${path}`,
      { cause: error },
    );
  }
}

async function syncRuntimeHostServiceDirectory(directory: string): Promise<void> {
  const parent = await open(directory, 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
}

export function formatRuntimeHostServiceLogs(
  sources: readonly { readonly label: string; readonly logs: string }[],
): string {
  const present = sources.filter(({ logs }) => logs.length > 0);
  if (present.length === 0) return '';
  const separatorBytes = present.length - 1;
  const sourceBudget = Math.floor(
    (RUNTIME_HOST_SERVICE_LOG_MAX_BYTES - separatorBytes) / present.length,
  );
  return present
    .map(({ label, logs }) => {
      const heading = `${label}:\n`;
      return `${heading}${takeUtf8Tail(logs, sourceBudget - Buffer.byteLength(heading))}`;
    })
    .join('\n');
}

function takeUtf8Tail(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maximumBytes) return value;
  let start = encoded.byteLength - maximumBytes;
  while (start < encoded.byteLength && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString('utf8');
}

async function prepareServiceConfig(
  input: Omit<RuntimeHostManagedServiceInput, 'action'>,
  previous: RuntimeHostManagedServiceConfig | null,
  deps: RuntimeHostServiceManagerDeps,
): Promise<RuntimeHostManagedServiceConfig> {
  if (!input.cliPath) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The current Maka CLI entry point could not be resolved',
    );
  }
  const serviceId = resolveRuntimeHostManagedServiceId(input.clientDataRoot);
  const requestedRoot = resolve(input.rootPath ?? previous?.rootPath ?? input.defaultRootPath);
  const projectDirectoryRoots = await normalizeProjectDirectoryRoots(
    input.projectDirectoryRoots ??
      (previous
        ? effectiveRuntimeHostProjectDirectoryRoots(previous, deps.homeDir)
        : [{ label: '~', path: deps.homeDir }]),
  );
  const [nodePath, cliPath] = await Promise.all([
    realpath(input.nodePath),
    realpath(input.cliPath),
  ]).catch((error) => {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The current Node.js or Maka CLI installation is unavailable',
      { cause: error },
    );
  });
  await assertPersistentCliInstallation(cliPath, deps.environment, deps.homeDir);
  const rootPath = await normalizeStateRoot(requestedRoot);
  const port =
    input.websocketPort ?? previous?.websocket.port ?? (await deps.allocateLoopbackPort());
  const websocketPath = input.websocketPath ?? previous?.websocket.path ?? DEFAULT_WEBSOCKET_PATH;
  const requestedManagedDeploymentRoot =
    previous?.managedDeploymentRoot ??
    resolveRuntimeHostManagedDeploymentForCli(serviceId, cliPath);
  const managedDeploymentRoot = requestedManagedDeploymentRoot
    ? await realpath(requestedManagedDeploymentRoot).catch((error) => {
        throw new RuntimeHostServiceManagerError(
          'invalid_launch',
          'The managed Runtime Host deployment is unavailable',
          { cause: error },
        );
      })
    : undefined;
  if (
    previous?.managedDeploymentRoot &&
    (managedDeploymentRoot !== previous.managedDeploymentRoot ||
      !isRuntimeHostManagedDeploymentCli(previous.managedDeploymentRoot, serviceId, cliPath))
  ) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'Uninstall the managed Runtime Host service before replacing its managed package or launch path',
    );
  }
  if (
    managedDeploymentRoot &&
    !isRuntimeHostManagedDeploymentCli(managedDeploymentRoot, serviceId, cliPath)
  ) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The managed Runtime Host CLI must belong to its deployment root',
    );
  }
  const config: RuntimeHostManagedServiceConfig = {
    schemaVersion: 2,
    ...(managedDeploymentRoot ? { managedDeploymentRoot } : {}),
    rootPath,
    projectDirectoryRoots,
    websocket: { host: '127.0.0.1', port, path: websocketPath },
    launch: { nodePath, cliPath },
  };
  validateServiceConfig(config, serviceId, input.clientDataRoot);
  return config;
}

async function readServiceStatus(
  configPath: string,
  backend: RuntimeHostServiceBackend,
): Promise<RuntimeHostManagedServiceStatus> {
  const [config, backendStatus] = await Promise.all([
    readServiceConfig(configPath),
    backend.status(),
  ]);
  return {
    ...backendStatus,
    config,
    installedVersion: config ? await readInstalledVersion(config.launch.cliPath) : null,
    ...(config
      ? {
          lifecycle: {
            mode: 'supervised' as const,
            availability:
              backendStatus.manager === 'systemd_user'
                ? ('machine' as const)
                : ('session' as const),
            provider: backendStatus.manager === 'systemd_user' ? 'systemd_user' : 'launch_agent',
          },
          reconciliation: config.managedDeploymentRoot
            ? {
                trigger: 'scheduled' as const,
                provider:
                  backendStatus.manager === 'systemd_user'
                    ? ('systemd_timer' as const)
                    : ('launch_agent_timer' as const),
              }
            : { trigger: 'manual' as const },
        }
      : {}),
  };
}

async function readInstalledVersion(cliPath: string): Promise<string | null> {
  try {
    const packageRoot = dirname(dirname(await realpath(cliPath)));
    const manifest: unknown = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    if (
      !isRecord(manifest) ||
      manifest.name !== 'maka-agent' ||
      typeof manifest.version !== 'string' ||
      manifest.version.length === 0 ||
      Buffer.byteLength(manifest.version, 'utf8') > 512
    ) {
      return null;
    }
    return manifest.version;
  } catch {
    return null;
  }
}

async function readServiceConfig(path: string): Promise<RuntimeHostManagedServiceConfig | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const clientDataRoot = dirname(path);
    validateServiceConfig(
      parsed,
      resolveRuntimeHostManagedServiceId(clientDataRoot),
      clientDataRoot,
    );
    return parsed;
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      `Invalid Runtime Host service config at ${path}`,
      { cause: error },
    );
  }
}

export async function readRuntimeHostManagedServiceConfig(
  path: string,
): Promise<RuntimeHostManagedServiceConfig> {
  const config = await readServiceConfig(path);
  if (!config) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host managed service configuration is unavailable',
    );
  }
  return config;
}

async function readServiceConfigForRepair(
  path: string,
): Promise<RuntimeHostManagedServiceConfig | null> {
  try {
    return await readServiceConfig(path);
  } catch (error) {
    if (error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_config') {
      return null;
    }
    throw error;
  }
}

async function readServiceConfigForUninstall(path: string): Promise<{
  readonly config: RuntimeHostManagedServiceConfig | null;
  readonly invalid: boolean;
}> {
  try {
    return { config: await readServiceConfig(path), invalid: false };
  } catch (error) {
    if (error instanceof RuntimeHostServiceManagerError && error.code === 'invalid_config') {
      return { config: null, invalid: true };
    }
    throw error;
  }
}

function validateServiceConfig(
  value: unknown,
  serviceId: string,
  clientDataRoot: string,
): asserts value is RuntimeHostManagedServiceConfig {
  if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)) {
    throw new TypeError('Invalid schemaVersion');
  }
  if (!isSafeAbsolutePath(value.rootPath)) throw new TypeError('Invalid rootPath');
  if (
    !Array.isArray(value.projectDirectoryRoots) ||
    value.projectDirectoryRoots.length > PROJECT_DIRECTORY_MAX_ROOTS
  ) {
    throw new TypeError('Invalid projectDirectoryRoots');
  }
  for (const root of value.projectDirectoryRoots) {
    const canonical =
      isRecord(root) && typeof root.label === 'string' && typeof root.path === 'string'
        ? canonicalProjectDirectoryRootSpec({ label: root.label, path: root.path })
        : undefined;
    if (
      !isRecord(root) ||
      !canonical ||
      root.label !== canonical.label ||
      !projectDirectoryRootSpecValid(canonical) ||
      !isAbsolute(canonical.path)
    ) {
      throw new TypeError('Invalid project directory root');
    }
  }
  if (
    new Set(value.projectDirectoryRoots.map(({ label }) => label)).size !==
    value.projectDirectoryRoots.length
  ) {
    throw new TypeError('Duplicate project directory root label');
  }
  const websocket = value.websocket;
  if (
    !isRecord(websocket) ||
    websocket.host !== '127.0.0.1' ||
    typeof websocket.port !== 'number' ||
    !Number.isInteger(websocket.port) ||
    websocket.port < 1 ||
    websocket.port > 65_535 ||
    !isCanonicalRuntimeHostWebSocketPath(websocket.path)
  ) {
    throw new TypeError('Invalid websocket config');
  }
  if (value.peer !== undefined) throw new TypeError('Legacy peer configuration is unsupported');
  const launch = value.launch;
  if (
    !isRecord(launch) ||
    !isSafeAbsolutePath(launch.nodePath) ||
    !isSafeAbsolutePath(launch.cliPath)
  ) {
    throw new TypeError('Invalid launch config');
  }
  if (
    value.managedDeploymentRoot !== undefined &&
    (typeof value.managedDeploymentRoot !== 'string' ||
      !isRuntimeHostManagedDeploymentCli(value.managedDeploymentRoot, serviceId, launch.cliPath))
  ) {
    throw new TypeError('Invalid managed deployment root');
  }
}

async function normalizeStateRoot(requestedRoot: string): Promise<string> {
  try {
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
    const canonical = await realpath(requestedRoot);
    if (!(await stat(canonical)).isDirectory()) throw new Error('State Root is not a directory');
    return canonical;
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      `Invalid Runtime Host State Root: ${requestedRoot}`,
      { cause: error },
    );
  }
}

export async function resolveRuntimeHostManagedStateRoot(requestedRoot: string): Promise<string> {
  return normalizeStateRoot(requestedRoot);
}

async function normalizeProjectDirectoryRoots(
  roots: readonly { readonly label: string; readonly path: string }[],
): Promise<readonly { readonly label: string; readonly path: string }[]> {
  let canonicalRoots: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  try {
    canonicalRoots = await Promise.all(
      roots.map(async ({ label, path }) => {
        const canonical = await realpath(path);
        if (!(await stat(canonical)).isDirectory()) {
          throw new Error(`Project root is not a directory: ${path}`);
        }
        return { label, path: canonical };
      }),
    );
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      'A configured Project root is unavailable or is not a directory',
      { cause: error },
    );
  }
  if (new Set(canonicalRoots.map(({ path }) => path)).size !== canonicalRoots.length) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      'Configured Project roots must resolve to distinct directories',
    );
  }
  return canonicalRoots;
}

export async function resolveRuntimeHostManagedProjectDirectoryRoots(
  roots: readonly { readonly label: string; readonly path: string }[],
): Promise<readonly { readonly label: string; readonly path: string }[]> {
  return normalizeProjectDirectoryRoots(roots);
}

async function assertPersistentCliInstallation(
  cliPath: string,
  environment: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<void> {
  if (await isTemporaryNpxInstallation(cliPath, { environment, homeDir })) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'A persistent Runtime Host service cannot use a temporary npx installation; install Maka globally and retry',
    );
  }
}

export async function verifyRuntimeHostManagedServiceReady(
  config: RuntimeHostManagedServiceConfig,
  backend: RuntimeHostServiceBackend,
): Promise<void> {
  await backend.verifyDeployment(config, { requireSchedulerReady: true });
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  let lastFailure = 'not available';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const connected = await connectExistingRuntimeHost({
      rootPath: config.rootPath,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      connectTimeoutMs: Math.max(1, Math.min(500, remaining)),
      handshakeTimeoutMs: Math.max(1, Math.min(500, remaining)),
    }).catch((error: unknown) => {
      lastFailure = error instanceof Error ? error.message : String(error);
      return undefined;
    });
    if (connected?.kind === 'connected') {
      try {
        const status = await connected.connection.status(Math.max(1, remaining));
        if (status.state === 'ready') {
          const [diagnostics, service] = await Promise.all([
            connected.connection.request('host.diagnostics.query', {}),
            backend.status(),
          ]);
          if (service.active && service.pid !== null && diagnostics.pid === service.pid) return;
          lastFailure = 'ready Host does not belong to the managed service process';
        } else {
          lastFailure = `Host state is ${status.state}`;
        }
      } catch (error) {
        lastFailure = error instanceof Error ? error.message : String(error);
      } finally {
        await connected.connection.close().catch(() => undefined);
      }
    } else if (connected) {
      lastFailure = connected.kind;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SERVICE_READY_POLL_MS));
  }
  throw new RuntimeHostServiceManagerError(
    'service_manager_operation_failed',
    `Runtime Host service did not become ready: ${lastFailure}`,
  );
}

async function prepareRuntimeHostRetirement(
  config: RuntimeHostManagedServiceConfig,
  expectedPid: number,
  allowInterruptActiveTasks: boolean,
): Promise<
  | { readonly kind: 'active_tasks' }
  | {
      readonly kind: 'prepared';
      readonly hostEpoch: string;
      readonly pid: number;
    }
> {
  const connected = await connectExistingRuntimeHost({
    rootPath: config.rootPath,
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION,
      max: RUNTIME_HOST_PROTOCOL_VERSION,
    },
  }).catch((error: unknown) => {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      'Unable to connect to the managed Runtime Host before retirement',
      { cause: error },
    );
  });
  if (connected.kind !== 'connected') {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      `Managed Runtime Host cannot prepare for retirement: ${connected.kind}`,
    );
  }
  const hostEpoch = connected.connection.hostEpoch;
  try {
    const diagnostics = await connected.connection.request('host.diagnostics.query', {});
    if (diagnostics.pid !== expectedPid) {
      throw new RuntimeHostServiceManagerError(
        'retirement_failed',
        'The State Root is owned by a different Runtime Host process',
      );
    }
    const prepared = await prepareConnectedRuntimeHostRetirement(
      connected.connection,
      allowInterruptActiveTasks ? 'interrupt_active_work' : 'refuse_active_work',
    );
    if (prepared.kind === 'active_tasks') return prepared;
    if (prepared.pid !== expectedPid) {
      throw new RuntimeHostServiceManagerError(
        'retirement_failed',
        'Runtime Host process identity changed while preparing retirement',
      );
    }
    return { ...prepared, hostEpoch };
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      'Managed Runtime Host could not prepare for retirement',
      { cause: error },
    );
  } finally {
    await connected.connection.close().catch(() => undefined);
  }
}

async function verifyRuntimeHostRootReleased(
  root: StorageRootCapability<'interactive'>,
): Promise<void> {
  try {
    const owner = await tryAcquireInteractiveRootOwner(root);
    if (!owner) {
      throw new Error('The State Root writer is still held');
    }
    await owner.close();
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      'Runtime Host retirement did not release the State Root writer',
      { cause: error },
    );
  }
}

async function acquireRuntimeHostRootRetirementFence(
  root: StorageRootCapability<'interactive'>,
): Promise<InteractiveRootOwner> {
  try {
    const owner = await tryAcquireInteractiveRootOwner(root);
    if (!owner) throw new Error('The State Root writer changed while retirement was starting');
    return owner;
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      'The State Root acquired a writer before retirement could stop the Runtime Host service',
      { cause: error },
    );
  }
}

async function acquirePreparedRuntimeHostRootRetirementFence(
  root: StorageRootCapability<'interactive'>,
  expectedPid: number,
  backend: RuntimeHostServiceBackend,
): Promise<InteractiveRootOwner> {
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const owner = await tryAcquireInteractiveRootOwner(root);
    const status = await backend.status();
    if (
      status.pid !== expectedPid &&
      !(status.pid === null && !status.active && status.state === 'stopped')
    ) {
      await owner?.close().catch(() => undefined);
      throw new RuntimeHostServiceManagerError(
        'retirement_failed',
        'Runtime Host service identity changed before retirement could stop the prepared Host',
      );
    }
    if (owner) return owner;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SERVICE_READY_POLL_MS));
  }
  throw new RuntimeHostServiceManagerError(
    'retirement_failed',
    'The prepared Runtime Host did not release the State Root writer before retirement timed out',
  );
}

async function retireManagedRuntimeHostService(
  service: RuntimeHostManagedServiceStatus & { readonly config: RuntimeHostManagedServiceConfig },
  root: StorageRootCapability<'interactive'>,
  backend: RuntimeHostServiceBackend,
  deps: RuntimeHostServiceManagerDeps,
  allowInterruptActiveTasks: boolean,
): Promise<{
  readonly service: RuntimeHostManagedServiceStatus;
  readonly retirement: RuntimeHostRetirementResult;
}> {
  let prepared: { readonly hostEpoch: string; readonly pid: number } | undefined;
  let rootFence: InteractiveRootOwner | undefined;
  if (service.pid !== null) {
    const retirement = await deps.prepareRetirement(
      service.config,
      service.pid,
      allowInterruptActiveTasks,
    );
    if (retirement.kind === 'active_tasks') return { service, retirement };
    prepared = retirement;
    rootFence = await acquirePreparedRuntimeHostRootRetirementFence(root, prepared.pid, backend);
  } else if (service.active) {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      'Managed Runtime Host service did not report its process identity',
    );
  } else if (service.state === 'starting') {
    rootFence = await acquireRuntimeHostRootRetirementFence(root);
  }
  try {
    await backend.retire();
    const stopped: RuntimeHostManagedServiceStatus = {
      ...(await backend.status()),
      config: service.config,
      installedVersion: service.installedVersion,
    };
    if (stopped.active || stopped.state !== 'stopped' || stopped.pid !== null) {
      throw new RuntimeHostServiceManagerError(
        'retirement_failed',
        'Runtime Host service did not reach a stable stopped state after retirement',
      );
    }
    if (rootFence) {
      await releaseRuntimeHostRootRetirementFence(rootFence);
      rootFence = undefined;
    } else {
      await verifyRuntimeHostRootReleased(root);
    }
    return {
      service: stopped,
      retirement: prepared
        ? { kind: 'retired', hostEpoch: prepared.hostEpoch, pid: prepared.pid }
        : { kind: 'stopped' },
    };
  } finally {
    await rootFence?.close().catch(() => undefined);
  }
}

async function releaseRuntimeHostRootRetirementFence(owner: InteractiveRootOwner): Promise<void> {
  try {
    await owner.close();
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'retirement_failed',
      'Runtime Host retirement did not release the State Root writer fence',
      { cause: error },
    );
  }
}

async function deployRuntimeHostServiceConfiguration(input: {
  readonly backend: RuntimeHostServiceBackend;
  readonly deps: RuntimeHostServiceManagerDeps;
  readonly configPath: string;
  readonly previous: RuntimeHostManagedServiceConfig | null;
  readonly desired: RuntimeHostManagedServiceConfig;
  readonly activate: boolean;
}): Promise<void> {
  const deployment = await input.backend.stageDeployment();
  try {
    await writeRuntimeHostServiceFile(
      input.configPath,
      `${JSON.stringify(input.desired, null, 2)}\n`,
      0o600,
    );
    await deployment.apply(input.desired, input.activate);
    if (input.activate) await input.deps.waitForReady(input.desired, input.backend);
  } catch (error) {
    const revision = await identifyRuntimeHostServiceConfigRevision(
      input.configPath,
      input.previous,
      input.desired,
    );
    if (revision === 'current') throw error;
    if (revision === 'unknown') {
      try {
        await quiesceRuntimeHostServiceForConfigRollback(input.backend);
      } catch (rollbackError) {
        throw new RuntimeHostServiceManagerError(
          'service_manager_operation_failed',
          'Runtime Host service deployment failed with an uncertain configuration and its process could not be stopped',
          { cause: new AggregateError([error, rollbackError]) },
        );
      }
      throw new RuntimeHostServiceManagerError(
        'service_manager_operation_failed',
        'Runtime Host service deployment failed with an uncertain configuration; its process was stopped for inspection',
        { cause: error },
      );
    }
    await rollbackDeployment(
      deployment,
      input.backend,
      { configPath: input.configPath, previous: input.previous },
      error,
    );
  }
}

async function rollbackDeployment(
  deployment: RuntimeHostServiceDeployment,
  backend: RuntimeHostServiceBackend,
  configRollback: {
    readonly configPath: string;
    readonly previous: RuntimeHostManagedServiceConfig | null;
  },
  originalError: unknown,
): Promise<void> {
  const rollbackErrors: unknown[] = [];
  try {
    await quiesceRuntimeHostServiceForConfigRollback(backend);
  } catch (rollbackError) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Runtime Host service installation failed and its candidate process could not be stopped; the candidate configuration was retained',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  try {
    if (configRollback.previous) {
      await writeRuntimeHostServiceFile(
        configRollback.configPath,
        `${JSON.stringify(configRollback.previous, null, 2)}\n`,
        0o600,
      );
    } else {
      await removeRuntimeHostServiceFile(configRollback.configPath, 'service config');
    }
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError);
  }
  if (rollbackErrors.length === 0) {
    try {
      await deployment.rollback();
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  if (rollbackErrors.length > 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Runtime Host service deployment failed and the previous deployment could not be restored',
      { cause: new AggregateError([originalError, ...rollbackErrors]) },
    );
  }
  throw originalError;
}

async function quiesceRuntimeHostServiceForConfigRollback(
  backend: RuntimeHostServiceBackend,
): Promise<void> {
  let status = await backend.status();
  if (status.active || status.pid !== null || status.state === 'starting') {
    await backend.retire();
    status = await backend.status();
  }
  if (
    status.active ||
    status.pid !== null ||
    status.state === 'running' ||
    status.state === 'starting'
  ) {
    throw new Error('The candidate Runtime Host service is still running');
  }
}

async function rollbackRuntimeHostConfiguration(
  input: {
    readonly configPath: string;
    readonly currentConfig: RuntimeHostManagedServiceConfig;
    readonly desiredConfig: RuntimeHostManagedServiceConfig;
    readonly root: StorageRootCapability<'interactive'>;
    readonly deployment: RuntimeHostServiceDeployment;
  },
  backend: RuntimeHostServiceBackend,
  deps: RuntimeHostServiceManagerDeps,
  allowInterruptActiveTasks: boolean,
  originalError: unknown,
): Promise<never> {
  const revision = await identifyRuntimeHostServiceConfigRevision(
    input.configPath,
    input.currentConfig,
    input.desiredConfig,
  );
  if (revision === 'current') {
    try {
      await input.deployment.rollback();
      await backend.start();
      await deps.waitForReady(input.currentConfig, backend);
    } catch (rollbackError) {
      throw new RuntimeHostServiceManagerError(
        'configuration_incomplete',
        'The Runtime Host configuration was not published and the previous Host could not be restarted',
        { cause: new AggregateError([originalError, rollbackError]) },
      );
    }
    throw new RuntimeHostServiceManagerError(
      'configuration_incomplete',
      'The Runtime Host configuration could not be published; the previous configuration was restored',
      { cause: originalError },
    );
  }
  if (revision === 'unknown') {
    try {
      await quiesceRuntimeHostServiceForConfigRollback(backend);
    } catch (rollbackError) {
      throw new RuntimeHostServiceManagerError(
        'configuration_incomplete',
        'The Runtime Host configuration could not be applied, its persisted revision is uncertain, and its process could not be stopped',
        { cause: new AggregateError([originalError, rollbackError]) },
      );
    }
    throw new RuntimeHostServiceManagerError(
      'configuration_incomplete',
      'The Runtime Host configuration could not be applied and its persisted revision is uncertain; the Host remains stopped for inspection',
      { cause: originalError },
    );
  }

  try {
    const candidate = await readServiceStatus(input.configPath, backend);
    const retired = await retireManagedRuntimeHostService(
      { ...candidate, config: input.desiredConfig },
      input.root,
      backend,
      deps,
      allowInterruptActiveTasks,
    );
    if (retired.retirement.kind === 'active_tasks') {
      throw new Error('The candidate Runtime Host accepted active work before rollback');
    }
  } catch (rollbackError) {
    throw new RuntimeHostServiceManagerError(
      'configuration_incomplete',
      'The Runtime Host configuration could not be verified and the candidate Host could not be safely retired; its configuration was retained',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }

  const rollbackErrors: unknown[] = [];
  try {
    await writeRuntimeHostServiceFile(
      input.configPath,
      `${JSON.stringify(input.currentConfig, null, 2)}\n`,
      0o600,
    );
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError);
  }
  if (rollbackErrors.length === 0) {
    try {
      await input.deployment.rollback();
      await backend.start();
      await deps.waitForReady(input.currentConfig, backend);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  throw new RuntimeHostServiceManagerError(
    'configuration_incomplete',
    rollbackErrors.length === 0
      ? 'The Runtime Host configuration could not be applied; the previous configuration was restored'
      : 'The Runtime Host configuration could not be applied or fully restored; inspect the service before retrying',
    {
      cause:
        rollbackErrors.length === 0
          ? originalError
          : new AggregateError([originalError, ...rollbackErrors]),
    },
  );
}

async function identifyRuntimeHostServiceConfigRevision(
  configPath: string,
  current: RuntimeHostManagedServiceConfig | null,
  desired: RuntimeHostManagedServiceConfig,
): Promise<'current' | 'desired' | 'unknown'> {
  let observed: RuntimeHostManagedServiceConfig | null;
  try {
    observed = await readServiceConfig(configPath);
  } catch {
    return 'unknown';
  }
  if (sameRuntimeHostManagedServiceConfig(observed, current)) return 'current';
  if (sameRuntimeHostManagedServiceConfig(observed, desired)) return 'desired';
  return 'unknown';
}

function sameRuntimeHostManagedServiceConfig(
  left: RuntimeHostManagedServiceConfig | null,
  right: RuntimeHostManagedServiceConfig | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Unable to allocate a loopback port'));
        return;
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)));
    });
  });
}

export function allocateRuntimeHostLoopbackPort(): Promise<number> {
  return allocateLoopbackPort();
}

async function allocatePeerPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const socket = createSocket('udp4');
    socket.unref();
    socket.once('error', reject);
    socket.bind({ address: '0.0.0.0', port: 0, exclusive: true }, () => {
      const address = socket.address();
      socket.close();
      resolvePort(address.port);
    });
  });
}

export function allocateRuntimeHostPeerPort(): Promise<number> {
  return allocatePeerPort();
}

function result(
  action: Exclude<RuntimeHostManagedServiceAction, 'retire' | 'configure' | 'uninstall'>,
  service: RuntimeHostManagedServiceStatus,
  retainedStateRoot?: string,
  logs?: string,
): RuntimeHostManagedServiceResult {
  return {
    schemaVersion: 1,
    action,
    service,
    ...(retainedStateRoot ? { retainedStateRoot } : {}),
    ...(logs !== undefined ? { logs } : {}),
  };
}

function configurationResult(
  kind: 'unchanged' | 'configured' | 'active_tasks',
  service: RuntimeHostManagedServiceStatus,
): RuntimeHostManagedServiceResult {
  return { schemaVersion: 1, action: 'configure', service, configuration: { kind } };
}

export function effectiveRuntimeHostProjectDirectoryRoots(
  config: RuntimeHostManagedServiceConfig,
  homeDir = homedir(),
): readonly { readonly label: string; readonly path: string }[] {
  if (config.schemaVersion !== 1 || config.projectDirectoryRoots.length > 0) {
    return config.projectDirectoryRoots;
  }
  try {
    return [{ label: '~', path: realpathSync(homeDir) }];
  } catch {
    return [];
  }
}

export function runtimeHostManagedServiceConfigFingerprint(
  config: RuntimeHostManagedServiceConfig,
): string {
  const canonical = JSON.stringify({
    managedDeploymentRoot: config.managedDeploymentRoot ?? null,
    rootPath: config.rootPath,
    projectDirectoryRoots: effectiveRuntimeHostProjectDirectoryRoots(config),
    websocket: config.websocket,
    launch: config.launch,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function sameProjectDirectoryRoots(
  current: RuntimeHostManagedServiceConfig,
  desired: RuntimeHostManagedServiceConfig,
): boolean {
  return (
    JSON.stringify(effectiveRuntimeHostProjectDirectoryRoots(current)) ===
    JSON.stringify(desired.projectDirectoryRoots)
  );
}

function isSafeAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value) && !hasControlCharacters(value);
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}
