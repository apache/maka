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

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveXdgConfigHome } from '@maka/storage/workspace-root';
import {
  formatRuntimeHostServiceLogs,
  removeRuntimeHostServiceFile,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostServiceBackend,
  type RuntimeHostServiceBackendStatus,
  type RuntimeHostServiceDeployment,
  writeRuntimeHostServiceFile,
} from './runtime-host-service-manager.js';
import {
  RUNTIME_HOST_UPDATE_INITIAL_DELAY_SECONDS,
  RUNTIME_HOST_UPDATE_INTERVAL_SECONDS,
  RUNTIME_HOST_UPDATE_RANDOM_DELAY_SECONDS,
  runtimeHostServiceLaunchArguments,
  runtimeHostUpdateReconcileLaunchArguments,
  validateRuntimeHostServiceLaunch,
} from './runtime-host-service-launch.js';
import {
  runRuntimeHostServiceManagerCommand,
  type RuntimeHostServiceManagerCommandResult,
} from './runtime-host-service-manager-process.js';

interface SystemdUnitContext {
  readonly unitName: string;
  readonly unitPath: string;
  readonly runSystemctl: (
    args: readonly string[],
  ) => Promise<RuntimeHostServiceManagerCommandResult>;
}

interface SystemdUpdateSchedulerContext {
  readonly serviceId: string;
  readonly service: SystemdUnitContext;
  readonly timer: SystemdUnitContext;
}

export interface SystemdUserServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly uid?: number;
  readonly runSystemctl?: (
    args: readonly string[],
  ) => Promise<RuntimeHostServiceManagerCommandResult>;
  readonly runLoginctl?: (
    args: readonly string[],
  ) => Promise<RuntimeHostServiceManagerCommandResult>;
  readonly runJournalctl?: (
    args: readonly string[],
  ) => Promise<RuntimeHostServiceManagerCommandResult>;
}

