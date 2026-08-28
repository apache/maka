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
import { dirname, join, resolve } from 'node:path';
import { truncateUtf8 } from '@maka/core/diagnostic-log';
import { activateRuntimeHostManagedDeployment } from '@maka/runtime-host/client';
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
  RuntimeHostManagedDeploymentError as RuntimeHostDeploymentAuthorityError,
} from '@maka/runtime-host/operator';
import {
  assertRuntimeHostManagedOperatorConfig,
  assertRuntimeHostManagedOperatorDeployment,
  convergeRuntimeHostManagedOperator,
  verifyRuntimeHostManagedOperator,
  openRuntimeHostManagedPackageDeployment,
  prepareRuntimeHostManagedPackageDeployment,
  pruneRuntimeHostManagedPackages,
  resolveRuntimeHostManagedControlRoot,
  resolveRuntimeHostManagedPackageCliPath,
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
  resolveRuntimeHostLifecycleProvider,
  runtimeHostServiceSummary,
} from './runtime-host-service-management-command.js';
import {
  resolveManagedRuntimeHostUpdateSelection,
  RuntimeHostUpdateDiscoveryError,
  type RuntimeHostUpdateSelection,
} from './runtime-host-update-discovery.js';
import {
  RuntimeHostUpdatePackageError,
  withRuntimeHostRegistryUpdatePackage,
} from './runtime-host-update-package.js';
import type { RuntimeHostUpdateSelector } from './runtime-host-cli.js';
import {
  canDiscardRuntimeHostLifecycleDesiredArtifacts,
  replaceRuntimeHostLifecycle,
  resolveRecoverableRuntimeHostManagedDeployment,
  type RuntimeHostLifecycleTransactionDeps,
} from './runtime-host-lifecycle-transaction.js';
import { manageRuntimeHostManagedLifecycle } from './runtime-host-managed-lifecycle-manager.js';

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
  readonly managedRootId?: string;
  readonly operatorDeploymentId?: string;
  readonly registrySelection?: {
    readonly integrity: string;
    readonly current: {
      readonly version: string;
      readonly cliPath: string;
    };
  };
  readonly allowInterruptActiveTasks?: boolean;
}

export interface RuntimeHostSelectedUpdateCliOptions
  extends Omit<RuntimeHostUpdateCliOptions, 'sourcePackageRoot' | 'version' | 'registrySelection'> {
  readonly selector: RuntimeHostUpdateSelector;
}

interface RuntimeHostUpdateCliDeps {
  readonly revalidateSelection: () => Promise<RuntimeHostUpdateSelectionRejection | undefined>;
  readonly manage: typeof manageRuntimeHostService;
  readonly replace: typeof replaceRuntimeHostManagedService;
  readonly openDeployment: typeof openRuntimeHostManagedPackageDeployment;
  readonly prepareDeployment: typeof prepareRuntimeHostManagedPackageDeployment;
  readonly prunePackages: typeof pruneRuntimeHostManagedPackages;
  readonly activateDesired: typeof activateRuntimeHostManagedDeployment;
  readonly withLifecycleLock: typeof withRuntimeHostManagedServiceLifecycleLock;
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly withLegacyOperatorLeases: typeof withRuntimeHostManagedServiceLegacyOperatorLeases;
  readonly createBackend: (serviceId: string, clientDataRoot: string) => RuntimeHostServiceBackend;
  readonly verifyReady: typeof verifyRuntimeHostManagedServiceReady;
  readonly runOperator: (
    operatorPath: string,
    args: readonly string[],
    invocation?: RuntimeHostOperatorInvocation,
  ) => Promise<RuntimeHostServiceManagementFrame>;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

interface RuntimeHostResolvedUpdateCliDeps {
  readonly revalidateSelection: () => Promise<RuntimeHostUpdateSelectionRejection | undefined>;
  readonly withPackage: typeof withRuntimeHostRegistryUpdatePackage;
  readonly update: typeof runManagedRuntimeHostUpdateCli;
}

interface RuntimeHostSelectedUpdateCliDeps extends RuntimeHostResolvedUpdateCliDeps {
  readonly resolveSelection: typeof resolveManagedRuntimeHostUpdateSelection;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

export type RuntimeHostUpdateFrame = Extract<
  RuntimeHostServiceManagementFrame,
  { action: 'update' }
>;

export type RuntimeHostUpdateFrameSink = (frame: RuntimeHostUpdateFrame) => void;

interface RuntimeHostOperatorInvocation {
  readonly inheritedFds?: readonly number[];
  readonly capabilityRequest?: RuntimeHostOperatorCapability;
}

interface RuntimeHostUpdateSelectionRejection {
  readonly code: string;
  readonly message: string;
}

class RuntimeHostUpdateSelectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeHostUpdateSelectionError';
  }
}

