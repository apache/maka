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
import { isDeepStrictEqual } from 'node:util';
import {
  encodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV,
  RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY,
  RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES,
  RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES,
  type RuntimeHostManagedUpdatePolicy,
  type RuntimeHostServiceManagementFrame,
  type RuntimeHostUpdateSchedulerState,
} from '@maka/runtime-host/operator';
import {
  manageRuntimeHostService,
  resolveRuntimeHostManagedServiceId,
  RuntimeHostServiceManagerError,
  withRuntimeHostManagedServiceDeploymentLock,
  type RuntimeHostManagedServiceTarget,
  type RuntimeHostServiceBackend,
} from './runtime-host-service-manager.js';
import {
  createPlatformRuntimeHostServiceBackend,
  runtimeHostServiceSummary,
} from './runtime-host-service-management-command.js';
import {
  readRuntimeHostManagedUpdatePolicy,
  RuntimeHostUpdatePolicyError,
  writeRuntimeHostManagedUpdatePolicy,
  type RuntimeHostManagedUpdatePolicyRecord,
} from './runtime-host-update-policy-store.js';
import {
  runManagedRuntimeHostResolvedUpdateCli,
  type RuntimeHostSelectedUpdateCliOptions,
  type RuntimeHostUpdateFrame,
} from './runtime-host-update-command.js';
import {
  resolveManagedRuntimeHostUpdateSelection,
  RuntimeHostUpdateDiscoveryError,
} from './runtime-host-update-discovery.js';
import type { RuntimeHostUpdateSelector } from './runtime-host-cli.js';

type UpdatePolicyFrame = Extract<RuntimeHostServiceManagementFrame, { action: 'update_policy' }>;
type ReconcileUpdateFrame = Extract<
  RuntimeHostServiceManagementFrame,
  { action: 'reconcile_update' }
>;

