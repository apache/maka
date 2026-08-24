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
import { createServer } from 'node:net';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  isCanonicalRuntimeHostWebSocketPath,
  PROJECT_DIRECTORY_MAX_ROOTS,
  PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import {
  connectExistingRuntimeHost,
  prepareConnectedRuntimeHostRetirement,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_SERVICE_LOG_MAX_BYTES } from '@maka/runtime-host/operator';
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
  resolveRuntimeHostManagedDeploymentForCli,
} from './runtime-host-managed-deployment.js';

const SERVICE_CONFIG_FILE = 'runtime-host-service.json';
const SERVICE_LIFECYCLE_LOCK_FILE = 'runtime-host-setup';
const SERVICE_DEPLOYMENT_LOCK_FILE = 'runtime-host-deployment';
const DEFAULT_WEBSOCKET_PATH = '/runtime-host';
const SERVICE_OPERATION_LOCK_TIMEOUT_MS = 60_000;
const SERVICE_READY_TIMEOUT_MS = 45_000;
const SERVICE_READY_POLL_MS = 50;

export interface RuntimeHostManagedServiceConfig {
  readonly schemaVersion: 1;
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

export interface RuntimeHostServiceBackendStatus {
  readonly manager: 'systemd_user' | 'launch_agent';
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: RuntimeHostServiceState;
  readonly pid: number | null;
  readonly lastExitCode: number | null;
}

export interface RuntimeHostServiceBackend {
  preflightInstall(): Promise<void>;
  install(config: RuntimeHostManagedServiceConfig): Promise<RuntimeHostServiceDeployment>;
  replace(config: RuntimeHostManagedServiceConfig): Promise<void>;
  verifyDeployment(config: RuntimeHostManagedServiceConfig): Promise<void>;
  status(): Promise<RuntimeHostServiceBackendStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  logs(): Promise<string>;
  uninstall(): Promise<void>;
}

export interface RuntimeHostServiceDeployment {
  rollback(): Promise<void>;
}

export interface RuntimeHostManagedServiceStatus extends RuntimeHostServiceBackendStatus {
  readonly config: RuntimeHostManagedServiceConfig | null;
  readonly installedVersion: string | null;
}

export type RuntimeHostManagedServiceAction =
  | 'install'
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
      readonly action: Exclude<RuntimeHostManagedServiceAction, 'retire'>;
      readonly retirement?: never;
    });

export interface RuntimeHostManagedServiceInput {
  readonly action: RuntimeHostManagedServiceAction;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly rootPath?: string;
  readonly projectDirectoryRoots?: readonly { readonly label: string; readonly path: string }[];
  readonly websocketPort?: number;
  readonly websocketPath?: string;
  readonly retainManagedDeployment?: boolean;
  readonly nodePath: string;
  readonly cliPath: string;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
  readonly allowInterruptActiveTasks?: boolean;
}

export interface RuntimeHostManagedServiceTarget {
  readonly serviceId: string;
  readonly rootPath: string;
  readonly rootId: string;
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
    | { readonly kind: 'prepared'; readonly hostEpoch: string; readonly pid: number }
  >;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDir: string;
}

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