export function createSystemdUserRuntimeHostService(
  serviceId: string,
  options: SystemdUserServiceOptions = {},
): RuntimeHostServiceBackend {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl;
  const context: SystemdUnitContext = {
    unitName: resolveSystemdUserRuntimeHostServiceName(serviceId),
    unitPath: resolveSystemdUserRuntimeHostServicePath(serviceId, env, homeDir),
    runSystemctl,
  };
  const scheduler = resolveSystemdUpdateSchedulerContext(serviceId, env, homeDir, runSystemctl);
  const runLoginctl = options.runLoginctl ?? defaultRunLoginctl;
  const runJournalctl = options.runJournalctl ?? defaultRunJournalctl;
  const uid = options.uid ?? process.getuid?.();

  const readStatus = async (): Promise<RuntimeHostServiceBackendStatus> => {
    const raw = await readSystemdStatus(context);
    return {
      manager: 'systemd_user',
      installed: raw.loadState !== 'not-found',
      enabled: raw.unitFileState === 'enabled' || raw.unitFileState === 'enabled-runtime',
      active: raw.activeState === 'active',
      state: systemdServiceState(raw.loadState, raw.activeState),
      pid: positiveInteger(raw.mainPid),
      lastExitCode: nonNegativeInteger(raw.execMainStatus),
    };
  };

  return {
    preflightInstall: async () => {
      await assertUserSystemd(runSystemctl);
      await assertUserLinger(uid, runLoginctl);
    },
    install: async (config) => {
      await validateRuntimeHostServiceLaunch(config);
      const [previous, previousScheduler] = await Promise.all([
        captureSystemdDeployment(context.unitPath, readStatus),
        captureSystemdUpdateScheduler(scheduler),
      ]);
      await assertNoSystemdUpdateSchedulerDropIns(scheduler);
      let schedulerMutationStarted = false;
      try {
        await applySystemdDeployment(context, config);
        await applySystemdUpdateSchedulerDesiredState(scheduler, config, () => {
          schedulerMutationStarted = true;
        });
      } catch (error) {
        await restoreFailedSystemdDeployment(
          previous,
          schedulerMutationStarted ? previousScheduler : undefined,
          context,
          scheduler,
          error,
        );
      }
      let rolledBack = false;
      return {
        rollback: async () => {
          if (rolledBack) return;
          rolledBack = true;
          await restoreSystemdManagedDeployment(
            previous,
            schedulerMutationStarted ? previousScheduler : undefined,
            context,
            scheduler,
          );
        },
      } satisfies RuntimeHostServiceDeployment;
    },
    replace: async (config) => {
      await validateRuntimeHostServiceLaunch(config);
      const [previous, previousScheduler] = await Promise.all([
        captureSystemdDeployment(context.unitPath, readStatus),
        captureSystemdUpdateScheduler(scheduler),
      ]);
      let schedulerMutationStarted = false;
      try {
        await applySystemdDeployment(context, config);
        await convergeSystemdUpdateSchedulerForReplacement(scheduler, config, () => {
          schedulerMutationStarted = true;
        });
      } catch (error) {
        await restoreFailedSystemdDeployment(
          previous,
          schedulerMutationStarted ? previousScheduler : undefined,
          context,
          scheduler,
          error,
          'update_incomplete',
        );
      }
    },
    verifyReplacementPreconditions: (config) =>
      verifySystemdUpdateSchedulerReplacementState(scheduler, config),
    verifyDeployment: async (config, options) => {
      await validateRuntimeHostServiceLaunch(config);
      const [status, unit] = await Promise.all([
        readSystemdStatus(context),
        readFile(context.unitPath, 'utf8').catch((error: unknown) => {
          if (isNodeError(error, 'ENOENT')) return null;
          throw error;
        }),
      ]);
      if (
        status.loadState !== 'loaded' ||
        status.fragmentPath !== context.unitPath ||
        status.needDaemonReload !== 'no' ||
        Boolean(status.dropInPaths?.trim()) ||
        unit !== renderSystemdUnit(config)
      ) {
        throw new RuntimeHostServiceManagerError(
          'target_mismatch',
          'The loaded Runtime Host service does not match its managed deployment',
        );
      }
      await verifySystemdUpdateSchedulerDesiredState(
        scheduler,
        config,
        options?.requireSchedulerReady ?? false,
      );
    },
    status: readStatus,
    start: async () => {
      await runLifecycleAction(context, 'start');
      await ensureSystemdUpdateSchedulerStartedIfInstalled(scheduler);
    },
    stop: () => stopSystemdManagedDeployment(context, scheduler),
    restart: async () => {
      await runLifecycleAction(context, 'restart');
      await ensureSystemdUpdateSchedulerStartedIfInstalled(scheduler);
    },
    retire: () => runLifecycleAction(context, 'stop'),
    logs: async () => {
      const readJournal = async (unitName: string): Promise<string> => {
        const result = await runJournalctl([
          '--user-unit',
          unitName,
          '--no-pager',
          '--lines=200',
          '--output=short-iso',
        ]).catch((error) => {
          throw new RuntimeHostServiceManagerError(
            'service_manager_unavailable',
            'Unable to read Runtime Host service logs',
            { cause: error },
          );
        });
        if (result.exitCode !== 0) {
          throw managerError('Reading Runtime Host service logs failed', result);
        }
        return result.stdout;
      };
      const [hostLogs, updateLogs] = await Promise.all([
        readJournal(context.unitName),
        readJournal(scheduler.service.unitName),
      ]);
      return formatRuntimeHostServiceLogs([
        { label: 'host', logs: hostLogs },
        { label: 'update', logs: updateLogs },
      ]);
    },
    uninstall: async () => {
      await removeSystemdUpdateScheduler(scheduler);
      const before = await readSystemdStatus(context);
      if (before.loadState !== 'not-found') {
        await requireSystemctl(
          runSystemctl,
          ['stop', context.unitName],
          'Stopping the Runtime Host service failed',
        );
      }
      if (
        before.loadState !== 'not-found' ||
        before.unitFileState === 'enabled' ||
        before.unitFileState === 'enabled-runtime'
      ) {
        await requireSystemctl(
          runSystemctl,
          ['disable', context.unitName],
          'Disabling the Runtime Host service failed',
        );
        await runSystemctl(['reset-failed', context.unitName]);
      }
      await removeRuntimeHostServiceFile(context.unitPath, 'systemd unit');
      await requireSystemctl(runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
      const after = await readStatus();
      if (after.installed || after.active || after.enabled) {
        throw new RuntimeHostServiceManagerError(
          'uninstall_incomplete',
          `Runtime Host systemd service still has managed state: ${after.state}`,
        );
      }
    },
  };
}

export function resolveSystemdUserRuntimeHostServicePath(
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  const systemdConfigRoot = resolveXdgConfigHome(env, homeDir);
  return join(
    systemdConfigRoot,
    'systemd',
    'user',
    resolveSystemdUserRuntimeHostServiceName(serviceId),
  );
}

export function resolveSystemdUserRuntimeHostUpdateServicePath(
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  return join(
    resolveXdgConfigHome(env, homeDir),
    'systemd',
    'user',
    resolveSystemdUserRuntimeHostUpdateServiceName(serviceId),
  );
}

export function resolveSystemdUserRuntimeHostUpdateTimerPath(
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  return join(
    resolveXdgConfigHome(env, homeDir),
    'systemd',
    'user',
    resolveSystemdUserRuntimeHostUpdateTimerName(serviceId),
  );
}

function resolveSystemdUserRuntimeHostServiceName(serviceId: string): string {
  assertServiceId(serviceId);
  return `maka-runtime-host-${serviceId}.service`;
}

function resolveSystemdUserRuntimeHostUpdateServiceName(serviceId: string): string {
  assertServiceId(serviceId);
  return `maka-runtime-host-${serviceId}-update.service`;
}

function resolveSystemdUserRuntimeHostUpdateTimerName(serviceId: string): string {
  assertServiceId(serviceId);
  return `maka-runtime-host-${serviceId}-update.timer`;
}

export function renderSystemdUnit(config: RuntimeHostManagedServiceConfig): string {
  const args = runtimeHostServiceLaunchArguments(config);
  return [
    '[Unit]',
    'Description=Maka Runtime Host',
    'After=network.target',
    'StartLimitIntervalSec=60s',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${args.map(quoteSystemdArgument).join(' ')}`,
    'Restart=on-failure',
    'RestartSec=2s',
    'KillMode=mixed',
    'TimeoutStopSec=45s',
    'UMask=0077',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

export function renderSystemdUpdateService(config: RuntimeHostManagedServiceConfig): string {
  const args = runtimeHostUpdateReconcileLaunchArguments(config);
  if (!args) throw new TypeError('Managed deployment root is required for update scheduling');
  return [
    '[Unit]',
    'Description=Maka Runtime Host update reconciliation',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${args.map(quoteSystemdArgument).join(' ')}`,
    'UMask=0077',
    '',
  ].join('\n');
}

export function renderSystemdUpdateTimer(serviceId: string): string {
  return [
    '[Unit]',
    'Description=Schedule Maka Runtime Host update reconciliation',
    '',
    '[Timer]',
    `OnActiveSec=${String(RUNTIME_HOST_UPDATE_INITIAL_DELAY_SECONDS)}s`,
    `OnUnitInactiveSec=${String(RUNTIME_HOST_UPDATE_INTERVAL_SECONDS)}s`,
    `RandomizedDelaySec=${String(RUNTIME_HOST_UPDATE_RANDOM_DELAY_SECONDS)}s`,
    `Unit=${resolveSystemdUserRuntimeHostUpdateServiceName(serviceId)}`,
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

interface SystemdStatus {
  readonly loadState: string;
  readonly activeState: string;
  readonly unitFileState: string;
  readonly fragmentPath?: string;
  readonly needDaemonReload?: string;
  readonly dropInPaths?: string;
  readonly mainPid?: string;
  readonly execMainStatus?: string;
}

interface SystemdDeploymentSnapshot {
  readonly unit: string | null;
  readonly status: RuntimeHostServiceBackendStatus;
}

interface SystemdUpdateSchedulerSnapshot {
  readonly serviceUnit: string | null;
  readonly timerUnit: string | null;
  readonly timerStatus: SystemdStatus;
}

function resolveSystemdUpdateSchedulerContext(
  serviceId: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
  runSystemctl: SystemdUnitContext['runSystemctl'],
): SystemdUpdateSchedulerContext {
  return {
    serviceId,
    service: {
      unitName: resolveSystemdUserRuntimeHostUpdateServiceName(serviceId),
      unitPath: resolveSystemdUserRuntimeHostUpdateServicePath(serviceId, env, homeDir),
      runSystemctl,
    },
    timer: {
      unitName: resolveSystemdUserRuntimeHostUpdateTimerName(serviceId),
      unitPath: resolveSystemdUserRuntimeHostUpdateTimerPath(serviceId, env, homeDir),
      runSystemctl,
    },
  };
}

async function captureSystemdUpdateScheduler(
  context: SystemdUpdateSchedulerContext,
): Promise<SystemdUpdateSchedulerSnapshot> {
  const [serviceUnit, timerUnit, timerStatus] = await Promise.all([
    readOptionalFile(context.service.unitPath),
    readOptionalFile(context.timer.unitPath),
    readSystemdStatus(context.timer),
  ]);
  return { serviceUnit, timerUnit, timerStatus };
}

async function applySystemdUpdateSchedulerDesiredState(
  context: SystemdUpdateSchedulerContext,
  config: RuntimeHostManagedServiceConfig,
  onMutation: () => void,
): Promise<void> {
  if (!runtimeHostUpdateReconcileLaunchArguments(config)) {
    try {
      await verifySystemdUpdateSchedulerAbsent(context);
      return;
    } catch (error) {
      if (!isTargetMismatch(error)) throw error;
    }
    onMutation();
    await removeSystemdUpdateScheduler(context);
    await verifySystemdUpdateSchedulerAbsent(context);
    return;
  }
  try {
    await verifySystemdUpdateScheduler(context, config, true);
    return;
  } catch (error) {
    if (!isTargetMismatch(error)) throw error;
  }
  onMutation();
  await Promise.all([
    writeRuntimeHostServiceFile(
      context.service.unitPath,
      renderSystemdUpdateService(config),
      0o600,
    ),
    writeRuntimeHostServiceFile(
      context.timer.unitPath,
      renderSystemdUpdateTimer(context.serviceId),
      0o600,
    ),
  ]);
  await requireSystemctl(context.timer.runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
  await requireSystemctl(
    context.timer.runSystemctl,
    ['enable', context.timer.unitName],
    'Enabling Runtime Host update reconciliation failed',
  );
  await context.timer.runSystemctl(['reset-failed', context.service.unitName]);
  await context.timer.runSystemctl(['reset-failed', context.timer.unitName]);
  await requireSystemctl(
    context.timer.runSystemctl,
    ['restart', context.timer.unitName],
    'Scheduling Runtime Host update reconciliation failed',
  );
  await verifySystemdUpdateScheduler(context, config, true);
}

async function assertNoSystemdUpdateSchedulerDropIns(
  context: SystemdUpdateSchedulerContext,
): Promise<void> {
  const [serviceStatus, timerStatus] = await Promise.all([
    readSystemdStatus(context.service),
    readSystemdStatus(context.timer),
  ]);
  if (serviceStatus.dropInPaths?.trim() || timerStatus.dropInPaths?.trim()) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      'The Runtime Host update scheduler has systemd drop-in overrides; remove them before repairing the managed deployment',
    );
  }
}

async function verifySystemdUpdateSchedulerDesiredState(
  context: SystemdUpdateSchedulerContext,
  config: RuntimeHostManagedServiceConfig,
  requireActive: boolean,
): Promise<void> {
  if (runtimeHostUpdateReconcileLaunchArguments(config)) {
    await verifySystemdUpdateScheduler(context, config, requireActive);
    return;
  }
  await verifySystemdUpdateSchedulerAbsent(context);
}

async function verifySystemdUpdateSchedulerReplacementState(
  context: SystemdUpdateSchedulerContext,
  config: RuntimeHostManagedServiceConfig,
): Promise<void> {
  if (!runtimeHostUpdateReconcileLaunchArguments(config)) {
    await verifySystemdUpdateSchedulerAbsent(context);
    return;
  }
  try {
    await verifySystemdUpdateScheduler(context, config, false);
  } catch (error) {
    if (!isTargetMismatch(error)) throw error;
    await verifySystemdUpdateSchedulerAbsent(context);
  }
}

async function convergeSystemdUpdateSchedulerForReplacement(
  context: SystemdUpdateSchedulerContext,
  config: RuntimeHostManagedServiceConfig,
  onMutation: () => void,
): Promise<void> {
  try {
    await verifySystemdUpdateScheduler(context, config, false);
    const status = await readSystemdStatus(context.timer);
    // The active scheduler may be running this replacement.
    if (status.activeState === 'active') return;
    onMutation();
    await ensureSystemdUpdateSchedulerStartedIfInstalled(context);
  } catch (error) {
    if (!isTargetMismatch(error)) throw error;
    await verifySystemdUpdateSchedulerAbsent(context);
    onMutation();
    await applySystemdUpdateSchedulerDesiredState(context, config, () => undefined);
  }
  await verifySystemdUpdateScheduler(context, config, true);
}

async function verifySystemdUpdateScheduler(
  context: SystemdUpdateSchedulerContext,
  config: RuntimeHostManagedServiceConfig,
  requireActive: boolean,
): Promise<void> {
  const [serviceUnit, timerUnit, serviceStatus, timerStatus] = await Promise.all([
    readOptionalFile(context.service.unitPath),
    readOptionalFile(context.timer.unitPath),
    readSystemdStatus(context.service),
    readSystemdStatus(context.timer),
  ]);
  if (
    serviceUnit !== renderSystemdUpdateService(config) ||
    timerUnit !== renderSystemdUpdateTimer(context.serviceId) ||
    !isLoadedManagedSystemdUnit(serviceStatus, context.service.unitPath) ||
    !isLoadedManagedSystemdUnit(timerStatus, context.timer.unitPath) ||
    (timerStatus.unitFileState !== 'enabled' && timerStatus.unitFileState !== 'enabled-runtime') ||
    (requireActive && timerStatus.activeState !== 'active')
  ) {
    throw schedulerMismatch();
  }
}

async function verifySystemdUpdateSchedulerAbsent(
  context: SystemdUpdateSchedulerContext,
): Promise<void> {
  const [serviceUnit, timerUnit, serviceStatus, timerStatus] = await Promise.all([
    readOptionalFile(context.service.unitPath),
    readOptionalFile(context.timer.unitPath),
    readSystemdStatus(context.service),
    readSystemdStatus(context.timer),
  ]);
  if (
    serviceUnit !== null ||
    timerUnit !== null ||
    serviceStatus.loadState !== 'not-found' ||
    timerStatus.loadState !== 'not-found' ||
    timerStatus.unitFileState === 'enabled' ||
    timerStatus.unitFileState === 'enabled-runtime' ||
    serviceStatus.dropInPaths?.trim() ||
    timerStatus.dropInPaths?.trim()
  ) {
    throw schedulerMismatch();
  }
}

async function ensureSystemdUpdateSchedulerStartedIfInstalled(
  context: SystemdUpdateSchedulerContext,
): Promise<void> {
  const status = await readSystemdStatus(context.timer);
  if (status.loadState !== 'not-found' && !isSystemdUnitRunning(status)) {
    await requireSystemctl(
      context.timer.runSystemctl,
      ['start', context.timer.unitName],
      'Starting Runtime Host update scheduling failed',
    );
  }
}

async function stopSystemdManagedDeployment(
  service: SystemdUnitContext,
  scheduler: SystemdUpdateSchedulerContext,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await stopSystemdUpdateScheduler(scheduler);
  } catch (error) {
    errors.push(error);
  }
  try {
    await runLifecycleAction(service, 'stop');
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Unable to stop the Runtime Host managed deployment',
      { cause: new AggregateError(errors) },
    );
  }
}