export async function runManagedRuntimeHostUpdateCli(
  options: RuntimeHostUpdateCliOptions,
  overrides: Partial<RuntimeHostUpdateCliDeps> = {},
  frameSink?: RuntimeHostUpdateFrameSink,
): Promise<number> {
  const deps: RuntimeHostUpdateCliDeps = {
    revalidateSelection: async () => undefined,
    manage: manageRuntimeHostService,
    replace: replaceRuntimeHostManagedService,
    openDeployment: openRuntimeHostManagedPackageDeployment,
    prepareDeployment: prepareRuntimeHostManagedPackageDeployment,
    prunePackages: pruneRuntimeHostManagedPackages,
    activateDesired: (input) =>
      activateRuntimeHostManagedDeployment(input, {
        reconcileActivation: async () => undefined,
      }),
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
  let exactTargetObserved = false;
  let cutoverStarted = false;
  let retired = false;
  const emit =
    frameSink ?? ((frame: RuntimeHostUpdateFrame) => presentUpdateFrame(frame, options, deps));
  if (options.managedRootId) {
    return runCanonicalRuntimeHostUpdate(
      { ...options, managedRootId: options.managedRootId },
      deps,
      emit,
    );
  }
  try {
    return await deps.withDeploymentLock(options.clientDataRoot, async () => {
      try {
        const rejection = await deps.revalidateSelection();
        if (rejection) {
          throw new RuntimeHostUpdateSelectionError(rejection.code, rejection.message);
        }
        const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
        if (serviceId !== options.expectedTarget.serviceId) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The managed Runtime Host update does not match the expected service identity',
          );
        }
        const backend = deps.createBackend(serviceId, options.clientDataRoot);
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
        await backend.verifyReplacementPreconditions(serviceConfig);
        const deploymentRoot = serviceConfig.managedDeploymentRoot;
        const currentCliPath = resolve(serviceConfig.launch.cliPath);
        const targetCliPath = resolveRuntimeHostManagedPackageCliPath(
          deploymentRoot,
          options.version,
          options.registrySelection?.integrity,
        );
        const expectedCurrent = options.registrySelection?.current;
        const selectedDeploymentStillCurrent =
          !expectedCurrent ||
          (currentVersion === expectedCurrent.version &&
            currentCliPath === resolve(expectedCurrent.cliPath));
        const targetDeploymentIsCurrent =
          currentVersion === options.version && currentCliPath === targetCliPath;
        exactTargetObserved = targetDeploymentIsCurrent;
        if (!selectedDeploymentStillCurrent && !targetDeploymentIsCurrent) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The managed Runtime Host changed after its update candidate was selected',
          );
        }
        emit(progress('checking', currentVersion, options.version));
        let activeTargetNeedsRepair = false;
        if (targetDeploymentIsCurrent && status.service.active) {
          try {
            await deps.verifyReady(serviceConfig, backend);
          } catch {
            activeTargetNeedsRepair = true;
          }
          if (!activeTargetNeedsRepair) {
            const currentDeployment = await deps.openDeployment({
              serviceId,
              clientDataRoot: options.clientDataRoot,
              deploymentRoot,
              cliPath: serviceConfig.launch.cliPath,
              version: options.version,
            });
            await currentDeployment.cleanup();
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
        }

        const currentOperatorPath = join(serviceConfig.managedDeploymentRoot, 'operator');
        let currentOperatorUsesProcessLifetimeLock = false;
        let currentOperatorUnavailable = false;
        if (status.service.active) {
          try {
            currentOperatorUsesProcessLifetimeLock = operatorUsesProcessLifetimeLock(
              await deps.runOperator(
                currentOperatorPath,
                ['status', '--framed', ...expectedTargetArgs(options.expectedTarget)],
                {
                  capabilityRequest: RUNTIME_HOST_OPERATOR_PROCESS_LIFETIME_LOCK_CAPABILITY,
                },
              ),
            );
          } catch (error) {
            if (!activeTargetNeedsRepair) throw error;
            currentOperatorUnavailable = true;
          }
        }

        emit(progress('staging', currentVersion, options.version));
        deployment = await deps.withLifecycleLock(options.clientDataRoot, () =>
          targetDeploymentIsCurrent
            ? deps.openDeployment({
                serviceId,
                clientDataRoot: options.clientDataRoot,
                deploymentRoot,
                cliPath: serviceConfig.launch.cliPath,
                version: options.version,
              })
            : deps.prepareDeployment({
                serviceId,
                clientDataRoot: options.clientDataRoot,
                sourcePackageRoot: options.sourcePackageRoot,
                version: options.version,
                ...(options.registrySelection
                  ? { packageIntegrity: options.registrySelection.integrity }
                  : {}),
              }),
        );
        if (deployment.root !== deploymentRoot) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The staged Runtime Host package belongs to a different managed deployment',
          );
        }
        if (resolve(deployment.cliPath) !== targetCliPath) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The staged Runtime Host package does not match the selected deployment identity',
          );
        }

        if (status.service.active) {
          emit(progress('retiring', currentVersion, options.version));
          const runCurrentOperator = (args: readonly string[]) =>
            currentOperatorUsesProcessLifetimeLock
              ? deps.runOperator(currentOperatorPath, args)
              : deps.withLegacyOperatorLeases(options.clientDataRoot, (inheritedFds) =>
                  deps.runOperator(currentOperatorPath, args, {
                    inheritedFds,
                  }),
                );
          let retirement: RuntimeHostServiceManagementFrame = currentOperatorUnavailable
            ? {
                schemaVersion: 1,
                kind: 'error',
                action: 'retire',
                error: {
                  code: 'retirement_failed',
                  message: 'The active Runtime Host operator is unavailable',
                },
              }
            : await runCurrentOperator([
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
              const forced = await deps.withLifecycleLock(options.clientDataRoot, async () => {
                await backend.retire();
                return deps.manage({ ...common, action: 'status' }, backend);
              });
              if (
                forced.service.active ||
                forced.service.pid !== null ||
                forced.service.state !== 'stopped'
              ) {
                throw new RuntimeHostServiceManagerError(
                  'retirement_failed',
                  'The unreachable Runtime Host did not reach a stable stopped state',
                );
              }
              retirement = {
                schemaVersion: 1,
                kind: 'result',
                action: 'retire',
                service: runtimeHostServiceSummary(forced),
                ...operatorCapabilities(),
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
            const staged = deployment;
            deployment = undefined;
            await staged.rollback();
            emit({ ...retirement, action: 'update' });
            return 1;
          }
          if (retirement.kind !== 'result' || retirement.action !== 'retire') {
            throw new Error(
              'The current Runtime Host operator returned an invalid retirement result',
            );
          }
          if (retirement.retirement.kind === 'active_tasks') {
            const staged = deployment;
            deployment = undefined;
            await staged.rollback();
            emit({
              schemaVersion: 1,
              kind: 'result',
              action: 'update',
              service: retirement.service,
              ...operatorCapabilities(),
              update: {
                kind: 'active_tasks',
                currentVersion,
                targetVersion: options.version,
              },
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
          if (
            updatedService.installedVersion !== options.version ||
            !updatedService.active ||
            !updatedService.config ||
            resolve(updatedService.config.launch.cliPath) !== targetCliPath
          ) {
            throw new RuntimeHostServiceManagerError(
              'update_incomplete',
              'The replacement Runtime Host did not report the selected package version as ready',
            );
          }
          await targetDeployment.cleanup();
          return {
            schemaVersion: 1,
            action: 'status',
            service: updatedService,
          } as const;
        });
        emit({
          schemaVersion: 1,
          kind: 'result',
          action: 'update',
          service: runtimeHostServiceSummary(updated),
          ...operatorCapabilities(),
          update: targetDeploymentIsCurrent
            ? { kind: 'repaired', version: options.version }
            : {
                kind: 'updated',
                previousVersion: currentVersion,
                targetVersion: options.version,
              },
        });
        return 0;
      } catch (error) {
        if (deployment && !cutoverStarted) {
          const staged = deployment;
          deployment = undefined;
          try {
            await staged.rollback();
          } catch (rollbackError) {
            throw new RuntimeHostManagedDeploymentError(
              'deployment_failed',
              'The Runtime Host update failed and its staged package could not be removed',
              { cause: new AggregateError([error, rollbackError]) },
            );
          }
        }
        throw error;
      }
    });
  } catch (error) {
    const updateIncomplete = exactTargetObserved || retired || cutoverStarted;
    const reportedError = updateIncomplete
      ? new RuntimeHostServiceManagerError(
          'update_incomplete',
          'The Runtime Host update did not complete; run the update again to reconcile the managed installation',
          { cause: error },
        )
      : error;
    const code =
      reportedError instanceof RuntimeHostServiceManagerError ||
      reportedError instanceof RuntimeHostManagedDeploymentError ||
      reportedError instanceof RuntimeHostUpdateSelectionError
        ? reportedError.code
        : 'internal_service_error';
    const message = reportedError instanceof Error ? reportedError.message : String(reportedError);
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

async function runCanonicalRuntimeHostUpdate(
  options: RuntimeHostUpdateCliOptions & { readonly managedRootId: string },
  deps: RuntimeHostUpdateCliDeps,
  emit: RuntimeHostUpdateFrameSink,
): Promise<number> {
  let staged: RuntimeHostManagedPackageDeployment | undefined;
  try {
    return await deps.withDeploymentLock(
      resolveRuntimeHostManagedControlRoot(options.managedRootId),
      async () => {
        await assertRuntimeHostManagedOperatorDeployment(
          options.managedRootId,
          options.operatorDeploymentId,
          process.argv[1] ?? '',
        );
        const rejection = await deps.revalidateSelection();
        if (rejection) {
          throw new RuntimeHostUpdateSelectionError(rejection.code, rejection.message);
        }
        const lifecycleDeps: RuntimeHostLifecycleTransactionDeps = {
          convergeOperator: (currentConfig, desiredConfig) =>
            convergeRuntimeHostManagedOperator(currentConfig, desiredConfig),
          verifyOperator: verifyRuntimeHostManagedOperator,
          resolveProvider: (requested) =>
            resolveRuntimeHostLifecycleProvider(options.managedRootId, requested),
        };
        const recovered = await resolveRecoverableRuntimeHostManagedDeployment(
          options.managedRootId,
          lifecycleDeps,
          { expectedTarget: options.expectedTarget, ensureAvailable: true },
        );
        if (recovered.kind === 'absent') {
          throw new RuntimeHostServiceManagerError(
            'not_installed',
            'The managed Runtime Host deployment is not installed',
          );
        }
        const current = recovered.config;
        assertRuntimeHostManagedOperatorConfig(
          current,
          options.operatorDeploymentId,
          process.argv[1] ?? '',
        );
        const currentStatus = await manageRuntimeHostManagedLifecycle(
          options.managedRootId,
          {
            action: 'status',
            clientDataRoot: options.clientDataRoot,
            defaultRootPath: options.defaultRootPath,
            nodePath: process.execPath,
            cliPath: process.argv[1] ?? '',
            expectedTarget: options.expectedTarget,
          },
          { resolveProvider: resolveRuntimeHostLifecycleProvider },
        );
        const targetIntegrity =
          options.registrySelection?.integrity ??
          (options.version === current.launch.package.version
            ? current.launch.package.integrity
            : undefined);
        if (!targetIntegrity) {
          throw new RuntimeHostServiceManagerError(
            'invalid_launch',
            'An exact registry package identity is required for a managed update',
          );
        }
        const expectedCurrent = options.registrySelection?.current;
        const currentCliPath = resolveRuntimeHostManagedPackageCliPath(
          current.deploymentRoot,
          current.launch.package.version,
          current.launch.package.integrity,
        );
        const targetCliPath = resolveRuntimeHostManagedPackageCliPath(
          current.deploymentRoot,
          options.version,
          targetIntegrity,
        );
        const selectedDeploymentStillCurrent =
          !expectedCurrent ||
          (current.launch.package.version === expectedCurrent.version &&
            currentCliPath === resolve(expectedCurrent.cliPath));
        const targetDeploymentIsCurrent =
          current.launch.package.version === options.version && currentCliPath === targetCliPath;
        if (!selectedDeploymentStillCurrent && !targetDeploymentIsCurrent) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The managed Runtime Host changed after its update candidate was selected',
          );
        }
        if (
          options.version === current.launch.package.version &&
          targetIntegrity === current.launch.package.integrity
        ) {
          await deps.prunePackages(current);
          emit({
            schemaVersion: 1,
            kind: 'result',
            action: 'update',
            service: runtimeHostServiceSummary(currentStatus),
            ...operatorCapabilities(),
            update: { kind: 'already_current', version: options.version },
          });
          return 0;
        }
        emit(progress('checking', current.launch.package.version, options.version));
        emit(progress('staging', current.launch.package.version, options.version));
        staged = await deps.prepareDeployment({
          serviceId: options.managedRootId,
          clientDataRoot: options.clientDataRoot,
          sourcePackageRoot: options.sourcePackageRoot,
          version: options.version,
          packageIntegrity: targetIntegrity,
          deploymentRoot: current.deploymentRoot,
        });
        const desired = {
          ...current,
          configRevision: current.configRevision + 1,
          launch: {
            ...current.launch,
            package: {
              kind: 'npm_registry' as const,
              version: options.version,
              integrity: targetIntegrity,
            },
          },
        };
        emit(progress('retiring', current.launch.package.version, options.version));
        emit(progress('replacing', current.launch.package.version, options.version));
        const replacement = await replaceRuntimeHostLifecycle({
          operation: 'update',
          current,
          desired,
          allowInterruptActiveTasks: options.allowInterruptActiveTasks ?? false,
          ...(desired.lifecycle.mode === 'on_demand'
            ? {
                activateDesired: async () => {
                  await deps.activateDesired({ rootId: options.managedRootId });
                },
              }
            : {}),
          deps: lifecycleDeps,
        });
        if (replacement.kind === 'active_tasks') {
          await staged.rollback();
          staged = undefined;
          emit({
            schemaVersion: 1,
            kind: 'result',
            action: 'update',
            service: runtimeHostServiceSummary(currentStatus),
            ...operatorCapabilities(),
            update: {
              kind: 'active_tasks',
              currentVersion: current.launch.package.version,
              targetVersion: options.version,
            },
          });
          return 1;
        }
        staged = undefined;
        await deps.prunePackages(desired);
        const updated = await manageRuntimeHostManagedLifecycle(
          options.managedRootId,
          {
            action: 'status',
            clientDataRoot: options.clientDataRoot,
            defaultRootPath: options.defaultRootPath,
            nodePath: process.execPath,
            cliPath: process.argv[1] ?? '',
            expectedTarget: options.expectedTarget,
          },
          { resolveProvider: resolveRuntimeHostLifecycleProvider },
        );
        emit({
          schemaVersion: 1,
          kind: 'result',
          action: 'update',
          service: runtimeHostServiceSummary(updated),
          ...operatorCapabilities(),
          update: {
            kind: 'updated',
            previousVersion: current.launch.package.version,
            targetVersion: options.version,
          },
        });
        return 0;
      },
    );
  } catch (error) {
    if (staged && canDiscardRuntimeHostLifecycleDesiredArtifacts(error)) {
      await staged.rollback().catch(() => undefined);
    }
    const code =
      error instanceof RuntimeHostServiceManagerError ||
      error instanceof RuntimeHostManagedDeploymentError ||
      error instanceof RuntimeHostDeploymentAuthorityError
        ? error.code
        : 'update_incomplete';
    emit({
      schemaVersion: 1,
      kind: 'error',
      action: 'update',
      error: {
        code: truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES),
        message: truncateUtf8(
          error instanceof Error ? error.message : String(error),
          RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
        ),
      },
    });
    return 1;
  }
}

