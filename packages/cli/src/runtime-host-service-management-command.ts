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

import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { release } from 'node:os';
import {
  assertRuntimeHostManagedDeploymentAuthorityDurablyAbsent,
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostOperatorCapability,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostServiceSummary,
  type RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import { resolveExistingStorageRoot, tryAcquireStateRootOwner } from '@maka/storage/root-authority';
import {
  cleanupRuntimeHostManagedDeployment,
  effectiveRuntimeHostProjectDirectoryRoots,
  manageRuntimeHostService,
  removeRuntimeHostServiceFile,
  resolveRuntimeHostManagedServiceConfigPath,
  resolveRuntimeHostManagedServiceId,
  runtimeHostManagedServiceConfigFingerprint,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceInput,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import { createLaunchAgentRuntimeHostService } from './runtime-host-launch-agent-service.js';
import { createLaunchAgentRuntimeHostLifecycleProvider } from './runtime-host-launch-agent-service.js';
import {
  createSystemdUserRuntimeHostLifecycleProvider,
  createSystemdUserRuntimeHostService,
} from './runtime-host-systemd-service.js';
import type {
  RuntimeHostLifecycleProvider,
  RuntimeHostLifecycleProviderOffer,
} from './runtime-host-lifecycle-provider.js';
import { manageRuntimeHostManagedLifecycle } from './runtime-host-managed-lifecycle-manager.js';
import {
  acknowledgeRuntimeHostManagedDeploymentCleanup,
  assertRuntimeHostManagedOperatorDeployment,
  clearRuntimeHostManagedDeploymentCleanupReceipt,
  readRuntimeHostManagedDeploymentCleanupReceipt,
  removeRuntimeHostManagedDeployment,
  resolveRuntimeHostManagedControlRoot,
  resolveRuntimeHostManagedDeploymentForCli,
} from './runtime-host-managed-deployment.js';

export interface RuntimeHostServiceManagementCliOptions
  extends Omit<RuntimeHostManagedServiceInput, 'action'> {
  readonly action: RuntimeHostManagedServiceInput['action'];
  readonly json: boolean;
  readonly framed?: boolean;
  readonly managedRootId?: string;
  readonly operatorDeploymentId?: string;
}

export interface RuntimeHostServiceManagementCliDeps {
  readonly manage: typeof manageRuntimeHostService;
  readonly manageLifecycle: typeof manageRuntimeHostManagedLifecycle;
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly withLifecycleLock: typeof withRuntimeHostManagedServiceLifecycleLock;
  readonly createBackend: (serviceId: string, clientDataRoot: string) => RuntimeHostServiceBackend;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

export async function runManagedRuntimeHostServiceCli(
  options: RuntimeHostServiceManagementCliOptions,
  overrides: Partial<RuntimeHostServiceManagementCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostServiceManagementCliDeps = {
    manage: manageRuntimeHostService,
    manageLifecycle: manageRuntimeHostManagedLifecycle,
    withDeploymentLock: withRuntimeHostManagedServiceDeploymentLock,
    withLifecycleLock: withRuntimeHostManagedServiceLifecycleLock,
    createBackend: createPlatformRuntimeHostServiceBackend,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  try {
    if (
      options.managedRootId &&
      options.operatorDeploymentId !== undefined &&
      options.expectedTarget?.deploymentId !== undefined &&
      options.expectedTarget.deploymentId !== options.operatorDeploymentId
    ) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'The managed Runtime Host deployment generation changed before the operation',
      );
    }
    if (
      options.managedRootId &&
      options.action === 'uninstall' &&
      !options.retainManagedDeployment &&
      !options.operatorDeploymentId
    ) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Canonical deployment cleanup must run through its generation-bound operator',
      );
    }
    const { json: _json, framed: _framed, ...input } = options;
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const manage = () =>
      options.managedRootId
        ? deps.manageLifecycle(options.managedRootId, input, {
            resolveProvider: resolveRuntimeHostLifecycleProvider,
            operatorClaim: {
              deploymentId: options.operatorDeploymentId,
              cliPath: options.cliPath,
            },
          })
        : deps.manage(input, deps.createBackend(serviceId, options.clientDataRoot));
    const controlRoot = options.managedRootId
      ? resolveRuntimeHostManagedControlRoot(options.managedRootId)
      : options.clientDataRoot;
    const mutate = () =>
      deps.withDeploymentLock(controlRoot, () =>
        deps.withLifecycleLock(controlRoot, async () => {
          if (options.managedRootId) {
            await assertRuntimeHostManagedOperatorDeployment(
              options.managedRootId,
              options.operatorDeploymentId,
              options.cliPath,
              { allowAbsent: options.action === 'uninstall' },
            );
          }
          return manage();
        }),
      );
    const result =
      options.action === 'status' || options.action === 'logs'
        ? options.managedRootId
          ? await mutate()
          : await manage()
        : await mutate();
    const blocked =
      (result.action === 'retire' && result.retirement.kind === 'active_tasks') ||
      (result.action === 'uninstall' && result.retirement.kind === 'active_tasks') ||
      (result.action === 'configure' && result.configuration.kind === 'active_tasks');
    if (
      options.managedRootId &&
      result.action === 'uninstall' &&
      result.retirement.kind === 'stopped' &&
      !options.retainManagedDeployment &&
      result.retainedStateRoot
    ) {
      await deps.withDeploymentLock(controlRoot, () =>
        deps.withLifecycleLock(controlRoot, () =>
          cleanupCanonicalRuntimeHostManagedDeployment({
            cliPath: options.cliPath,
            clientDataRoot: options.clientDataRoot,
            managedRootId: options.managedRootId!,
            operatorDeploymentId: options.operatorDeploymentId,
            expectedTarget: options.expectedTarget!,
            finalize: false,
          }),
        ),
      );
      await deps.withDeploymentLock(controlRoot, () =>
        deps.withLifecycleLock(controlRoot, () =>
          cleanupCanonicalRuntimeHostManagedDeployment({
            cliPath: options.cliPath,
            clientDataRoot: options.clientDataRoot,
            managedRootId: options.managedRootId!,
            operatorDeploymentId: options.operatorDeploymentId,
            expectedTarget: options.expectedTarget!,
            finalize: true,
          }),
        ),
      );
    }
    if (options.framed) {
      deps.writeOutput(encodeRuntimeHostServiceManagementFrame(successFrame(result)));
    } else if (options.json) {
      deps.writeOutput(`${JSON.stringify({ ...result, ok: !blocked })}\n`);
    } else if (blocked) {
      deps.writeError(formatHumanResult(result));
    } else {
      deps.writeOutput(formatHumanResult(result));
    }
    return blocked ? 1 : 0;
  } catch (error) {
    const code =
      error instanceof RuntimeHostServiceManagerError ? error.code : 'internal_service_error';
    const message = error instanceof Error ? error.message : String(error);
    if (options.framed) {
      deps.writeOutput(
        encodeRuntimeHostServiceManagementFrame({
          schemaVersion: 1,
          kind: 'error',
          action: options.action,
          error: {
            code:
              truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES) ||
              'internal_service_error',
            message:
              truncateUtf8(message, RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES) ||
              'Runtime Host service operation failed',
          },
        }),
      );
    } else if (options.json) {
      deps.writeOutput(
        `${JSON.stringify({ schemaVersion: 1, ok: false, action: options.action, error: { code, message } })}\n`,
      );
    } else {
      deps.writeError(`${message}\n`);
    }
    return 1;
  }
}

