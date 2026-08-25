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
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostOperatorCapability,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostServiceSummary,
} from '@maka/runtime-host/operator';
import {
  cleanupRuntimeHostManagedDeployment,
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceInput,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import { createLaunchAgentRuntimeHostService } from './runtime-host-launch-agent-service.js';
import { createSystemdUserRuntimeHostService } from './runtime-host-systemd-service.js';

export interface RuntimeHostServiceManagementCliOptions
  extends Omit<RuntimeHostManagedServiceInput, 'action'> {
  readonly action: RuntimeHostManagedServiceInput['action'];
  readonly json: boolean;
  readonly framed?: boolean;
}

export interface RuntimeHostServiceManagementCliDeps {
  readonly manage: typeof manageRuntimeHostService;
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly withLifecycleLock: typeof withRuntimeHostManagedServiceLifecycleLock;
  readonly createBackend: (serviceId: string) => RuntimeHostServiceBackend;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

export async function runManagedRuntimeHostServiceCli(
  options: RuntimeHostServiceManagementCliOptions,
  overrides: Partial<RuntimeHostServiceManagementCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostServiceManagementCliDeps = {
    manage: manageRuntimeHostService,
    withDeploymentLock: withRuntimeHostManagedServiceDeploymentLock,
    withLifecycleLock: withRuntimeHostManagedServiceLifecycleLock,
    createBackend: createPlatformRuntimeHostServiceBackend,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  try {
    const { json: _json, framed: _framed, ...input } = options;
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const manage = () => deps.manage(input, deps.createBackend(serviceId));
    const mutate = () =>
      deps.withDeploymentLock(options.clientDataRoot, () =>
        deps.withLifecycleLock(options.clientDataRoot, manage),
      );
    const result =
      options.action === 'status' || options.action === 'logs'
        ? await manage()
        : options.action === 'retire'
          ? await deps.withLifecycleLock(options.clientDataRoot, manage)
          : await mutate();
    const blocked = result.action === 'retire' && result.retirement.kind === 'active_tasks';
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
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
}): Promise<number> {
  try {
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    await cleanupRuntimeHostManagedDeployment(
      options,
      createPlatformRuntimeHostServiceBackend(serviceId),
    );
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function formatHumanResult(result: RuntimeHostManagedServiceResult): string {
  const service = result.service;
  if (result.action === 'uninstall') {
    return result.retainedStateRoot
      ? `Runtime Host service is uninstalled. Data was retained at ${result.retainedStateRoot}\n`
      : 'Runtime Host service is uninstalled.\n';
  }
  if (result.action === 'install') {
    return service.active
      ? `Runtime Host service is installed and running at ${websocketUrl(service)}\n`
      : 'Runtime Host service is installed but is not running. Check its status and journal.\n';
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
  return result.action === 'retire'
    ? { ...common, action: result.action, retirement: { ...result.retirement } }
    : { ...common, action: result.action };
}

function requestedOperatorCapabilities(): {
  readonly operatorCapabilities?: RuntimeHostOperatorCapability[];
} {
  const requested = process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV];
  return requested === RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY ||
    requested === RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY
    ? { operatorCapabilities: [requested] }
    : {};
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
    ...(config ? { stateRoot: config.rootPath } : {}),
    projectDirectoryRoots: [...(config?.projectDirectoryRoots ?? [])],
  };
}

export function createPlatformRuntimeHostServiceBackend(
  serviceId: string,
  platform: NodeJS.Platform = process.platform,
): RuntimeHostServiceBackend {
  if (platform === 'linux') return createSystemdUserRuntimeHostService(serviceId);
  if (platform === 'darwin') return createLaunchAgentRuntimeHostService(serviceId);
  throw new RuntimeHostServiceManagerError(
    'unsupported_platform',
    'Managed Runtime Host services currently require Linux or macOS',
  );
}

function websocketUrl(service: RuntimeHostManagedServiceResult['service']): string {
  const websocket = service.config?.websocket;
  return websocket
    ? `ws://${websocket.host}:${websocket.port}${websocket.path}`
    : 'an unknown endpoint';
}