async function removeSystemdUpdateScheduler(context: SystemdUpdateSchedulerContext): Promise<void> {
  const timerStatus = await readSystemdStatus(context.timer);
  await stopSystemdUpdateScheduler(context);
  if (
    timerStatus.loadState !== 'not-found' ||
    timerStatus.unitFileState === 'enabled' ||
    timerStatus.unitFileState === 'enabled-runtime'
  ) {
    await requireSystemctl(
      context.timer.runSystemctl,
      ['disable', context.timer.unitName],
      'Disabling Runtime Host update scheduling failed',
    );
  }
  await Promise.all([
    removeRuntimeHostServiceFile(context.service.unitPath, 'systemd update service'),
    removeRuntimeHostServiceFile(context.timer.unitPath, 'systemd update timer'),
  ]);
  await requireSystemctl(context.timer.runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
  await context.timer.runSystemctl(['reset-failed', context.service.unitName]);
  await context.timer.runSystemctl(['reset-failed', context.timer.unitName]);
}

async function stopSystemdUpdateScheduler(context: SystemdUpdateSchedulerContext): Promise<void> {
  const [serviceUnit, timerUnit, serviceStatus, timerStatus] = await Promise.all([
    readOptionalFile(context.service.unitPath),
    readOptionalFile(context.timer.unitPath),
    readSystemdStatus(context.service),
    readSystemdStatus(context.timer),
  ]);
  const units = [
    ...(timerUnit !== null || timerStatus.loadState !== 'not-found'
      ? [context.timer.unitName]
      : []),
    ...(serviceUnit !== null || serviceStatus.loadState !== 'not-found'
      ? [context.service.unitName]
      : []),
  ];
  if (units.length === 0) return;
  await requireSystemctl(
    context.timer.runSystemctl,
    ['stop', ...units],
    'Stopping Runtime Host update scheduling failed',
  );
}

async function restoreSystemdUpdateScheduler(
  snapshot: SystemdUpdateSchedulerSnapshot,
  context: SystemdUpdateSchedulerContext,
): Promise<void> {
  await removeSystemdUpdateScheduler(context);
  if (snapshot.serviceUnit === null && snapshot.timerUnit === null) return;
  await Promise.all([
    snapshot.serviceUnit === null
      ? removeRuntimeHostServiceFile(context.service.unitPath, 'systemd update service')
      : writeRuntimeHostServiceFile(context.service.unitPath, snapshot.serviceUnit, 0o600),
    snapshot.timerUnit === null
      ? removeRuntimeHostServiceFile(context.timer.unitPath, 'systemd update timer')
      : writeRuntimeHostServiceFile(context.timer.unitPath, snapshot.timerUnit, 0o600),
  ]);
  await requireSystemctl(context.timer.runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
  if (snapshot.timerUnit === null) return;
  await requireSystemctl(
    context.timer.runSystemctl,
    [
      snapshot.timerStatus.unitFileState === 'enabled' ||
      snapshot.timerStatus.unitFileState === 'enabled-runtime'
        ? 'enable'
        : 'disable',
      context.timer.unitName,
    ],
    'Restoring Runtime Host update scheduling failed',
  );
  await requireSystemctl(
    context.timer.runSystemctl,
    [snapshot.timerStatus.activeState === 'active' ? 'restart' : 'stop', context.timer.unitName],
    'Restoring Runtime Host update scheduler state failed',
  );
}

function isLoadedManagedSystemdUnit(status: SystemdStatus, path: string): boolean {
  return (
    status.loadState === 'loaded' &&
    status.fragmentPath === path &&
    status.needDaemonReload === 'no' &&
    !status.dropInPaths?.trim()
  );
}

function isSystemdUnitRunning(status: SystemdStatus): boolean {
  return status.activeState !== 'inactive' && status.activeState !== 'failed';
}

function schedulerMismatch(): RuntimeHostServiceManagerError {
  return new RuntimeHostServiceManagerError(
    'target_mismatch',
    'The Runtime Host update scheduler does not match its managed deployment',
  );
}

function isTargetMismatch(error: unknown): boolean {
  return error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch';
}

async function readOptionalFile(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  });
}