export async function runManagedRuntimeHostDeploymentCleanupCli(options: {
  readonly clientDataRoot: string;
  readonly cliPath: string;
  readonly managedRootId?: string;
  readonly operatorDeploymentId?: string;
  readonly finalize?: boolean;
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
}): Promise<number> {
  try {
    if (options.managedRootId) {
      const controlRoot = resolveRuntimeHostManagedControlRoot(options.managedRootId);
      await withRuntimeHostManagedServiceDeploymentLock(controlRoot, () =>
        withRuntimeHostManagedServiceLifecycleLock(controlRoot, () =>
          cleanupCanonicalRuntimeHostManagedDeployment({
            ...options,
            managedRootId: options.managedRootId!,
            finalize: options.finalize ?? false,
          }),
        ),
      );
      return 0;
    }
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    await cleanupRuntimeHostManagedDeployment(
      options,
      createPlatformRuntimeHostServiceBackend(serviceId, options.clientDataRoot),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function cleanupCanonicalRuntimeHostManagedDeployment(options: {
  readonly clientDataRoot: string;
  readonly cliPath: string;
  readonly managedRootId: string;
  readonly operatorDeploymentId?: string;
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
  readonly finalize: boolean;
}): Promise<void> {
  const { managedRootId: rootId, expectedTarget } = options;
  if (expectedTarget.serviceId !== rootId || expectedTarget.rootId !== rootId) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'The managed Runtime Host does not match the expected deployment identity',
    );
  }
  if (
    expectedTarget.deploymentId !== undefined &&
    expectedTarget.deploymentId !== options.operatorDeploymentId
  ) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'The managed Runtime Host deployment generation changed before cleanup',
    );
  }
  const capability = await resolveExistingStorageRoot({
    path: expectedTarget.rootPath,
    kind: 'interactive',
    expectedRootId: rootId,
  });
  const owner = await tryAcquireStateRootOwner(capability);
  if (!owner) {
    throw new RuntimeHostServiceManagerError(
      'uninstall_incomplete',
      'Runtime Host still owns the State Root; refusing to remove its package',
    );
  }
  try {
    await assertRuntimeHostManagedDeploymentAuthorityDurablyAbsent(owner);
    const deploymentRoot = resolveRuntimeHostManagedDeploymentForCli(rootId, options.cliPath);
    if (!deploymentRoot) {
      throw new RuntimeHostServiceManagerError(
        'invalid_launch',
        'The Runtime Host operator does not belong to the expected managed deployment',
      );
    }
    if (!options.operatorDeploymentId) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Canonical deployment cleanup requires a generation-bound operator',
      );
    }
    if (!options.finalize) {
      await acknowledgeRuntimeHostManagedDeploymentCleanup({
        serviceId: rootId,
        deploymentId: options.operatorDeploymentId,
        deploymentRoot,
        stateRootPath: expectedTarget.rootPath,
      });
      return;
    }
    const receipt = await readRuntimeHostManagedDeploymentCleanupReceipt(rootId);
    if (
      !receipt ||
      receipt.deploymentId !== options.operatorDeploymentId ||
      receipt.deploymentRoot !== deploymentRoot
    ) {
      throw new RuntimeHostServiceManagerError(
        'uninstall_incomplete',
        'The managed Runtime Host deployment has not acknowledged cleanup',
      );
    }
    // Canonical peer keys are deployment-scoped, including rotated UUID paths.
    await removeRuntimeHostManagedDeployment(deploymentRoot, rootId);
    await clearRuntimeHostManagedDeploymentCleanupReceipt(rootId);
  } finally {
    await owner.close();
  }
}