export async function runManagedRuntimeHostSelectedUpdateCli(
  options: RuntimeHostSelectedUpdateCliOptions,
  overrides: Partial<RuntimeHostSelectedUpdateCliDeps> = {},
  frameSink?: RuntimeHostUpdateFrameSink,
): Promise<number> {
  const deps: RuntimeHostSelectedUpdateCliDeps = {
    revalidateSelection: async () => undefined,
    resolveSelection: resolveManagedRuntimeHostUpdateSelection,
    withPackage: withRuntimeHostRegistryUpdatePackage,
    update: runManagedRuntimeHostUpdateCli,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
  const emit =
    frameSink ?? ((frame: RuntimeHostUpdateFrame) => presentUpdateFrame(frame, options, deps));

  try {
    const selection = await deps.resolveSelection({
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      selector: options.selector,
      expectedTarget: options.expectedTarget,
      ...(options.managedRootId ? { managedRootId: options.managedRootId } : {}),
      ...(options.operatorDeploymentId
        ? { operatorDeploymentId: options.operatorDeploymentId }
        : {}),
    });
    return await runManagedRuntimeHostResolvedUpdateCli(options, selection, deps, emit);
  } catch (error) {
    const code =
      error instanceof RuntimeHostUpdateDiscoveryError ||
      error instanceof RuntimeHostServiceManagerError ||
      error instanceof RuntimeHostUpdatePackageError
        ? error.code
        : 'update_resolution_failed';
    const message = error instanceof Error ? error.message : String(error);
    emit({
      schemaVersion: 1,
      kind: 'error',
      action: 'update',
      error: {
        code:
          truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES) ||
          'update_resolution_failed',
        message:
          truncateUtf8(message, RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES) ||
          'Unable to prepare the Runtime Host update',
      },
    });
    return 1;
  }
}