async function captureSystemdDeployment(
  unitPath: string,
  readStatus: () => Promise<RuntimeHostServiceBackendStatus>,
): Promise<SystemdDeploymentSnapshot> {
  const [unit, status] = await Promise.all([
    readFile(unitPath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }),
    readStatus(),
  ]);
  return { unit, status };
}

async function applySystemdDeployment(
  context: SystemdUnitContext,
  config: RuntimeHostManagedServiceConfig,
): Promise<void> {
  await writeRuntimeHostServiceFile(context.unitPath, renderSystemdUnit(config), 0o600);
  await requireSystemctl(context.runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
  await requireSystemctl(
    context.runSystemctl,
    ['enable', context.unitName],
    'Enabling the Runtime Host service failed',
  );
  await context.runSystemctl(['reset-failed', context.unitName]);
  await requireSystemctl(
    context.runSystemctl,
    ['restart', context.unitName],
    'Starting the Runtime Host service failed',
  );
}

async function restoreFailedSystemdDeployment(
  snapshot: SystemdDeploymentSnapshot,
  schedulerSnapshot: SystemdUpdateSchedulerSnapshot | undefined,
  context: SystemdUnitContext,
  schedulerContext: SystemdUpdateSchedulerContext,
  originalError: unknown,
  recoveryFailureCode:
    | 'service_manager_operation_failed'
    | 'update_incomplete' = 'service_manager_operation_failed',
): Promise<never> {
  try {
    await restoreSystemdManagedDeployment(snapshot, schedulerSnapshot, context, schedulerContext);
  } catch (rollbackError) {
    throw new RuntimeHostServiceManagerError(
      recoveryFailureCode,
      'Updating the Runtime Host service failed and the previous systemd deployment could not be restored',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  throw originalError;
}

async function restoreSystemdManagedDeployment(
  snapshot: SystemdDeploymentSnapshot,
  schedulerSnapshot: SystemdUpdateSchedulerSnapshot | undefined,
  context: SystemdUnitContext,
  schedulerContext: SystemdUpdateSchedulerContext,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await restoreSystemdDeployment(snapshot, context);
  } catch (error) {
    errors.push(error);
  }
  if (schedulerSnapshot) {
    try {
      await restoreSystemdUpdateScheduler(schedulerSnapshot, schedulerContext);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Unable to restore the previous systemd deployment');
  }
}

async function restoreSystemdDeployment(
  snapshot: SystemdDeploymentSnapshot,
  context: SystemdUnitContext,
): Promise<void> {
  if (snapshot.unit === null) {
    let current: SystemdStatus;
    try {
      current = await readSystemdStatus(context);
    } catch (error) {
      await removeRuntimeHostServiceFile(context.unitPath, 'systemd unit');
      throw error;
    }
    if (current.loadState !== 'not-found') {
      await requireSystemctl(
        context.runSystemctl,
        ['stop', context.unitName],
        'Stopping the replacement Runtime Host service failed',
      );
      await requireSystemctl(
        context.runSystemctl,
        ['disable', context.unitName],
        'Disabling the replacement Runtime Host service failed',
      );
    }
    await removeRuntimeHostServiceFile(context.unitPath, 'systemd unit');
    await requireSystemctl(context.runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
    await context.runSystemctl(['reset-failed', context.unitName]);
    return;
  }

  await writeRuntimeHostServiceFile(context.unitPath, snapshot.unit, 0o600);
  await requireSystemctl(context.runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
  await requireSystemctl(
    context.runSystemctl,
    [snapshot.status.enabled ? 'enable' : 'disable', context.unitName],
    'Restoring the Runtime Host service enablement failed',
  );
  if (snapshot.status.active) {
    await context.runSystemctl(['reset-failed', context.unitName]);
  }
  await requireSystemctl(
    context.runSystemctl,
    [snapshot.status.active ? 'restart' : 'stop', context.unitName],
    'Restoring the Runtime Host service state failed',
  );
}

async function readSystemdStatus(context: SystemdUnitContext): Promise<SystemdStatus> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await context.runSystemctl([
      'show',
      context.unitName,
      '--property=LoadState,ActiveState,SubState,UnitFileState,FragmentPath,NeedDaemonReload,DropInPaths,MainPID,ExecMainStatus',
      '--no-pager',
    ]);
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'Unable to query the systemd user service manager',
      { cause: error },
    );
  }
  const properties = parseProperties(result.stdout);
  const loadState = properties.get('LoadState');
  if (loadState === undefined || (result.exitCode !== 0 && loadState !== 'not-found')) {
    throw managerError('Reading Runtime Host service status failed', result);
  }
  return {
    loadState,
    activeState: properties.get('ActiveState') ?? 'inactive',
    unitFileState: properties.get('UnitFileState') ?? 'disabled',
    fragmentPath: properties.get('FragmentPath'),
    needDaemonReload: properties.get('NeedDaemonReload'),
    dropInPaths: properties.get('DropInPaths'),
    mainPid: properties.get('MainPID'),
    execMainStatus: properties.get('ExecMainStatus'),
  };
}

async function assertUserSystemd(
  runSystemctl: (args: readonly string[]) => Promise<RuntimeHostServiceManagerCommandResult>,
): Promise<void> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await runSystemctl(['show-environment']);
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'systemd --user is unavailable',
      { cause: error },
    );
  }
  if (result.exitCode === 0) return;
  throw new RuntimeHostServiceManagerError(
    'service_manager_unavailable',
    `systemd --user is unavailable${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
  );
}

async function assertUserLinger(
  uid: number | undefined,
  runLoginctl: (args: readonly string[]) => Promise<RuntimeHostServiceManagerCommandResult>,
): Promise<void> {
  if (uid === undefined) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'The current Linux user identity could not be determined',
    );
  }
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await runLoginctl(['show-user', String(uid), '--property=Linger', '--value']);
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'Unable to verify systemd user lingering',
      { cause: error },
    );
  }
  if (result.exitCode !== 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      `Unable to verify systemd user lingering${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
    );
  }
  if (result.stdout.trim() !== 'yes') {
    throw new RuntimeHostServiceManagerError(
      'linger_disabled',
      `Persistent user services are disabled. Enable lingering for user ${uid} and retry`,
    );
  }
}