function formatHumanResult(result: RuntimeHostManagedServiceResult): string {
  const service = result.service;
  if (result.action === 'uninstall') {
    if (result.retirement.kind === 'active_tasks') {
      return 'Runtime Host service still owns active work. Retry with explicit interruption authority.\n';
    }
    return result.retainedStateRoot
      ? `Runtime Host service is uninstalled. Data was retained at ${result.retainedStateRoot}\n`
      : 'Runtime Host service is uninstalled.\n';
  }
  if (result.action === 'install') {
    return service.active
      ? `Runtime Host service is installed and running at ${websocketUrl(service)}\n`
      : 'Runtime Host service is installed but is not running. Check its status and journal.\n';
  }
  if (result.action === 'configure') {
    return result.configuration.kind === 'active_tasks'
      ? 'Runtime Host service still owns active work. Retry with explicit interruption authority.\n'
      : result.configuration.kind === 'unchanged'
        ? 'Runtime Host Project roots are already configured.\n'
        : 'Runtime Host Project roots were configured.\n';
  }
  if (result.action === 'status') {
    if (!service.installed) return 'Runtime Host service is not installed.\n';
    return `Runtime Host service is ${service.state} at ${websocketUrl(service)}\n`;
  }
  if (result.action === 'retire') {
    return result.retirement.kind === 'active_tasks'
      ? 'Runtime Host service still owns active work. Retry with explicit interruption authority.\n'
      : 'Runtime Host service is retired and its State Root writer is released.\n';
  }
  if (result.action === 'logs') return result.logs || 'No Runtime Host service logs were found.\n';
  return `Runtime Host service is ${service.state}.\n`;
}

function successFrame(result: RuntimeHostManagedServiceResult): RuntimeHostServiceManagementFrame {
  const service = runtimeHostServiceSummary(result);
  const common = {
    schemaVersion: 1,
    kind: 'result',
    service,
    ...requestedOperatorCapabilities(),
    ...(result.retainedStateRoot ? { retainedStateRoot: result.retainedStateRoot } : {}),
    ...(result.logs !== undefined ? { logs: result.logs } : {}),
  } as const;
  if (result.action === 'retire' || result.action === 'uninstall') {
    return {
      ...common,
      action: result.action,
      retirement: { ...result.retirement },
    };
  }
  if (result.action === 'configure') {
    return {
      ...common,
      action: result.action,
      configuration: { ...result.configuration },
    };
  }
  return { ...common, action: result.action };
}

