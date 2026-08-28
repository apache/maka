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

import { rm } from 'node:fs/promises';
import { resolveRuntimeHostNpmDeploymentLayout } from '@maka/runtime-host/operator';
import {
  resolveRuntimeHostManagedDeployment,
  type RuntimeHostManagedDeploymentConfig,
} from '@maka/runtime-host/operator';
import {
  applyRuntimeHostLifecycleTransition,
  activateRuntimeHostLifecycle,
  replaceRuntimeHostLifecycle,
  retireRuntimeHostLifecycleOwner,
  runtimeHostReconciliationTriggerDefinition,
  runtimeHostSupervisorDefinition,
  verifyRuntimeHostLifecycleReady,
  type RuntimeHostLifecycleTransactionDeps,
} from './runtime-host-lifecycle-transaction.js';
import type { RuntimeHostLifecycleProvider } from './runtime-host-lifecycle-provider.js';
import {
  effectiveRuntimeHostProjectDirectoryRoots,
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
  readonly createProvider: (rootId: string) => RuntimeHostLifecycleProvider;
  readonly applyTransition?: typeof applyRuntimeHostLifecycleTransition;
  readonly activate?: typeof activateRuntimeHostLifecycle;
  readonly verifyReady?: typeof verifyRuntimeHostLifecycleReady;
  readonly retire?: typeof retireRuntimeHostLifecycleOwner;
  readonly replace?: typeof replaceRuntimeHostLifecycle;
}

export async function manageRuntimeHostManagedLifecycle(
  rootId: string,
  input: RuntimeHostManagedServiceInput,
  dependencies: RuntimeHostManagedLifecycleManagerDeps,
): Promise<RuntimeHostManagedServiceResult> {
  const { config } = await resolveRuntimeHostManagedDeployment(rootId);
  if (input.expectedTarget) assertExpectedTarget(input.expectedTarget, config);
  if (config.lifecycle.mode !== 'supervised') {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'This managed Runtime Host uses on-demand lifecycle activation',
    );
  }
  const provider = dependencies.createProvider(rootId);
  if (provider.supervisor.provider !== config.lifecycle.provider) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      `The persisted Runtime Host provider ${config.lifecycle.provider} is unavailable`,
    );
  }
  const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
    resolveProvider: (requested) => {
      if (requested !== provider.supervisor.provider) {
        throw new RuntimeHostServiceManagerError(
          'target_mismatch',
          `The persisted Runtime Host provider ${requested} is unavailable`,
        );
      }
      return provider;
    },
  };
  const applyTransition = dependencies.applyTransition ?? applyRuntimeHostLifecycleTransition;
  const activate = dependencies.activate ?? activateRuntimeHostLifecycle;
  const verifyReady = dependencies.verifyReady ?? verifyRuntimeHostLifecycleReady;
  const retire = dependencies.retire ?? retireRuntimeHostLifecycleOwner;
  const replace = dependencies.replace ?? replaceRuntimeHostLifecycle;

  if (input.action === 'install') {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'Managed Runtime Host installation must use runtime-host setup',
    );
  }
  if (input.action === 'status') {
    await verifyProviderDefinitions(config, provider);
    return result('status', await status(config, provider));
  }
  if (input.action === 'logs') {
    await verifyProviderDefinitions(config, provider);
    const [host, reconciliation] = await Promise.all([
      provider.supervisor.logs(),
      provider.reconciliationTrigger.logs(),
    ]);
    return {
      ...result('logs', await status(config, provider)),
      logs: [host, reconciliation].filter(Boolean).join('\n'),
    };
  }
  if (input.action === 'start' || input.action === 'restart') {
    if (input.action === 'restart') {
      const retirement = await retire({
        rootPath: config.root.path,
        rootId,
        supervisor: provider.supervisor,
        allowInterruptActiveTasks: true,
      });
      if (retirement.kind === 'active_tasks') throw new Error('Unexpected active-task refusal');
      await retirement.owner.close();
    }
    await activate(config, lifecycleDeps);
    await verifyReady(config, lifecycleDeps);
    return result(input.action, await status(config, provider));
  }
  if (input.action === 'stop' || input.action === 'retire') {
    const retirement = await retire({
      rootPath: config.root.path,
      rootId,
      supervisor: provider.supervisor,
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
      return configurationResult('unchanged', currentStatus);
    }
    const desired: RuntimeHostManagedDeploymentConfig = {
      ...config,
      configRevision: config.configRevision + 1,
      projectDirectoryRoots: [...projectDirectoryRoots],
    };
    const replacement = await replace({
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
    const retirement = await retire({
      rootPath: config.root.path,
      rootId,
      supervisor: provider.supervisor,
      allowInterruptActiveTasks: input.allowInterruptActiveTasks ?? false,
    });
    if (retirement.kind === 'active_tasks') {
      return {
        ...resultWithRetirement('uninstall', await status(config, provider), retirement),
        retainedStateRoot: config.root.path,
      };
    }
    try {
      await applyTransition(
        retirement.owner,
        { operation: 'uninstall', current: config },
        lifecycleDeps,
      );
    } finally {
      await retirement.owner.close();
    }
    if (config.listeners.directPeer) {
      await rm(config.listeners.directPeer.keyPath, { force: true });
    }
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
  provider: RuntimeHostLifecycleProvider,
): Promise<RuntimeHostManagedServiceStatus> {
  const observed = await provider.supervisor.status();
  return {
    manager: observed.provider === 'systemd_user' ? 'systemd_user' : 'launch_agent',
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

function absentStatus(config: RuntimeHostManagedDeploymentConfig): RuntimeHostManagedServiceStatus {
  return {
    manager:
      config.lifecycle.mode === 'supervised' && config.lifecycle.provider === 'systemd_user'
        ? 'systemd_user'
        : 'launch_agent',
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

function projectLegacyConfig(
  config: RuntimeHostManagedDeploymentConfig,
): RuntimeHostManagedServiceConfig {
  const layout = resolveRuntimeHostNpmDeploymentLayout(
    config.deploymentRoot,
    config.launch.package.integrity,
  );
  const websocket = config.listeners.websocket;
  if (!websocket || websocket.port === 0) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      'A supervised Runtime Host requires a stable WebSocket endpoint',
    );
  }
  const peer = config.listeners.directPeer;
  return {
    schemaVersion: 2,
    managedDeploymentRoot: config.deploymentRoot,
    rootPath: config.root.path,
    projectDirectoryRoots: [...config.projectDirectoryRoots],
    websocket,
    launch: { nodePath: config.launch.nodePath, cliPath: layout.cliPath },
    ...(peer
      ? {
          peer: {
            enabled: peer.enabled,
            peerId: peer.peerId,
            listenAddresses: [...peer.listenAddresses],
            coordinationRelays: [...peer.coordinationRelays],
          },
        }
      : {}),
  };
}

function assertExpectedTarget(
  expected: NonNullable<RuntimeHostManagedServiceInput['expectedTarget']>,
  config: RuntimeHostManagedDeploymentConfig,
): void {
  if (
    expected.serviceId !== config.root.id ||
    expected.rootId !== config.root.id ||
    expected.rootPath !== config.root.path
  ) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'The managed Runtime Host does not match the expected deployment identity',
    );
  }
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