export async function manageRuntimeHostService(
  input: RuntimeHostManagedServiceInput,
  backend: RuntimeHostServiceBackend,
  overrides: Partial<RuntimeHostServiceManagerDeps> = {},
): Promise<RuntimeHostManagedServiceResult> {
  const deps: RuntimeHostServiceManagerDeps = {
    allocateLoopbackPort,
    waitForReady: verifyRuntimeHostManagedServiceReady,
    prepareRetirement: prepareRuntimeHostRetirement,
    environment: process.env,
    homeDir: homedir(),
    ...overrides,
  };
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
  const deps: RuntimeHostServiceManagerDeps = {
    allocateLoopbackPort,
    waitForReady: verifyRuntimeHostManagedServiceReady,
    prepareRetirement: prepareRuntimeHostRetirement,
    environment: process.env,
    homeDir: homedir(),
    ...overrides,
  };
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
    await backend.preflightInstall();
    const config = await prepareServiceConfig(
      expectedRoot ? { ...input, rootPath: expectedRoot.canonicalPath } : input,
      previous,
      deps,
    );
    const deployment = await backend.install(config);
    let configWriteStarted = false;
    try {
      await deps.waitForReady(config, backend);
      configWriteStarted = true;
      await writeRuntimeHostServiceFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    } catch (error) {
      await rollbackDeployment(
        deployment,
        configWriteStarted ? { configPath, previous } : null,
        error,
      );
    }
    return result(input.action, await readServiceStatus(configPath, backend));
  }

  if (input.action === 'status') {
    const service = await readServiceStatus(configPath, backend);
    await resolveExpectedServiceRoot(service.config, input);
    return result(input.action, service);
  }

  if (input.action === 'uninstall') {
    const { config: before, invalid: invalidConfig } =
      await readServiceConfigForUninstall(configPath);
    const retainedStateRoot =
      before === null && !invalidConfig && input.expectedTarget
        ? input.expectedTarget.rootPath
        : (await resolveExpectedServiceRoot(before, input))?.canonicalPath;
    const managedDeploymentRoot =
      before?.managedDeploymentRoot ??
      resolveRuntimeHostManagedDeploymentForCli(serviceId, input.cliPath);
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
    return result(input.action, service, before?.rootPath ?? retainedStateRoot);
  }

  if (input.action === 'logs') {
    const service = await readServiceStatus(configPath, backend);
    await resolveExpectedServiceRoot(service.config, input);
    const logs = truncateUtf8(await backend.logs(), RUNTIME_HOST_SERVICE_LOG_MAX_BYTES);
    return result(input.action, service, undefined, logs);
  }
  if (input.action === 'retire') {
    if (!input.expectedTarget) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Runtime Host retirement requires the expected managed service identity',
      );
    }
    const service = await readServiceStatus(configPath, backend);
    const root = await resolveExpectedServiceRoot(service.config, input);
    if (!service.installed || !service.config || !root) {
      throw new RuntimeHostServiceManagerError(
        'not_installed',
        'Runtime Host service is not installed',
      );
    }
    let prepared: { readonly hostEpoch: string; readonly pid: number } | undefined;
    let rootFence: InteractiveRootOwner | undefined;
    if (service.pid !== null) {
      const retirement = await deps.prepareRetirement(
        service.config,
        service.pid,
        input.allowInterruptActiveTasks ?? false,
      );
      if (retirement.kind === 'active_tasks') {
        return { schemaVersion: 1, action: input.action, service, retirement };
      }
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
      await backend.stop();
      const stopped = await readServiceStatus(configPath, backend);
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
        schemaVersion: 1,
        action: input.action,
        service: stopped,
        retirement: prepared
          ? { kind: 'retired', hostEpoch: prepared.hostEpoch, pid: prepared.pid }
          : { kind: 'stopped' },
      };
    } finally {
      await rootFence?.close().catch(() => undefined);
    }
  }
  const config = await readServiceConfig(configPath);
  if (!config) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host service is not installed',
    );
  }
  await resolveExpectedServiceRoot(config, input);
  await backend[input.action]();
  if (input.action === 'start' || input.action === 'restart') {
    try {
      await deps.waitForReady(config, backend);
    } catch (error) {
      await backend.stop().catch(() => undefined);
      throw error;
    }
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
  await backend.preflightInstall();
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
    await deps.waitForReady(config, backend);
  } catch (error) {
    await backend.stop().catch(() => undefined);
    throw new RuntimeHostServiceManagerError(
      'update_incomplete',
      'The replacement Runtime Host did not become ready; the previous deployment was retained but was not restarted because its storage compatibility is unknown',
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

export function resolveRuntimeHostManagedServiceId(clientDataRoot: string): string {
  return createHash('sha256').update(resolve(clientDataRoot)).digest('hex');
}

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
    const parent = await open(directory, 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

export async function removeRuntimeHostServiceFile(path: string, label: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'uninstall_incomplete',
      `Unable to remove Runtime Host ${label} at ${path}`,
      { cause: error },
    );
  }
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
    input.projectDirectoryRoots ?? previous?.projectDirectoryRoots ?? [],
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
    schemaVersion: 1,
    ...(managedDeploymentRoot ? { managedDeploymentRoot } : {}),
    rootPath,
    projectDirectoryRoots,
    websocket: { host: '127.0.0.1', port, path: websocketPath },
    launch: { nodePath, cliPath },
  };
  validateServiceConfig(config, serviceId);
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
    validateServiceConfig(parsed, resolveRuntimeHostManagedServiceId(dirname(path)));
    return parsed;
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      `Invalid Runtime Host service config at ${path}`,
      { cause: error },
    );
  }
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
): asserts value is RuntimeHostManagedServiceConfig {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new TypeError('Invalid schemaVersion');
  if (!isSafeAbsolutePath(value.rootPath)) throw new TypeError('Invalid rootPath');
  if (
    !Array.isArray(value.projectDirectoryRoots) ||
    value.projectDirectoryRoots.length > PROJECT_DIRECTORY_MAX_ROOTS
  ) {
    throw new TypeError('Invalid projectDirectoryRoots');
  }
  for (const root of value.projectDirectoryRoots) {
    if (
      !isRecord(root) ||
      typeof root.label !== 'string' ||
      root.label.length === 0 ||
      Buffer.byteLength(root.label, 'utf8') > PROJECT_DIRECTORY_ROOT_LABEL_MAX_BYTES ||
      hasControlCharacters(root.label) ||
      !isSafeAbsolutePath(root.path)
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

async function normalizeProjectDirectoryRoots(
  roots: readonly { readonly label: string; readonly path: string }[],
): Promise<readonly { readonly label: string; readonly path: string }[]> {
  let canonicalRoots: readonly { readonly label: string; readonly path: string }[];
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

async function assertPersistentCliInstallation(
  cliPath: string,
  environment: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<void> {
  const cacheRoots = await Promise.all(
    [environment.npm_config_cache, join(homeDir, '.npm')].flatMap((root) =>
      root ? [realpath(resolve(root, '_npx')).catch(() => resolve(root, '_npx'))] : [],
    ),
  );
  if (cacheRoots.some((root) => isWithin(root, cliPath))) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'A persistent Runtime Host service cannot use a temporary npx installation; install Maka globally and retry',
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

export async function verifyRuntimeHostManagedServiceReady(
  config: RuntimeHostManagedServiceConfig,
  backend: RuntimeHostServiceBackend,
): Promise<void> {
  await backend.verifyDeployment(config);
  const deadline = Date.now() + SERVICE_READY_TIMEOUT_MS;
  let lastFailure = 'not available';
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const connected = await connectExistingRuntimeHost({
      rootPath: config.rootPath,
      protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
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
            connected.connection.queryHostDiagnostics(),
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
  | { readonly kind: 'prepared'; readonly hostEpoch: string; readonly pid: number }
> {
  const connected = await connectExistingRuntimeHost({
    rootPath: config.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
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
    const diagnostics = await connected.connection.queryHostDiagnostics();
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

async function rollbackDeployment(
  deployment: RuntimeHostServiceDeployment,
  configRollback: {
    readonly configPath: string;
    readonly previous: RuntimeHostManagedServiceConfig | null;
  } | null,
  originalError: unknown,
): Promise<never> {
  const rollbackErrors: unknown[] = [];
  try {
    await deployment.rollback();
  } catch (rollbackError) {
    rollbackErrors.push(rollbackError);
  }
  if (configRollback) {
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

function result(
  action: Exclude<RuntimeHostManagedServiceAction, 'retire'>,
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