function requestedOperatorCapabilities(): {
  readonly operatorCapabilities?: RuntimeHostOperatorCapability[];
} {
  const capabilities: RuntimeHostOperatorCapability[] = [];
  const requested = process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
  if (
    requested === RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY ||
    requested === RUNTIME_HOST_OPERATOR_PEER_MANAGEMENT_CAPABILITY ||
    requested === RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY
  ) {
    capabilities.push(requested);
  }
  return capabilities.length > 0 ? { operatorCapabilities: capabilities } : {};
}

export function runtimeHostServiceSummary(
  result: RuntimeHostManagedServiceResult,
): RuntimeHostServiceSummary {
  const config = result.service.config;
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    state: result.service.state,
    pid: result.service.pid,
    lastExitCode: result.service.lastExitCode,
    installedVersion: result.service.installedVersion,
    ...(result.service.lifecycle ? { lifecycle: { ...result.service.lifecycle } } : {}),
    ...(result.service.reconciliation
      ? { reconciliation: { ...result.service.reconciliation } }
      : {}),
    ...(config ? { stateRoot: config.rootPath } : {}),
    ...(config &&
    process.env[RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV] === '1'
      ? {
          configurationFingerprint: runtimeHostManagedServiceConfigFingerprint(config),
        }
      : {}),
    projectDirectoryRoots: config ? [...effectiveRuntimeHostProjectDirectoryRoots(config)] : [],
  };
}

export function createPlatformRuntimeHostServiceBackend(
  serviceId: string,
  clientDataRoot: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeHostServiceBackend {
  const serviceConfigPath = resolveRuntimeHostManagedServiceConfigPath(clientDataRoot);
  if (platform === 'linux') {
    return createSystemdUserRuntimeHostService(serviceId, {
      serviceConfigPath,
    });
  }
  if (platform === 'darwin') {
    return createLaunchAgentRuntimeHostService(serviceId, {
      serviceConfigPath,
    });
  }
  throw new RuntimeHostServiceManagerError(
    'unsupported_platform',
    'Managed Runtime Host services currently require Linux or macOS',
  );
}

export async function discoverRuntimeHostLifecycleProvider(
  rootId: string,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly environment?: NodeJS.ProcessEnv;
  } = {},
): Promise<RuntimeHostLifecycleProviderOffer> {
  const selection = selectRuntimeHostLifecycleProvider({
    platform: options.platform ?? process.platform,
    environment: options.environment ?? process.env,
  });
  const provider = resolveRuntimeHostLifecycleProvider(rootId, selection.provider);
  await provider.supervisor.preflight();
  return { provider, availability: selection.availability };
}

export function selectRuntimeHostLifecycleProvider(options: {
  readonly platform: NodeJS.Platform;
  readonly environment: NodeJS.ProcessEnv;
}): {
  readonly provider: RuntimeHostSupervisorProvider;
  readonly availability: RuntimeHostLifecycleProviderOffer['availability'];
} {
  if (options.platform === 'linux') {
    return {
      provider: 'systemd_user',
      availability: isWslEnvironment(options.environment) ? 'environment' : 'machine',
    };
  }
  if (options.platform === 'darwin') {
    return { provider: 'launch_agent', availability: 'session' };
  }
  throw new RuntimeHostServiceManagerError(
    'unsupported_platform',
    'Supervised Runtime Host deployments currently require Linux or macOS',
  );
}

/** Resolves only the provider identity already persisted by the deployment authority. */
export function resolveRuntimeHostLifecycleProvider(
  rootId: string,
  provider: RuntimeHostSupervisorProvider,
): RuntimeHostLifecycleProvider {
  if (provider === 'systemd_user') return createSystemdUserRuntimeHostLifecycleProvider(rootId, {});
  if (provider === 'launch_agent') return createLaunchAgentRuntimeHostLifecycleProvider(rootId);
  throw new RuntimeHostServiceManagerError(
    'service_manager_unavailable',
    `The persisted Runtime Host provider ${provider} is unavailable`,
  );
}

function isWslEnvironment(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment.WSL_DISTRO_NAME?.trim() || environment.WSL_INTEROP?.trim());
}

function websocketUrl(service: RuntimeHostManagedServiceResult['service']): string {
  const websocket = service.config?.websocket;
  return websocket
    ? `ws://${websocket.host}:${websocket.port}${websocket.path}`
    : 'an unknown endpoint';
}