export async function runManagedRuntimeHostResolvedUpdateCli(
  options: RuntimeHostSelectedUpdateCliOptions,
  selection: RuntimeHostUpdateSelection,
  overrides: Partial<RuntimeHostResolvedUpdateCliDeps>,
  frameSink: RuntimeHostUpdateFrameSink,
): Promise<number> {
  const deps: RuntimeHostResolvedUpdateCliDeps = {
    revalidateSelection: async () => undefined,
    withPackage: withRuntimeHostRegistryUpdatePackage,
    update: runManagedRuntimeHostUpdateCli,
    ...overrides,
  };

  try {
    if (selection.outcome.kind === 'manual_action') {
      frameSink({
        schemaVersion: 1,
        kind: 'error',
        action: 'update',
        error: {
          code: 'update_not_admitted',
          message: manualUpdateRequiredMessage(
            selection.candidate.version,
            selection.outcome.reason,
          ),
        },
      });
      return 1;
    }

    const apply = async (packageRoot: string) => {
      const { selector: _selector, ...updateOptions } = options;
      return await deps.update(
        {
          ...updateOptions,
          sourcePackageRoot: packageRoot,
          version: selection.candidate.version,
          registrySelection: {
            integrity: selection.candidate.integrity,
            current: {
              version: selection.service.installedVersion,
              cliPath: selection.currentCliPath,
            },
          },
        },
        { revalidateSelection: deps.revalidateSelection },
        frameSink,
      );
    };
    return selection.outcome.kind === 'current'
      ? await apply(dirname(dirname(selection.currentCliPath)))
      : await deps.withPackage(selection.candidate, apply);
  } catch (error) {
    const code =
      error instanceof RuntimeHostUpdateDiscoveryError ||
      error instanceof RuntimeHostServiceManagerError ||
      error instanceof RuntimeHostUpdatePackageError
        ? error.code
        : 'update_resolution_failed';
    const message = error instanceof Error ? error.message : String(error);
    frameSink({
      schemaVersion: 1,
      kind: 'error',
      action: 'update',
      error: {
        code:
          truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES) ||
          'update_resolution_failed',
        message:
          truncateUtf8(message, RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES) ||
          'Unable to prepare the Runtime Host update',
      },
    });
    return 1;
  }
}

