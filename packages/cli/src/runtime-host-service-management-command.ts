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
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostServiceSummary,
} from '@maka/runtime-host/operator';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceInput,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import { createSystemdUserRuntimeHostService } from './runtime-host-systemd-service.js';

export interface RuntimeHostServiceManagementCliOptions extends RuntimeHostManagedServiceInput {
  readonly json: boolean;
  readonly framed?: boolean;
}

export interface RuntimeHostServiceManagementCliDeps {
  readonly manage: typeof manageRuntimeHostService;
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
    createBackend: createPlatformRuntimeHostServiceBackend,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  try {
    const { json: _json, framed: _framed, ...input } = options;
    const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
    const result = await deps.manage(input, deps.createBackend(serviceId));
    if (options.framed) {
      deps.writeOutput(encodeRuntimeHostServiceManagementFrame(successFrame(result)));
    } else {
      deps.writeOutput(
        options.json ? `${JSON.stringify({ ...result, ok: true })}\n` : formatHumanResult(result),
      );
    }
    return 0;
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
  if (result.action === 'logs') return result.logs || 'No Runtime Host service logs were found.\n';
  return `Runtime Host service is ${service.state}.\n`;
}

function successFrame(result: RuntimeHostManagedServiceResult): RuntimeHostServiceManagementFrame {
  const config = result.service.config;
  const service: RuntimeHostServiceSummary = {
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
  return {
    schemaVersion: 1,
    kind: 'result',
    action: result.action,
    service,
    ...(result.retainedStateRoot ? { retainedStateRoot: result.retainedStateRoot } : {}),
    ...(result.logs !== undefined ? { logs: result.logs } : {}),
  };
}

export function createPlatformRuntimeHostServiceBackend(
  serviceId: string,
): RuntimeHostServiceBackend {
  if (process.platform === 'linux') return createSystemdUserRuntimeHostService(serviceId);
  throw new RuntimeHostServiceManagerError(
    'unsupported_platform',
    'Managed Runtime Host services currently require Linux',
  );
}

function websocketUrl(service: RuntimeHostManagedServiceResult['service']): string {
  const websocket = service.config?.websocket;
  return websocket
    ? `ws://${websocket.host}:${websocket.port}${websocket.path}`
    : 'an unknown endpoint';
}
