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

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  decodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostServiceUpdatePhase,
} from '@maka/runtime-host/operator';
import {
  prepareRuntimeHostManagedPackageDeployment,
  RuntimeHostManagedDeploymentError,
  type RuntimeHostManagedPackageDeployment,
} from './runtime-host-managed-deployment.js';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  verifyRuntimeHostManagedServiceReady,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLifecycleLock,
  type RuntimeHostManagedServiceResult,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import {
  createPlatformRuntimeHostServiceBackend,
  runtimeHostServiceSummary,
} from './runtime-host-service-management-command.js';

const OPERATOR_TIMEOUT_MS = 2 * 60_000;
const OPERATOR_OUTPUT_MAX_BYTES = 256 * 1024;

export interface RuntimeHostUpdateCliOptions {
  readonly json: boolean;
  readonly framed: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly sourcePackageRoot: string;
  readonly version: string;
  readonly expectedTarget: RuntimeHostManagedServiceTarget;
  readonly allowInterruptActiveTasks?: boolean;
}

interface RuntimeHostUpdateCliDeps {
  readonly manage: typeof manageRuntimeHostService;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly withLifecycleLock: typeof withRuntimeHostManagedServiceLifecycleLock;
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly createBackend: (serviceId: string) => RuntimeHostServiceBackend;
  readonly verifyReady: typeof verifyRuntimeHostManagedServiceReady;
  readonly runOperator: (
    operatorPath: string,
    args: readonly string[],
  ) => Promise<RuntimeHostServiceManagementFrame>;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

export async function runManagedRuntimeHostUpdateCli(
  options: RuntimeHostUpdateCliOptions,
  overrides: Partial<RuntimeHostUpdateCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostUpdateCliDeps = {
    manage: manageRuntimeHostService,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    withLifecycleLock: withRuntimeHostManagedServiceLifecycleLock,
    withDeploymentLock: withRuntimeHostManagedServiceDeploymentLock,
    createBackend: createPlatformRuntimeHostServiceBackend,
    verifyReady: verifyRuntimeHostManagedServiceReady,
    runOperator: runManagedRuntimeHostOperator,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  let deployment: RuntimeHostManagedPackageDeployment | undefined;
  let cutoverStarted = false;
  let retired = false;
  const emit = (frame: RuntimeHostServiceManagementFrame): void => {
    if (options.framed) {
      deps.writeOutput(encodeRuntimeHostServiceManagementFrame(frame));
      return;
    }
    if (frame.kind === 'progress') {
      if (!options.json) deps.writeError(`${humanPhase(frame.phase)}\n`);
      return;
    }
    if (options.json) deps.writeOutput(`${JSON.stringify(frame)}\n`);
    else if (frame.kind === 'error') deps.writeError(`${frame.error.message}\n`);
    else {
      if (frame.action !== 'update') {
        throw new TypeError('Managed Runtime Host update returned an unrelated result');
      }
      deps.writeOutput(`${humanResult(frame)}\n`);
    }
  };
  try {
    return await deps.withDeploymentLock(options.clientDataRoot, async () => {
      try {
        const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
        if (serviceId !== options.expectedTarget.serviceId) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The managed Runtime Host update does not match the expected service identity',
          );
        }
        const backend = deps.createBackend(serviceId);
        const common = {
          clientDataRoot: options.clientDataRoot,
          defaultRootPath: options.defaultRootPath,
          nodePath: process.execPath,
          cliPath: join(options.sourcePackageRoot, 'dist', 'cli.js'),
          expectedTarget: options.expectedTarget,
        } as const;
        const status = await deps.manage({ ...common, action: 'status' }, backend);
        const currentVersion = requireManagedVersion(status);
        const serviceConfig = status.service.config;
        if (!serviceConfig?.managedDeploymentRoot) {
          throw new RuntimeHostServiceManagerError(
            'invalid_launch',
            'The Runtime Host service is not owned by a Maka managed deployment',
          );
        }
        emit(progress('checking', currentVersion, options.version));
        if (currentVersion === options.version && status.service.active) {
          await deps.verifyReady(serviceConfig, backend);
          emit({
            schemaVersion: 1,
            kind: 'result',
            action: 'update',
            service: runtimeHostServiceSummary(status),
            ...operatorCapabilities(),
            update: { kind: 'already_current', version: options.version },
          });
          return 0;
        }

        emit(progress('staging', currentVersion, options.version));
        deployment = await deps.withLifecycleLock(options.clientDataRoot, () =>
          deps.prepareDeployment({
            serviceId,
            clientDataRoot: options.clientDataRoot,
            sourcePackageRoot: options.sourcePackageRoot,
            version: options.version,
          }),
        );
        if (deployment.root !== serviceConfig.managedDeploymentRoot) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The staged Runtime Host package belongs to a different managed deployment',
          );
        }

        if (currentVersion !== options.version) {
          emit(progress('retiring', currentVersion, options.version));
          const retirement = await deps.runOperator(deployment.operatorPath, [
            'retire',
            '--framed',
            ...expectedTargetArgs(options.expectedTarget),
            ...(options.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
          ]);
          if (retirement.kind === 'error') {
            if (retirement.action !== 'retire') {
              throw new Error(
                'The current Runtime Host operator returned an unrelated retirement error',
              );
            }
            await deployment.rollback().catch(() => undefined);
            deployment = undefined;
            emit({ ...retirement, action: 'update' });
            return 1;
          }
          if (retirement.kind !== 'result' || retirement.action !== 'retire') {
            throw new Error(
              'The current Runtime Host operator returned an invalid retirement result',
            );
          }
          if (retirement.retirement.kind === 'active_tasks') {
            await deployment.rollback().catch(() => undefined);
            deployment = undefined;
            emit({
              schemaVersion: 1,
              kind: 'result',
              action: 'update',
              service: retirement.service,
              ...operatorCapabilities(),
              update: { kind: 'active_tasks', currentVersion, targetVersion: options.version },
            });
            return 1;
          }
          retired = true;
        }

        const targetDeployment = deployment;
        const updated = await deps.withLifecycleLock(options.clientDataRoot, async () => {
          const stopped = await deps.manage({ ...common, action: 'status' }, backend);
          if (
            requireManagedVersion(stopped) !== currentVersion ||
            stopped.service.active ||
            stopped.service.pid !== null ||
            (stopped.service.state !== 'stopped' && stopped.service.state !== 'failed')
          ) {
            throw new RuntimeHostServiceManagerError(
              'target_mismatch',
              'The managed Runtime Host changed while the update was preparing its replacement',
            );
          }
          cutoverStarted = true;
          await targetDeployment.activate();
          emit(progress('replacing', currentVersion, options.version));
          const updated = await deps.manage(
            {
              ...common,
              action: 'update',
              cliPath: targetDeployment.cliPath,
            },
            backend,
          );
          if (updated.service.installedVersion !== options.version || !updated.service.active) {
            throw new RuntimeHostServiceManagerError(
              'update_incomplete',
              'The replacement Runtime Host did not report the selected package version as ready',
            );
          }
          await targetDeployment.cleanup().catch(() => undefined);
          return updated;
        });
        emit({
          schemaVersion: 1,
          kind: 'result',
          action: 'update',
          service: runtimeHostServiceSummary(updated),
          ...operatorCapabilities(),
          update:
            currentVersion === options.version
              ? { kind: 'repaired', version: options.version }
              : {
                  kind: 'updated',
                  previousVersion: currentVersion,
                  targetVersion: options.version,
                },
        });
        return 0;
      } catch (error) {
        if (deployment && !cutoverStarted) await deployment.rollback().catch(() => undefined);
        if (
          (retired || cutoverStarted) &&
          !(error instanceof RuntimeHostServiceManagerError && error.code === 'update_incomplete')
        ) {
          throw new RuntimeHostServiceManagerError(
            'update_incomplete',
            `The Runtime Host update may have started its cutover before it failed; retry the exact ${options.version} update to complete recovery`,
            { cause: error },
          );
        }
        throw error;
      }
    });
  } catch (error) {
    const code =
      error instanceof RuntimeHostServiceManagerError ||
      error instanceof RuntimeHostManagedDeploymentError
        ? error.code
        : 'internal_service_error';
    const message = error instanceof Error ? error.message : String(error);
    emit({
      schemaVersion: 1,
      kind: 'error',
      action: 'update',
      error: {
        code:
          truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES) || 'internal_service_error',
        message:
          truncateUtf8(message, RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES) ||
          'Runtime Host update failed',
      },
    });
    return 1;
  }
}

