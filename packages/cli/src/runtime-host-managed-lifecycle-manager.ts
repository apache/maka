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

import {
  resolveRuntimeHostNpmDeploymentLayout,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import { connectExistingRuntimeHost } from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION } from '@maka/runtime-host/protocol';
import {
  applyRetiredRuntimeHostLifecycleTransition,
  activateRuntimeHostLifecycle,
  replaceRuntimeHostLifecycle,
  resolveRecoverableRuntimeHostManagedDeployment,
  retireRuntimeHostLifecycleOwner,
  runtimeHostReconciliationTriggerDefinition,
  runtimeHostSupervisorDefinition,
  verifyRuntimeHostLifecycleReady,
  type RuntimeHostLifecycleTransactionDeps,
} from './runtime-host-lifecycle-transaction.js';
import type { RuntimeHostLifecycleProvider } from './runtime-host-lifecycle-provider.js';
import {
  assertRuntimeHostManagedOperatorConfig,
  convergeRuntimeHostManagedOperator,
  verifyRuntimeHostManagedOperator,
} from './runtime-host-managed-deployment.js';
import {
  effectiveRuntimeHostProjectDirectoryRoots,
  formatRuntimeHostServiceLogs,
  resolveRuntimeHostManagedProjectDirectoryRoots,
  runtimeHostManagedServiceConfigFingerprint,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostManagedServiceInput,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceStatus,
  type RuntimeHostRetirementResult,
} from './runtime-host-service-manager.js';

export interface RuntimeHostManagedLifecycleManagerDeps {
  readonly resolveProvider: (
    config: RuntimeHostManagedDeploymentConfig,
  ) => RuntimeHostLifecycleProvider;
  readonly operatorClaim?: {
    readonly deploymentId?: string;
    readonly cliPath: string;
  };
}