async function runLifecycleAction(
  context: SystemdUnitContext,
  action: 'start' | 'stop' | 'restart',
): Promise<void> {
  await requireSystemctl(
    context.runSystemctl,
    [action, context.unitName],
    `${actionPresentParticiple(action)} the Runtime Host service failed`,
  );
}

async function requireSystemctl(
  runSystemctl: (args: readonly string[]) => Promise<RuntimeHostServiceManagerCommandResult>,
  args: readonly string[],
  message: string,
): Promise<void> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await runSystemctl(args);
  } catch (error) {
    throw new RuntimeHostServiceManagerError('service_manager_unavailable', message, {
      cause: error,
    });
  }
  if (result.exitCode !== 0) throw managerError(message, result);
}

function managerError(
  message: string,
  result: RuntimeHostServiceManagerCommandResult,
): RuntimeHostServiceManagerError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new RuntimeHostServiceManagerError(
    'service_manager_operation_failed',
    detail ? `${message}: ${detail}` : message,
  );
}

async function defaultRunSystemctl(
  args: readonly string[],
): Promise<RuntimeHostServiceManagerCommandResult> {
  return runCommand('systemctl', ['--user', ...args]);
}

async function defaultRunLoginctl(
  args: readonly string[],
): Promise<RuntimeHostServiceManagerCommandResult> {
  return runCommand('loginctl', args);
}

async function defaultRunJournalctl(
  args: readonly string[],
): Promise<RuntimeHostServiceManagerCommandResult> {
  return runCommand('journalctl', args);
}

async function runCommand(
  command: string,
  args: readonly string[],
): Promise<RuntimeHostServiceManagerCommandResult> {
  return runRuntimeHostServiceManagerCommand(command, args);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function parseProperties(output: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return properties;
}

function systemdServiceState(loadState: string, activeState: string) {
  if (loadState === 'not-found') return 'not_installed' as const;
  if (activeState === 'active') return 'running' as const;
  if (activeState === 'activating' || activeState === 'reloading') return 'starting' as const;
  if (activeState === 'failed') return 'failed' as const;
  return 'stopped' as const;
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function quoteSystemdArgument(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError('systemd arguments cannot contain control characters');
  }
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => '$$')}"`;
}

function actionPresentParticiple(action: 'start' | 'stop' | 'restart'): string {
  if (action === 'start') return 'Starting';
  if (action === 'stop') return 'Stopping';
  return 'Restarting';
}

function assertServiceId(serviceId: string): void {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
}