function progress(
  phase: RuntimeHostServiceUpdatePhase,
  currentVersion: string,
  targetVersion: string,
): RuntimeHostServiceManagementFrame {
  return {
    schemaVersion: 1,
    kind: 'progress',
    action: 'update',
    phase,
    currentVersion,
    targetVersion,
  };
}

function requireManagedVersion(result: RuntimeHostManagedServiceResult): string {
  if (!result.service.installed || !result.service.config) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host service is not installed',
    );
  }
  if (!result.service.installedVersion) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The installed Runtime Host package version could not be identified',
    );
  }
  return result.service.installedVersion;
}

function expectedTargetArgs(target: RuntimeHostManagedServiceTarget): string[] {
  return [
    '--expected-service-id',
    target.serviceId,
    '--expected-root-path',
    target.rootPath,
    '--expected-root-id',
    target.rootId,
  ];
}

function operatorCapabilities(): {
  readonly operatorCapabilities?: (typeof RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY)[];
} {
  return process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] ===
    RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY
    ? { operatorCapabilities: [RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY] }
    : {};
}

async function runManagedRuntimeHostOperator(
  operatorPath: string,
  args: readonly string[],
): Promise<RuntimeHostServiceManagementFrame> {
  return new Promise((resolve, reject) => {
    execFile(
      operatorPath,
      [...args],
      {
        encoding: 'utf8',
        timeout: OPERATOR_TIMEOUT_MS,
        maxBuffer: OPERATOR_OUTPUT_MAX_BYTES,
      },
      (error, stdout, stderr) => {
        let frame: RuntimeHostServiceManagementFrame | undefined;
        for (const line of stdout.split(/\r?\n/u)) {
          frame = decodeRuntimeHostServiceManagementFrame(line) ?? frame;
        }
        if (frame) {
          resolve(frame);
          return;
        }
        const message = stderr.trim();
        reject(
          error ?? new Error(message || 'The current Runtime Host operator returned no result'),
        );
      },
    );
  });
}

function humanPhase(phase: RuntimeHostServiceUpdatePhase): string {
  if (phase === 'checking') return 'Checking the managed Runtime Host update...';
  if (phase === 'staging') return 'Staging the replacement package...';
  if (phase === 'retiring') return 'Retiring the current Runtime Host...';
  return 'Starting and verifying the replacement Runtime Host...';
}

function humanResult(
  frame: Extract<RuntimeHostServiceManagementFrame, { kind: 'result'; action: 'update' }>,
): string {
  if (frame.update.kind === 'already_current') {
    return `Runtime Host ${frame.update.version} is already installed.`;
  }
  if (frame.update.kind === 'active_tasks') {
    return 'Runtime Host still owns active work. Retry with explicit interruption authority.';
  }
  if (frame.update.kind === 'repaired') {
    return `Runtime Host ${frame.update.version} was restored to a ready state.`;
  }
  return `Runtime Host was updated from ${frame.update.previousVersion} to ${frame.update.targetVersion}.`;
}