export async function manageRuntimeHostManagedLifecycle(
  rootId: string,
  input: RuntimeHostManagedServiceInput,
  dependencies: RuntimeHostManagedLifecycleManagerDeps,
): Promise<RuntimeHostManagedServiceResult> {
  const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
    convergeOperator: (currentConfig, desiredConfig) =>
      convergeRuntimeHostManagedOperator(currentConfig, desiredConfig),
    verifyOperator: verifyRuntimeHostManagedOperator,
    resolveProvider: dependencies.resolveProvider,
  };
  const resolved = await resolveRecoverableRuntimeHostManagedDeployment(rootId, lifecycleDeps, {
    ...(input.expectedTarget ? { expectedTarget: input.expectedTarget } : {}),
    allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
  });
  if (resolved.kind === 'absent') {
    if (input.action === 'uninstall' && input.expectedTarget) {
      return {
        ...resultWithRetirement('uninstall', unknownAbsentStatus(), { kind: 'stopped' }),
        retainedStateRoot: input.expectedTarget.rootPath,
      };
    }
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'The managed Runtime Host deployment is not installed',
    );
  }
  const config = resolved.config;
  if (dependencies.operatorClaim) {
    assertRuntimeHostManagedOperatorConfig(
      config,
      dependencies.operatorClaim.deploymentId,
      dependencies.operatorClaim.cliPath,
    );
  }
  const provider =
    config.lifecycle.mode === 'supervised' ? dependencies.resolveProvider(config) : undefined;
  if (input.action === 'install') {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'Managed Runtime Host installation must use runtime-host setup',
    );
  }
  if (input.action === 'status') {
    await lifecycleDeps.verifyOperator(config);
    if (provider) await verifyProviderDefinitions(config, provider);
    return result('status', await status(config, provider));
  }
  if (input.action === 'logs') {
    await lifecycleDeps.verifyOperator(config);
    if (provider) await verifyProviderDefinitions(config, provider);
    const host = provider ? await provider.supervisor.logs() : '';
    const reconciliation =
      provider && config.reconciliation.trigger === 'scheduled'
        ? await provider.reconciliationTrigger.logs()
        : '';
    return {
      ...result('logs', await status(config, provider)),
      logs: formatRuntimeHostServiceLogs([
        { label: 'host', logs: host },
        { label: 'reconciliation', logs: reconciliation },
      ]),
    };
  }
  if (input.action === 'start' || input.action === 'restart') {
    if (!provider) {
      throw new RuntimeHostServiceManagerError(
        'target_mismatch',
        'Start an on-demand Runtime Host with operator activate',
      );
    }
    if (input.action === 'restart') {
      const retirement = await retireRuntimeHostLifecycleOwner({
        rootPath: config.root.path,
        rootId,
        supervisor: provider.supervisor,
        allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
      });
      if (retirement.kind === 'active_tasks') {
        throw new RuntimeHostServiceManagerError(
          'active_tasks',
          'Runtime Host still owns active work; it was not restarted',
        );
      }
      await retirement.owner.close();
    }
    try {
      await activateRuntimeHostLifecycle(config, lifecycleDeps);
      await verifyRuntimeHostLifecycleReady(config, lifecycleDeps);
    } catch (activationError) {
      try {
        const recovery = await retireRuntimeHostLifecycleOwner({
          rootPath: config.root.path,
          rootId,
          supervisor: provider.supervisor,
          allowInterruptActiveTasks: true,
        });
        if (recovery.kind === 'retired') await recovery.owner.close();
      } catch (retirementError) {
        throw new AggregateError([activationError, retirementError]);
      }
      throw activationError;
    }
    return result(input.action, await status(config, provider));
  }
  if (input.action === 'stop' || input.action === 'retire') {
    const retirement = await retireRuntimeHostLifecycleOwner({
      rootPath: config.root.path,
      rootId,
      ...(provider ? { supervisor: provider.supervisor } : {}),
      allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
    });
    if (retirement.kind === 'active_tasks') {
      if (input.action === 'stop') {
        throw new RuntimeHostServiceManagerError(
          'retirement_failed',
          'Runtime Host still owns active work; it was not stopped',
        );
      }
      const current = await status(config, provider);
      return resultWithRetirement('retire', current, retirement);
    }
    await retirement.owner.close();
    const stopped = await status(config, provider);
    return input.action === 'retire'
      ? resultWithRetirement('retire', stopped, { kind: 'stopped' })
      : result('stop', stopped);
  }
  if (input.action === 'configure') {
    if (!input.expectedConfigFingerprint) {
      throw new RuntimeHostServiceManagerError(
        'configuration_changed',
        'Runtime Host configuration requires its observed fingerprint',
      );
    }
    const currentStatus = await status(config, provider);
    if (
      runtimeHostManagedServiceConfigFingerprint(currentStatus.config!) !==
      input.expectedConfigFingerprint
    ) {
      throw new RuntimeHostServiceManagerError(
        'configuration_changed',
        'The Runtime Host configuration changed before it could be updated',
      );
    }
    const projectDirectoryRoots = await resolveRuntimeHostManagedProjectDirectoryRoots(
      input.projectDirectoryRoots ??
        effectiveRuntimeHostProjectDirectoryRoots(currentStatus.config!),
    );
    if (JSON.stringify(projectDirectoryRoots) === JSON.stringify(config.projectDirectoryRoots)) {
      await activateRuntimeHostLifecycle(config, lifecycleDeps);
      await verifyRuntimeHostLifecycleReady(config, lifecycleDeps);
      return configurationResult('unchanged', await status(config, provider));
    }
    const desired: RuntimeHostManagedDeploymentConfig = {
      ...config,
      configRevision: config.configRevision + 1,
      projectDirectoryRoots: [...projectDirectoryRoots],
    };
    const replacement = await replaceRuntimeHostLifecycle({
      operation: 'configure',
      current: config,
      desired,
      allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
      deps: lifecycleDeps,
    });
    if (replacement.kind === 'active_tasks') {
      return configurationResult('active_tasks', currentStatus);
    }
    return configurationResult('configured', await status(desired, provider));
  }
  if (input.action === 'uninstall') {
    const retirement = await retireRuntimeHostLifecycleOwner({
      rootPath: config.root.path,
      rootId,
      ...(provider ? { supervisor: provider.supervisor } : {}),
      allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
    });
    if (retirement.kind === 'active_tasks') {
      return {
        ...resultWithRetirement('uninstall', await status(config, provider), retirement),
        retainedStateRoot: config.root.path,
      };
    }
    await applyRetiredRuntimeHostLifecycleTransition({
      owner: retirement.owner,
      operation: 'uninstall',
      current: config,
      deps: lifecycleDeps,
    });
    return {
      ...resultWithRetirement('uninstall', absentStatus(config), {
        kind: 'stopped',
      }),
      retainedStateRoot: config.root.path,
    };
  }
  throw new RuntimeHostServiceManagerError(
    'target_mismatch',
    `Unsupported managed Runtime Host action: ${input.action}`,
  );
}