function presentUpdateFrame(
  frame: RuntimeHostUpdateFrame,
  options: Pick<RuntimeHostUpdateCliOptions, 'json' | 'framed'>,
  deps: Pick<RuntimeHostSelectedUpdateCliDeps, 'writeOutput' | 'writeError'>,
): void {
  if (options.framed) {
    deps.writeOutput(encodeRuntimeHostServiceManagementFrame(frame));
  } else if (frame.kind === 'progress') {
    if (!options.json) deps.writeError(`${humanPhase(frame.phase)}\n`);
  } else if (options.json) {
    deps.writeOutput(`${JSON.stringify(frame)}\n`);
  } else if (frame.kind === 'error') {
    deps.writeError(`${frame.error.message}\n`);
  } else {
    if (frame.action !== 'update') {
      throw new TypeError('Managed Runtime Host update returned an unrelated result');
    }
    deps.writeOutput(`${humanResult(frame)}\n`);
  }
}

function progress(
  phase: RuntimeHostServiceUpdatePhase,
  currentVersion: string,
  targetVersion: string,
): RuntimeHostUpdateFrame {
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
    ? {
        operatorCapabilities: [RUNTIME_HOST_OPERATOR_ACCESS_MANAGEMENT_CAPABILITY],
      }
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
  if (frame.update.previousVersion === frame.update.targetVersion) {
    return `Runtime Host package ${frame.update.targetVersion} was updated.`;
  }
  return `Runtime Host was updated from ${frame.update.previousVersion} to ${frame.update.targetVersion}.`;
}

function manualUpdateRequiredMessage(
  targetVersion: string,
  reason:
    | 'target_not_newer'
    | 'current_compatibility_unknown'
    | 'target_compatibility_unknown'
    | 'compatibility_mismatch',
): string {
  if (reason === 'target_not_newer') {
    return `Maka ${targetVersion} is older than the installed Runtime Host and will not be applied automatically`;
  }
  if (reason === 'current_compatibility_unknown') {
    return 'The installed Runtime Host does not publish enough compatibility evidence for an automatic update';
  }
  if (reason === 'target_compatibility_unknown') {
    return `Maka ${targetVersion} does not publish enough compatibility evidence for an automatic update`;
  }
  return `Maka ${targetVersion} requires an explicit manual compatibility transition`;
}
