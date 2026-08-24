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

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import {
  decodeRuntimeHostServiceManagementFrame,
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
  type RuntimeHostOperatorCapability,
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
  replaceRuntimeHostManagedService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  verifyRuntimeHostManagedServiceReady,
  withRuntimeHostManagedServiceDeploymentLock,
  withRuntimeHostManagedServiceLegacyOperatorLeases,
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
  readonly replace: typeof replaceRuntimeHostManagedService;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly withLifecycleLock: typeof withRuntimeHostManagedServiceLifecycleLock;
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly withLegacyOperatorLeases: typeof withRuntimeHostManagedServiceLegacyOperatorLeases;
  readonly createBackend: (serviceId: string) => RuntimeHostServiceBackend;
  readonly verifyReady: typeof verifyRuntimeHostManagedServiceReady;
  readonly runOperator: (
    operatorPath: string,
    args: readonly string[],
    invocation?: RuntimeHostOperatorInvocation,
  ) => Promise<RuntimeHostServiceManagementFrame>;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

interface RuntimeHostOperatorInvocation {
  readonly inheritedFds?: readonly number[];
  readonly capabilityRequest?: RuntimeHostOperatorCapability;
}

export async function runManagedRuntimeHostUpdateCli(
  options: RuntimeHostUpdateCliOptions,
  overrides: Partial<RuntimeHostUpdateCliDeps> = {},
): Promise<number> {
  const deps: RuntimeHostUpdateCliDeps = {
    manage: manageRuntimeHostService,
    replace: replaceRuntimeHostManagedService,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    withLifecycleLock: withRuntimeHostManagedServiceLifecycleLock,
    withDeploymentLock: withRuntimeHostManagedServiceDeploymentLock,
    withLegacyOperatorLeases: withRuntimeHostManagedServiceLegacyOperatorLeases,
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
        let activeTargetNeedsRepair = false;
        if (currentVersion === options.version && status.service.active) {
          try {
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
          } catch {
            activeTargetNeedsRepair = true;
          }
        }

        const currentOperatorPath = join(serviceConfig.managedDeploymentRoot, 'operator');
        const currentOperatorUsesProcessLifetimeLock = status.service.active
          ? operatorUsesProcessLifetimeLock(
              await deps.runOperator(
                currentOperatorPath,
                ['status', '--framed', ...expectedTargetArgs(options.expectedTarget)],
                { capabilityRequest: RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY },
              ),
            )
          : false;

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

        if (status.service.active) {
          emit(progress('retiring', currentVersion, options.version));
          const runCurrentOperator = (args: readonly string[]) =>
            currentOperatorUsesProcessLifetimeLock
              ? deps.runOperator(currentOperatorPath, args)
              : deps.withLegacyOperatorLeases(options.clientDataRoot, (inheritedFds) =>
                  deps.runOperator(currentOperatorPath, args, { inheritedFds }),
                );
          let retirement = await runCurrentOperator([
            'retire',
            '--framed',
            ...expectedTargetArgs(options.expectedTarget),
            ...(options.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
          ]);
          if (
            activeTargetNeedsRepair &&
            retirement.kind === 'error' &&
            retirement.action === 'retire' &&
            retirement.error.code === 'retirement_failed'
          ) {
            if (!options.allowInterruptActiveTasks) {
              retirement = activeTasksRetirementFrame(status);
            } else {
              const forced = await runCurrentOperator([
                'stop',
                '--framed',
                ...expectedTargetArgs(options.expectedTarget),
              ]);
              if (forced.kind === 'error') {
                emit({ ...forced, action: 'update' });
                return 1;
              }
              if (forced.kind !== 'result' || forced.action !== 'stop') {
                throw new Error(
                  'The current Runtime Host operator returned an invalid stop result',
                );
              }
              retirement = {
                schemaVersion: 1,
                kind: 'result',
                action: 'retire',
                service: forced.service,
                ...(forced.operatorCapabilities
                  ? { operatorCapabilities: forced.operatorCapabilities }
                  : {}),
                retirement: { kind: 'stopped' },
              };
            }
          }
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
          const updatedService = await deps.replace(
            {
              ...common,
              cliPath: targetDeployment.cliPath,
              expectedTarget: options.expectedTarget,
            },
            backend,
          );
          if (updatedService.installedVersion !== options.version || !updatedService.active) {
            throw new RuntimeHostServiceManagerError(
              'update_incomplete',
              'The replacement Runtime Host did not report the selected package version as ready',
            );
          }
          await targetDeployment.cleanup().catch(() => undefined);
          return { schemaVersion: 1, action: 'status', service: updatedService } as const;
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

function activeTasksRetirementFrame(
  status: RuntimeHostManagedServiceResult,
): RuntimeHostServiceManagementFrame {
  return {
    schemaVersion: 1,
    kind: 'result',
    action: 'retire',
    service: runtimeHostServiceSummary(status),
    ...operatorCapabilities(),
    retirement: { kind: 'active_tasks' },
  };
}

function operatorUsesProcessLifetimeLock(frame: RuntimeHostServiceManagementFrame): boolean {
  if (frame.kind === 'error') {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      `The current Runtime Host operator could not report its lock protocol: ${frame.error.message}`,
    );
  }
  if (frame.action !== 'status') {
    throw new Error('The current Runtime Host operator returned an invalid capability result');
  }
  return (
    frame.operatorCapabilities?.includes(RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY) ===
    true
  );
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
  invocation: RuntimeHostOperatorInvocation = {},
): Promise<RuntimeHostServiceManagementFrame> {
  return new Promise((resolve, reject) => {
    const inheritedFds = invocation.inheritedFds ?? [];
    const child = spawn(operatorPath, [...args], {
      // A detached legacy operator keeps the inherited advisory leases alive if
      // this updater is interrupted, so an exact retry never steals active work.
      detached: process.platform !== 'win32',
      env: invocation.capabilityRequest
        ? {
            ...process.env,
            [RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV]: invocation.capabilityRequest,
          }
        : process.env,
      stdio: ['ignore', 'pipe', 'pipe', ...inheritedFds],
      windowsHide: true,
    });
    if (!child.stdout || !child.stderr) {
      child.kill('SIGKILL');
      reject(new Error('The current Runtime Host operator did not expose its output streams'));
      return;
    }
    const stdoutStream = child.stdout;
    const stderrStream = child.stderr;
    let stdout = '';
    let stderr = '';
    let failure: Error | undefined;
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next) > OPERATOR_OUTPUT_MAX_BYTES) {
        failure = new Error('The current Runtime Host operator returned too much output');
        child.kill('SIGKILL');
      }
      return next;
    };
    stdoutStream.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    stderrStream.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      failure = error;
    });
    const timeout = setTimeout(() => {
      failure = new Error('The current Runtime Host operator timed out');
      child.kill('SIGKILL');
    }, OPERATOR_TIMEOUT_MS);
    child.once('close', () => {
      clearTimeout(timeout);
      let frame: RuntimeHostServiceManagementFrame | undefined;
      for (const line of stdout.split(/\r?\n/u)) {
        frame = decodeRuntimeHostServiceManagementFrame(line) ?? frame;
      }
      if (frame) resolve(frame);
      else
        reject(
          failure ??
            new Error(stderr.trim() || 'The current Runtime Host operator returned no result'),
        );
    });
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