interface RuntimeHostUpdatePolicyCliOptions {
  readonly json: boolean;
  readonly framed: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly policy?: RuntimeHostManagedUpdatePolicy;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

interface RuntimeHostUpdateReconcileCliOptions {
  readonly json: boolean;
  readonly framed: boolean;
  readonly clientDataRoot: string;
  readonly defaultRootPath: string;
  readonly expectedTarget?: RuntimeHostManagedServiceTarget;
}

interface RuntimeHostUpdateReconciliationDeps {
  readonly withDeploymentLock: typeof withRuntimeHostManagedServiceDeploymentLock;
  readonly readPolicy: typeof readRuntimeHostManagedUpdatePolicy;
  readonly writePolicy: typeof writeRuntimeHostManagedUpdatePolicy;
  readonly manage: typeof manageRuntimeHostService;
  readonly createBackend: (serviceId: string, clientDataRoot: string) => RuntimeHostServiceBackend;
  readonly resolveSelection: typeof resolveManagedRuntimeHostUpdateSelection;
  readonly applySelection: typeof runManagedRuntimeHostResolvedUpdateCli;
  readonly writeOutput: (value: string) => unknown;
  readonly writeError: (value: string) => unknown;
}

export async function runManagedRuntimeHostUpdatePolicyCli(
  options: RuntimeHostUpdatePolicyCliOptions,
  overrides: Partial<RuntimeHostUpdateReconciliationDeps> = {},
): Promise<number> {
  const deps = reconciliationDeps(overrides);
  try {
    const requestedPolicy = options.policy;
    const snapshot = await deps.withDeploymentLock(options.clientDataRoot, async () => {
      const expectedTarget = options.expectedTarget;
      const status = await readManagedServiceStatus(options, deps, expectedTarget);
      const managedDeploymentRoot = status.service.config?.managedDeploymentRoot;
      const updateSchedulerState = await inspectUpdateScheduler(options, status, deps);
      if (!requestedPolicy) {
        return {
          record:
            status.service.installed && managedDeploymentRoot
              ? await deps.readPolicy(managedDeploymentRoot)
              : null,
          updateSchedulerState,
        };
      }
      if (requestedPolicy.kind === 'manual') {
        if (managedDeploymentRoot) await deps.writePolicy(managedDeploymentRoot, null);
        return { record: null, updateSchedulerState };
      }
      if (!expectedTarget) {
        throw new RuntimeHostUpdatePolicyError(
          'invalid_update_policy',
          'An automatic Runtime Host update policy requires the expected managed service target',
        );
      }
      if (!status.service.installed || !managedDeploymentRoot) {
        throw new RuntimeHostServiceManagerError(
          'not_installed',
          'An automatic update policy requires a Maka-managed Runtime Host service',
        );
      }
      if (updateSchedulerState !== 'ready') {
        throw new RuntimeHostServiceManagerError(
          'target_mismatch',
          'The Runtime Host update scheduler must be running before enabling automatic updates',
        );
      }
      const record: RuntimeHostManagedUpdatePolicyRecord = {
        schemaVersion: 1,
        policy: requestedPolicy,
        target: {
          ...expectedTarget,
          rootPath: status.service.config.rootPath,
        },
      };
      await deps.writePolicy(managedDeploymentRoot, record);
      return { record, updateSchedulerState };
    });
    writeFrame(updatePolicyResult(snapshot.record, snapshot.updateSchedulerState), options, deps);
    return 0;
  } catch (error) {
    writeFrame(updatePolicyError(error), options, deps);
    return 1;
  }
}

export async function runManagedRuntimeHostUpdateReconcileCli(
  options: RuntimeHostUpdateReconcileCliOptions,
  overrides: Partial<RuntimeHostUpdateReconciliationDeps> = {},
): Promise<number> {
  const deps = reconciliationDeps(overrides);
  try {
    const snapshot = await deps.withDeploymentLock(options.clientDataRoot, async () => {
      const status = await readManagedServiceStatus(options, deps, options.expectedTarget);
      const managedDeploymentRoot = status.service.config?.managedDeploymentRoot;
      return {
        updateSchedulerState: await inspectUpdateScheduler(options, status, deps),
        policy:
          status.service.installed && managedDeploymentRoot
            ? {
                root: managedDeploymentRoot,
                record: await deps.readPolicy(managedDeploymentRoot),
              }
            : undefined,
      };
    });
    const { policy, updateSchedulerState } = snapshot;
    if (!policy?.record) {
      writeFrame(
        {
          schemaVersion: 1,
          kind: 'result',
          action: 'reconcile_update',
          ...requestedUpdateSchedulerState(updateSchedulerState),
          updatePolicy: { policy: { kind: 'manual' } },
          reconciliation: { kind: 'disabled' },
        },
        options,
        deps,
      );
      return 0;
    }
    const { root: policyRoot, record } = policy;
    const selection = await deps.resolveSelection({
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      selector: policySelector(record.policy),
      expectedTarget: record.target,
    });
    const updatePolicy = policyResult(record);
    if (selection.outcome.kind === 'manual_action') {
      writeFrame(
        {
          schemaVersion: 1,
          kind: 'result',
          action: 'reconcile_update',
          ...requestedUpdateSchedulerState(updateSchedulerState),
          updatePolicy,
          service: selection.service,
          reconciliation: {
            kind: 'manual_action',
            candidate: {
              version: selection.candidate.version,
              integrity: selection.candidate.integrity,
            },
            reason: selection.outcome.reason,
          },
        },
        options,
        deps,
      );
      return 1;
    }

    let terminal: ReconcileUpdateFrame | undefined;
    const selectedOptions: RuntimeHostSelectedUpdateCliOptions = {
      json: false,
      framed: false,
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      selector: selection.selector,
      expectedTarget: record.target,
    };
    const exitCode = await deps.applySelection(
      selectedOptions,
      selection,
      {
        revalidateSelection: async () => {
          let current: RuntimeHostManagedUpdatePolicyRecord | null;
          try {
            current = await deps.readPolicy(policyRoot);
          } catch (error) {
            return boundedError(error, 'Unable to revalidate the managed update policy');
          }
          if (!isDeepStrictEqual(current, record)) {
            return {
              code: 'update_policy_changed',
              message:
                'The managed Runtime Host update policy changed while its candidate was prepared; reconciliation made no changes',
            };
          }
          return undefined;
        },
      },
      (frame) => {
        const mapped = reconcileFrame(frame, updatePolicy, updateSchedulerState);
        writeFrame(mapped, options, deps);
        if (mapped.kind !== 'progress') terminal = mapped;
      },
    );
    if (!terminal) {
      throw new Error('The managed Runtime Host update did not return a terminal result');
    }
    return exitCode;
  } catch (error) {
    writeFrame(reconcileError(error), options, deps);
    return 1;
  }
}

function readManagedServiceStatus(
  options: Pick<
    RuntimeHostUpdatePolicyCliOptions | RuntimeHostUpdateReconcileCliOptions,
    'clientDataRoot' | 'defaultRootPath'
  >,
  deps: RuntimeHostUpdateReconciliationDeps,
  expectedTarget?: RuntimeHostManagedServiceTarget,
) {
  const serviceId = resolveRuntimeHostManagedServiceId(options.clientDataRoot);
  return deps.manage(
    {
      action: 'status',
      clientDataRoot: options.clientDataRoot,
      defaultRootPath: options.defaultRootPath,
      nodePath: process.execPath,
      cliPath: process.argv[1] ?? '',
      ...(expectedTarget ? { expectedTarget } : {}),
    },
    deps.createBackend(serviceId, options.clientDataRoot),
  );
}

async function inspectUpdateScheduler(
  options: Pick<RuntimeHostUpdatePolicyCliOptions, 'clientDataRoot'>,
  status: Awaited<ReturnType<typeof readManagedServiceStatus>>,
  deps: RuntimeHostUpdateReconciliationDeps,
): Promise<RuntimeHostUpdateSchedulerState> {
  const config = status.service.config;
  if (!status.service.installed || !config?.managedDeploymentRoot) return 'needs_repair';
  const backend = deps.createBackend(
    resolveRuntimeHostManagedServiceId(options.clientDataRoot),
    options.clientDataRoot,
  );
  try {
    await backend.verifyDeployment(config, { requireSchedulerReady: true });
    return 'ready';
  } catch (error) {
    if (!(error instanceof RuntimeHostServiceManagerError)) throw error;
    if (error.code === 'invalid_launch') return 'needs_repair';
    if (error.code !== 'target_mismatch') throw error;
  }
  try {
    await backend.verifyDeployment(config);
    return 'inactive';
  } catch (error) {
    if (
      error instanceof RuntimeHostServiceManagerError &&
      (error.code === 'target_mismatch' || error.code === 'invalid_launch')
    ) {
      return 'needs_repair';
    }
    throw error;
  }
}

function reconciliationDeps(
  overrides: Partial<RuntimeHostUpdateReconciliationDeps>,
): RuntimeHostUpdateReconciliationDeps {
  return {
    withDeploymentLock: withRuntimeHostManagedServiceDeploymentLock,
    readPolicy: readRuntimeHostManagedUpdatePolicy,
    writePolicy: writeRuntimeHostManagedUpdatePolicy,
    manage: manageRuntimeHostService,
    createBackend: createPlatformRuntimeHostServiceBackend,
    resolveSelection: resolveManagedRuntimeHostUpdateSelection,
    applySelection: runManagedRuntimeHostResolvedUpdateCli,
    writeOutput: (value) => process.stdout.write(value),
    writeError: (value) => process.stderr.write(value),
    ...overrides,
  };
}

function updatePolicyResult(
  record: RuntimeHostManagedUpdatePolicyRecord | null,
  updateSchedulerState: RuntimeHostUpdateSchedulerState,
): UpdatePolicyFrame {
  return {
    schemaVersion: 1,
    kind: 'result',
    action: 'update_policy',
    ...requestedUpdateSchedulerState(updateSchedulerState),
    updatePolicy: policyResult(record),
  };
}

function policyResult(record: RuntimeHostManagedUpdatePolicyRecord | null) {
  return record
    ? { policy: record.policy, target: record.target }
    : { policy: { kind: 'manual' as const } };
}

function policySelector(
  policy: RuntimeHostManagedUpdatePolicyRecord['policy'],
): RuntimeHostUpdateSelector {
  return policy.kind === 'fixed'
    ? { kind: 'exact', version: policy.version }
    : { kind: 'channel', channel: policy.channel };
}

function reconcileFrame(
  frame: RuntimeHostUpdateFrame,
  updatePolicy: ReturnType<typeof policyResult>,
  observedSchedulerState: RuntimeHostUpdateSchedulerState,
): ReconcileUpdateFrame {
  if (frame.kind === 'progress') {
    return { ...frame, action: 'reconcile_update' };
  }
  if (frame.kind === 'error') {
    return { ...frame, action: 'reconcile_update' };
  }
  return {
    schemaVersion: 1,
    kind: 'result',
    action: 'reconcile_update',
    ...requestedUpdateSchedulerState(
      frame.update.kind === 'updated' ||
        frame.update.kind === 'repaired' ||
        frame.update.kind === 'already_current'
        ? 'ready'
        : observedSchedulerState,
    ),
    updatePolicy,
    service: frame.service,
    reconciliation: frame.update,
  };
}

function requestedUpdateSchedulerState(updateSchedulerState: RuntimeHostUpdateSchedulerState): {
  readonly updateSchedulerState?: RuntimeHostUpdateSchedulerState;
} {
  return process.env[RUNTIME_HOST_OPERATOR_CAPABILITY_REQUEST_ENV] ===
    RUNTIME_HOST_OPERATOR_UPDATE_SCHEDULER_CAPABILITY
    ? {
        updateSchedulerState,
      }
    : {};
}

function updatePolicyError(error: unknown): UpdatePolicyFrame {
  return {
    schemaVersion: 1,
    kind: 'error',
    action: 'update_policy',
    error: boundedError(error, 'Unable to manage the Runtime Host update policy'),
  };
}

function reconcileError(error: unknown): ReconcileUpdateFrame {
  return {
    schemaVersion: 1,
    kind: 'error',
    action: 'reconcile_update',
    error: boundedError(error, 'Unable to reconcile the managed Runtime Host update'),
  };
}

function boundedError(error: unknown, fallback: string): { code: string; message: string } {
  const code =
    error instanceof RuntimeHostUpdatePolicyError ||
    error instanceof RuntimeHostUpdateDiscoveryError ||
    error instanceof RuntimeHostServiceManagerError
      ? error.code
      : 'update_reconciliation_failed';
  const message = error instanceof Error ? error.message : String(error);
  return {
    code:
      truncateUtf8(code, RUNTIME_HOST_SERVICE_ERROR_CODE_MAX_BYTES) ||
      'update_reconciliation_failed',
    message: truncateUtf8(message, RUNTIME_HOST_SERVICE_ERROR_MESSAGE_MAX_BYTES) || fallback,
  };
}

function writeFrame(
  frame: UpdatePolicyFrame | ReconcileUpdateFrame,
  options: { readonly json: boolean; readonly framed: boolean },
  deps: Pick<RuntimeHostUpdateReconciliationDeps, 'writeOutput' | 'writeError'>,
): void {
  if (frame.kind === 'progress') {
    if (options.framed) {
      deps.writeOutput(encodeRuntimeHostServiceManagementFrame(frame));
    } else if (!options.json) {
      deps.writeError(
        `Reconciling Maka ${frame.currentVersion} toward ${frame.targetVersion} (${frame.phase})...\n`,
      );
    }
    return;
  }
  if (options.framed) {
    deps.writeOutput(encodeRuntimeHostServiceManagementFrame(frame));
    return;
  }
  if (options.json) {
    deps.writeOutput(`${JSON.stringify(frame)}\n`);
    return;
  }
  if (frame.kind === 'error') {
    deps.writeError(`${frame.error.message}\n`);
    return;
  }
  deps.writeOutput(`${humanResult(frame)}\n`);
}

function humanResult(frame: Extract<UpdatePolicyFrame | ReconcileUpdateFrame, { kind: 'result' }>) {
  if (frame.action === 'update_policy') {
    const policy = frame.updatePolicy.policy;
    return policy.kind === 'manual'
      ? 'Managed Runtime Host updates are manual.'
      : policy.kind === 'fixed'
        ? `Managed Runtime Host updates are fixed at ${policy.version}.`
        : `Managed Runtime Host updates follow the ${policy.channel} channel.`;
  }
  const result = frame.reconciliation;
  if (result.kind === 'disabled') return 'Managed Runtime Host automatic updates are disabled.';
  if (result.kind === 'manual_action') {
    return `Maka ${result.candidate.version} requires manual update action (${result.reason}).`;
  }
  if (result.kind === 'active_tasks') {
    return 'The managed Runtime Host still owns active work; the update remains pending.';
  }
  if (result.kind === 'already_current') {
    return `The managed Runtime Host is current at Maka ${result.version}.`;
  }
  if (result.kind === 'repaired') {
    return `The managed Runtime Host deployment for Maka ${result.version} was repaired.`;
  }
  return `The managed Runtime Host was updated from Maka ${result.previousVersion} to ${result.targetVersion}.`;
}