async function verifyProviderDefinitions(
  config: RuntimeHostManagedDeploymentConfig,
  provider: RuntimeHostLifecycleProvider,
): Promise<void> {
  await provider.supervisor.verify(runtimeHostSupervisorDefinition(config));
  if (config.reconciliation.trigger === 'scheduled') {
    await provider.reconciliationTrigger.verify(runtimeHostReconciliationTriggerDefinition(config));
  }
}

async function status(
  config: RuntimeHostManagedDeploymentConfig,
  provider: RuntimeHostLifecycleProvider | undefined,
): Promise<RuntimeHostManagedServiceStatus> {
  if (!provider) return onDemandStatus(config);
  const observed = await provider.supervisor.status();
  return {
    manager: presentationManager(config),
    installed: observed.installed,
    enabled: observed.enabled,
    active: observed.active,
    state: observed.state,
    pid: observed.pid,
    lastExitCode: observed.lastExitCode,
    config: projectLegacyConfig(config),
    installedVersion: config.launch.package.version,
    lifecycle: { ...config.lifecycle },
    reconciliation: { ...config.reconciliation },
  };
}

async function onDemandStatus(
  config: RuntimeHostManagedDeploymentConfig,
): Promise<RuntimeHostManagedServiceStatus> {
  let pid: number | null = null;
  const connected = await connectExistingRuntimeHost({
    rootPath: config.root.path,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
  }).catch(() => undefined);
  if (connected?.kind === 'connected') {
    try {
      pid = (await connected.connection.request('host.diagnostics.query', {})).pid;
    } finally {
      await connected.connection.close().catch(() => undefined);
    }
  }
  return {
    manager: presentationManager(config),
    installed: true,
    enabled: false,
    active: pid !== null,
    state: pid === null ? 'stopped' : 'running',
    pid,
    lastExitCode: null,
    config: projectLegacyConfig(config),
    installedVersion: config.launch.package.version,
    lifecycle: { ...config.lifecycle },
    reconciliation: { ...config.reconciliation },
  };
}

function unknownAbsentStatus(): RuntimeHostManagedServiceStatus {
  return {
    manager: 'none',
    installed: false,
    enabled: false,
    active: false,
    state: 'not_installed',
    pid: null,
    lastExitCode: null,
    config: null,
    installedVersion: null,
  };
}

function absentStatus(config: RuntimeHostManagedDeploymentConfig): RuntimeHostManagedServiceStatus {
  return {
    manager: presentationManager(config),
    installed: false,
    enabled: false,
    active: false,
    state: 'not_installed',
    pid: null,
    lastExitCode: null,
    config: null,
    installedVersion: null,
    lifecycle: { ...config.lifecycle },
    reconciliation: { ...config.reconciliation },
  };
}

function presentationManager(
  config: RuntimeHostManagedDeploymentConfig,
): Exclude<RuntimeHostManagedServiceStatus['manager'], 'none'> {
  if (config.lifecycle.mode === 'on_demand') return 'on_demand';
  return config.lifecycle.provider;
}

function projectLegacyConfig(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostManagedServiceConfig {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const websocket = config.listeners.websocket;
  if (!websocket || (config.lifecycle.mode === 'supervised' && websocket.port === 0)) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      'A supervised Runtime Host requires a stable WebSocket endpoint',
    );
  }
  return {
    schemaVersion: 2,
    managedDeploymentRoot: config.deploymentRoot,
    rootPath: config.root.path,
    projectDirectoryRoots: [...config.projectDirectoryRoots],
    websocket,
    launch: { nodePath: config.launch.nodePath, cliPath: layout.cliPath },
  };
}

function result(
  action: Exclude<RuntimeHostManagedServiceInput['action'], 'configure' | 'retire' | 'uninstall'>,
  service: RuntimeHostManagedServiceStatus,
): RuntimeHostManagedServiceResult {
  return { schemaVersion: 1, action, service };
}

function resultWithRetirement(
  action: 'retire' | 'uninstall',
  service: RuntimeHostManagedServiceStatus,
  retirement: RuntimeHostRetirementResult,
): RuntimeHostManagedServiceResult {
  return { schemaVersion: 1, action, service, retirement };
}

function configurationResult(
  kind: 'unchanged' | 'configured' | 'active_tasks',
  service: RuntimeHostManagedServiceStatus,
): RuntimeHostManagedServiceResult {
  return {
    schemaVersion: 1,
    action: 'configure',
    service,
    configuration: { kind },
  };
}
