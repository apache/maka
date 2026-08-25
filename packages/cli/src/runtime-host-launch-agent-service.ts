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

import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { RUNTIME_HOST_SERVICE_LOG_MAX_BYTES } from '@maka/runtime-host/operator';
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
  RUNTIME_HOST_UPDATE_INTERVAL_SECONDS,
  runtimeHostServiceLaunchArguments,
  runtimeHostUpdateReconcileLaunchArguments,
  validateRuntimeHostServiceLaunch,
} from './runtime-host-service-launch.js';
import {
  runRuntimeHostServiceManagerCommand,
  type RuntimeHostServiceManagerCommandResult,
} from './runtime-host-service-manager-process.js';

const SERVICE_EXIT_TIMEOUT_SECONDS = 45;
const SERVICE_BOOTOUT_TIMEOUT_MS = (SERVICE_EXIT_TIMEOUT_SECONDS + 5) * 1_000;
const SERVICE_BOOTOUT_POLL_MS = 250;

type LaunchctlRunner = (args: readonly string[]) => Promise<RuntimeHostServiceManagerCommandResult>;

interface LaunchAgentContext {
  readonly domain: string;
  readonly label: string;
  readonly serviceTarget: string;
  readonly plistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly runLaunchctl: LaunchctlRunner;
  readonly isProcessAlive: (pid: number) => boolean;
}

interface LaunchAgentStatus extends RuntimeHostServiceBackendStatus {
  readonly loaded: boolean;
}

interface LaunchAgentDeploymentSnapshot {
  readonly plist: string | null;
  readonly loaded: boolean;
}

export interface LaunchAgentServiceOptions {
  readonly homeDir?: string;
  readonly uid?: number;
  readonly runLaunchctl?: LaunchctlRunner;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export function createLaunchAgentRuntimeHostService(
  serviceId: string,
  options: LaunchAgentServiceOptions = {},
): RuntimeHostServiceBackend {
  const homeDir = options.homeDir ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'The current macOS user identity could not be determined',
    );
  }
  const runLaunchctl = options.runLaunchctl ?? defaultRunLaunchctl;
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const label = resolveLaunchAgentLabel(serviceId);
  const context: LaunchAgentContext = {
    domain: `gui/${String(uid)}`,
    label,
    serviceTarget: `gui/${String(uid)}/${label}`,
    plistPath: resolveLaunchAgentPath(serviceId, homeDir),
    stdoutPath: resolveLaunchAgentLogPath(serviceId, 'stdout', homeDir),
    stderrPath: resolveLaunchAgentLogPath(serviceId, 'stderr', homeDir),
    runLaunchctl,
    isProcessAlive,
  };
  const scheduler = resolveLaunchAgentUpdateSchedulerContext(
    serviceId,
    homeDir,
    uid,
    runLaunchctl,
    isProcessAlive,
  );

  const readDetailedStatus = () => readLaunchAgentStatus(context);
  const readStatus = async (): Promise<RuntimeHostServiceBackendStatus> => {
    const { loaded: _loaded, ...status } = await readDetailedStatus();
    return status;
  };
  return {
    preflightInstall: () => assertLaunchAgentDomain(context),
    install: async (config) => {
      await validateRuntimeHostServiceLaunch(config);
      const [previous, previousScheduler] = await Promise.all([
        captureLaunchAgentDeployment(context),
        captureLaunchAgentDeployment(scheduler),
      ]);
      let schedulerMutationStarted = false;
      try {
        await applyLaunchAgentDeployment(context, config);
        await applyLaunchAgentUpdateSchedulerDesiredState(scheduler, config, () => {
          schedulerMutationStarted = true;
        });
      } catch (error) {
        await restoreFailedLaunchAgentDeployment(
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
          await restoreLaunchAgentManagedDeployment(
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
        captureLaunchAgentDeployment(context),
        captureLaunchAgentDeployment(scheduler),
      ]);
      let schedulerMutationStarted = false;
      try {
        await applyLaunchAgentDeployment(context, config);
        await convergeLaunchAgentUpdateSchedulerForReplacement(scheduler, config, () => {
          schedulerMutationStarted = true;
        });
      } catch (error) {
        await restoreFailedLaunchAgentDeployment(
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
      verifyLaunchAgentUpdateSchedulerReplacementState(scheduler, config),
    verifyDeployment: async (config, options) => {
      await validateRuntimeHostServiceLaunch(config);
      const [status, plist] = await Promise.all([
        readDetailedStatus(),
        readFile(context.plistPath, 'utf8').catch((error: unknown) => {
          if (isNodeError(error, 'ENOENT')) return null;
          throw error;
        }),
      ]);
      if (!status.installed || plist !== renderLaunchAgentPlist(config, context)) {
        throw new RuntimeHostServiceManagerError(
          'target_mismatch',
          'The installed Runtime Host LaunchAgent does not match its managed deployment',
        );
      }
      await verifyLaunchAgentUpdateSchedulerDesiredState(
        scheduler,
        config,
        options?.requireSchedulerReady ?? false,
      );
    },
    status: readStatus,
    start: async () => {
      await startLaunchAgent(context);
      await ensureLaunchAgentLoadedIfInstalled(scheduler);
    },
    stop: () => stopLaunchAgentManagedDeployment(context, scheduler),
    restart: async () => {
      await restartLaunchAgent(context);
      await ensureLaunchAgentLoadedIfInstalled(scheduler);
    },
    retire: () => bootoutLaunchAgent(context),
    logs: async () => {
      const [stdout, stderr, updateStdout, updateStderr] = await Promise.all([
        readLogTail(context.stdoutPath),
        readLogTail(context.stderrPath),
        readLogTail(scheduler.stdoutPath),
        readLogTail(scheduler.stderrPath),
      ]);
      return formatRuntimeHostServiceLogs([
        { label: 'stdout', logs: stdout },
        { label: 'stderr', logs: stderr },
        { label: 'update stdout', logs: updateStdout },
        { label: 'update stderr', logs: updateStderr },
      ]);
    },
    uninstall: async () => {
      await removeLaunchAgentUpdateScheduler(scheduler);
      await bootoutLaunchAgent(context);
      await Promise.all([
        removeRuntimeHostServiceFile(context.plistPath, 'LaunchAgent plist'),
        removeRuntimeHostServiceFile(context.stdoutPath, 'LaunchAgent stdout log'),
        removeRuntimeHostServiceFile(context.stderrPath, 'LaunchAgent stderr log'),
      ]);
      const after = await readStatus();
      if (after.installed || after.active || after.enabled) {
        throw new RuntimeHostServiceManagerError(
          'uninstall_incomplete',
          `Runtime Host LaunchAgent still has managed state: ${after.state}`,
        );
      }
    },
  };
}

export function resolveLaunchAgentPath(serviceId: string, homeDir = homedir()): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${resolveLaunchAgentLabel(serviceId)}.plist`);
}

export function resolveLaunchAgentUpdatePath(serviceId: string, homeDir = homedir()): string {
  return join(
    homeDir,
    'Library',
    'LaunchAgents',
    `${resolveLaunchAgentUpdateLabel(serviceId)}.plist`,
  );
}

export function renderLaunchAgentPlist(
  config: RuntimeHostManagedServiceConfig,
  paths: Pick<LaunchAgentContext, 'label' | 'stdoutPath' | 'stderrPath'>,
): string {
  const stringEntry = (value: string) => `    <string>${escapeXml(value)}</string>`;
  const argumentsXml = runtimeHostServiceLaunchArguments(config).map(stringEntry).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(paths.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argumentsXml,
    '  </array>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>2</integer>',
    '  <key>ExitTimeOut</key>',
    `  <integer>${String(SERVICE_EXIT_TIMEOUT_SECONDS)}</integer>`,
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(paths.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(paths.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function renderLaunchAgentUpdatePlist(
  config: RuntimeHostManagedServiceConfig,
  paths: Pick<LaunchAgentContext, 'label' | 'stdoutPath' | 'stderrPath'>,
): string {
  const args = runtimeHostUpdateReconcileLaunchArguments(config);
  if (!args) throw new TypeError('Managed deployment root is required for update scheduling');
  const stringEntry = (value: string) => `    <string>${escapeXml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(paths.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    args.map(stringEntry).join('\n'),
    '  </array>',
    '  <key>StartInterval</key>',
    `  <integer>${String(RUNTIME_HOST_UPDATE_INTERVAL_SECONDS)}</integer>`,
    '  <key>ProcessType</key>',
    '  <string>Background</string>',
    '  <key>Umask</key>',
    '  <integer>63</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(paths.stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(paths.stderrPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function resolveLaunchAgentLabel(serviceId: string): string {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
  return `com.maka.runtime-host.${serviceId}`;
}

function resolveLaunchAgentUpdateLabel(serviceId: string): string {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
  return `${resolveLaunchAgentLabel(serviceId)}.update`;
}

function resolveLaunchAgentLogPath(
  serviceId: string,
  stream: 'stdout' | 'stderr',
  homeDir: string,
): string {
  return join(
    homeDir,
    'Library',
    'Logs',
    'Maka',
    'runtime-host-services',
    `${resolveLaunchAgentLabel(serviceId)}.${stream}.log`,
  );
}

function resolveLaunchAgentUpdateSchedulerContext(
  serviceId: string,
  homeDir: string,
  uid: number,
  runLaunchctl: LaunchctlRunner,
  isProcessAlive: (pid: number) => boolean,
): LaunchAgentContext {
  const label = resolveLaunchAgentUpdateLabel(serviceId);
  return {
    domain: `gui/${String(uid)}`,
    label,
    serviceTarget: `gui/${String(uid)}/${label}`,
    plistPath: resolveLaunchAgentUpdatePath(serviceId, homeDir),
    stdoutPath: resolveLaunchAgentUpdateLogPath(serviceId, 'stdout', homeDir),
    stderrPath: resolveLaunchAgentUpdateLogPath(serviceId, 'stderr', homeDir),
    runLaunchctl,
    isProcessAlive,
  };
}

function resolveLaunchAgentUpdateLogPath(
  serviceId: string,
  stream: 'stdout' | 'stderr',
  homeDir: string,
): string {
  return join(
    homeDir,
    'Library',
    'Logs',
    'Maka',
    'runtime-host-services',
    `${resolveLaunchAgentUpdateLabel(serviceId)}.${stream}.log`,
  );
}

async function captureLaunchAgentDeployment(
  context: LaunchAgentContext,
): Promise<LaunchAgentDeploymentSnapshot> {
  const [plist, status] = await Promise.all([
    readFile(context.plistPath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }),
    readLaunchAgentStatus(context),
  ]);
  return { plist, loaded: status.loaded };
}

async function applyLaunchAgentUpdateSchedulerDesiredState(
  context: LaunchAgentContext,
  config: RuntimeHostManagedServiceConfig,
  onMutation: () => void,
): Promise<void> {
  if (!runtimeHostUpdateReconcileLaunchArguments(config)) {
    try {
      await verifyLaunchAgentUpdateSchedulerAbsent(context);
      return;
    } catch (error) {
      if (!isTargetMismatch(error)) throw error;
    }
    onMutation();
    await removeLaunchAgentUpdateScheduler(context);
    await verifyLaunchAgentUpdateSchedulerAbsent(context);
    return;
  }
  try {
    await verifyLaunchAgentUpdateScheduler(context, config, true);
    return;
  } catch (error) {
    if (!isTargetMismatch(error)) throw error;
  }
  onMutation();
  await bootoutLaunchAgent(context);
  await prepareLaunchAgentLogs(context);
  await writeRuntimeHostServiceFile(
    context.plistPath,
    renderLaunchAgentUpdatePlist(config, context),
    0o600,
  );
  await bootstrapLaunchAgent(context);
  await verifyLaunchAgentUpdateScheduler(context, config, true);
}

async function verifyLaunchAgentUpdateSchedulerDesiredState(
  context: LaunchAgentContext,
  config: RuntimeHostManagedServiceConfig,
  requireLoaded: boolean,
): Promise<void> {
  if (runtimeHostUpdateReconcileLaunchArguments(config)) {
    await verifyLaunchAgentUpdateScheduler(context, config, requireLoaded);
    return;
  }
  await verifyLaunchAgentUpdateSchedulerAbsent(context);
}

async function verifyLaunchAgentUpdateSchedulerReplacementState(
  context: LaunchAgentContext,
  config: RuntimeHostManagedServiceConfig,
): Promise<void> {
  if (!runtimeHostUpdateReconcileLaunchArguments(config)) {
    await verifyLaunchAgentUpdateSchedulerAbsent(context);
    return;
  }
  try {
    await verifyLaunchAgentUpdateScheduler(context, config, false);
  } catch (error) {
    if (!isTargetMismatch(error)) throw error;
    await verifyLaunchAgentUpdateSchedulerAbsent(context);
  }
}

async function convergeLaunchAgentUpdateSchedulerForReplacement(
  context: LaunchAgentContext,
  config: RuntimeHostManagedServiceConfig,
  onMutation: () => void,
): Promise<void> {
  try {
    await verifyLaunchAgentUpdateScheduler(context, config, false);
    const status = await readLaunchAgentStatus(context);
    // The loaded scheduler may be running this replacement.
    if (status.loaded) return;
    onMutation();
    await ensureLaunchAgentLoadedIfInstalled(context);
  } catch (error) {
    if (!isTargetMismatch(error)) throw error;
    await verifyLaunchAgentUpdateSchedulerAbsent(context);
    onMutation();
    await applyLaunchAgentUpdateSchedulerDesiredState(context, config, () => undefined);
  }
  await verifyLaunchAgentUpdateScheduler(context, config, true);
}

async function verifyLaunchAgentUpdateScheduler(
  context: LaunchAgentContext,
  config: RuntimeHostManagedServiceConfig,
  requireLoaded: boolean,
): Promise<void> {
  const [status, plist] = await Promise.all([
    readLaunchAgentStatus(context),
    readFile(context.plistPath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }),
  ]);
  if (
    (requireLoaded && !status.loaded) ||
    plist !== renderLaunchAgentUpdatePlist(config, context)
  ) {
    throw launchAgentSchedulerMismatch();
  }
}

async function verifyLaunchAgentUpdateSchedulerAbsent(context: LaunchAgentContext): Promise<void> {
  const [status, plist] = await Promise.all([
    readLaunchAgentStatus(context),
    readFile(context.plistPath, 'utf8').catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    }),
  ]);
  if (status.loaded || plist !== null) throw launchAgentSchedulerMismatch();
}

async function removeLaunchAgentUpdateScheduler(context: LaunchAgentContext): Promise<void> {
  await bootoutLaunchAgent(context);
  await Promise.all([
    removeRuntimeHostServiceFile(context.plistPath, 'LaunchAgent update plist'),
    removeRuntimeHostServiceFile(context.stdoutPath, 'LaunchAgent update stdout log'),
    removeRuntimeHostServiceFile(context.stderrPath, 'LaunchAgent update stderr log'),
  ]);
}

function launchAgentSchedulerMismatch(): RuntimeHostServiceManagerError {
  return new RuntimeHostServiceManagerError(
    'target_mismatch',
    'The Runtime Host update scheduler does not match its managed deployment',
  );
}

function isTargetMismatch(error: unknown): boolean {
  return error instanceof RuntimeHostServiceManagerError && error.code === 'target_mismatch';
}

async function applyLaunchAgentDeployment(
  context: LaunchAgentContext,
  config: RuntimeHostManagedServiceConfig,
): Promise<void> {
  await bootoutLaunchAgent(context);
  await prepareLaunchAgentLogs(context);
  await writeRuntimeHostServiceFile(
    context.plistPath,
    renderLaunchAgentPlist(config, context),
    0o600,
  );
  await bootstrapLaunchAgent(context);
}

async function startLaunchAgent(context: LaunchAgentContext): Promise<void> {
  const status = await readLaunchAgentStatus(context);
  if (!status.installed) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host LaunchAgent is not installed',
    );
  }
  if (!status.loaded) {
    await bootstrapLaunchAgent(context);
    return;
  }
  if (!status.active) {
    await requireLaunchctl(
      context,
      ['kickstart', context.serviceTarget],
      'Starting the Runtime Host LaunchAgent failed',
    );
  }
}

async function restartLaunchAgent(context: LaunchAgentContext): Promise<void> {
  const status = await readLaunchAgentStatus(context);
  if (!status.installed) {
    throw new RuntimeHostServiceManagerError(
      'not_installed',
      'Runtime Host LaunchAgent is not installed',
    );
  }
  if (!status.loaded) {
    await bootstrapLaunchAgent(context);
    return;
  }
  await requireLaunchctl(
    context,
    ['kickstart', '-k', context.serviceTarget],
    'Restarting the Runtime Host LaunchAgent failed',
  );
}

async function ensureLaunchAgentLoadedIfInstalled(context: LaunchAgentContext): Promise<void> {
  const status = await readLaunchAgentStatus(context);
  if (status.installed && !status.loaded) await bootstrapLaunchAgent(context);
}

async function stopLaunchAgentManagedDeployment(
  context: LaunchAgentContext,
  scheduler: LaunchAgentContext,
): Promise<void> {
  const errors: unknown[] = [];
  for (const target of [scheduler, context]) {
    try {
      await bootoutLaunchAgent(target);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Unable to stop the Runtime Host managed deployment',
      { cause: new AggregateError(errors) },
    );
  }
}

async function restoreFailedLaunchAgentDeployment(
  snapshot: LaunchAgentDeploymentSnapshot,
  schedulerSnapshot: LaunchAgentDeploymentSnapshot | undefined,
  context: LaunchAgentContext,
  schedulerContext: LaunchAgentContext,
  originalError: unknown,
  recoveryFailureCode:
    | 'service_manager_operation_failed'
    | 'update_incomplete' = 'service_manager_operation_failed',
): Promise<never> {
  try {
    await restoreLaunchAgentManagedDeployment(
      snapshot,
      schedulerSnapshot,
      context,
      schedulerContext,
    );
  } catch (rollbackError) {
    throw new RuntimeHostServiceManagerError(
      recoveryFailureCode,
      'Updating the Runtime Host LaunchAgent failed and the previous deployment could not be restored',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  throw originalError;
}

async function restoreLaunchAgentManagedDeployment(
  snapshot: LaunchAgentDeploymentSnapshot,
  schedulerSnapshot: LaunchAgentDeploymentSnapshot | undefined,
  context: LaunchAgentContext,
  schedulerContext: LaunchAgentContext,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await restoreLaunchAgentDeployment(snapshot, context);
  } catch (error) {
    errors.push(error);
  }
  if (schedulerSnapshot) {
    try {
      await restoreLaunchAgentDeployment(schedulerSnapshot, schedulerContext);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Unable to restore the previous LaunchAgent deployment');
  }
}

async function restoreLaunchAgentDeployment(
  snapshot: LaunchAgentDeploymentSnapshot,
  context: LaunchAgentContext,
): Promise<void> {
  await bootoutLaunchAgent(context);
  if (snapshot.plist === null) {
    await removeRuntimeHostServiceFile(context.plistPath, 'LaunchAgent plist');
    return;
  }
  await writeRuntimeHostServiceFile(context.plistPath, snapshot.plist, 0o600);
  if (snapshot.loaded) await bootstrapLaunchAgent(context);
}

async function prepareLaunchAgentLogs(context: LaunchAgentContext): Promise<void> {
  for (const path of [context.stdoutPath, context.stderrPath]) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'a', 0o600);
    await file.close();
  }
}

async function readLaunchAgentStatus(context: LaunchAgentContext): Promise<LaunchAgentStatus> {
  const [plistExists, service] = await Promise.all([
    stat(context.plistPath)
      .then((entry) => entry.isFile())
      .catch((error: unknown) => {
        if (isNodeError(error, 'ENOENT')) return false;
        throw error;
      }),
    context.runLaunchctl(['print', context.serviceTarget]).catch((error: unknown) => {
      throw new RuntimeHostServiceManagerError(
        'service_manager_unavailable',
        'Unable to query the macOS LaunchAgent manager',
        { cause: error },
      );
    }),
  ]);
  if (service.exitCode !== 0) {
    await assertLaunchAgentDomain(context);
    return {
      manager: 'launch_agent',
      installed: plistExists,
      enabled: plistExists,
      active: false,
      state: plistExists ? 'stopped' : 'not_installed',
      pid: null,
      lastExitCode: null,
      loaded: false,
    };
  }
  const state = readLaunchctlProperty(service.stdout, 'state');
  const pid =
    state === 'running' ? positiveInteger(readLaunchctlProperty(service.stdout, 'pid')) : null;
  const lastExitCode = nonNegativeInteger(readLaunchctlProperty(service.stdout, 'last exit code'));
  return {
    manager: 'launch_agent',
    installed: true,
    enabled: plistExists,
    active: state === 'running' && pid !== null,
    state:
      state === 'running' && pid !== null
        ? 'running'
        : lastExitCode === 0
          ? 'stopped'
          : lastExitCode === null
            ? 'starting'
            : 'failed',
    pid,
    lastExitCode,
    loaded: true,
  };
}

async function assertLaunchAgentDomain(context: LaunchAgentContext): Promise<void> {
  const result = await context.runLaunchctl(['print', context.domain]).catch((error: unknown) => {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'The current macOS user LaunchAgent domain is unavailable',
      { cause: error },
    );
  });
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      `The current macOS user has no active GUI login session for LaunchAgents${detail ? `: ${detail}` : ''}`,
    );
  }
}

async function bootstrapLaunchAgent(context: LaunchAgentContext): Promise<void> {
  await requireLaunchctl(
    context,
    ['bootstrap', context.domain, context.plistPath],
    'Starting the Runtime Host LaunchAgent failed',
  );
}

async function bootoutLaunchAgent(context: LaunchAgentContext): Promise<void> {
  const status = await readLaunchAgentStatus(context);
  if (!status.loaded) return;
  await requireLaunchctl(
    context,
    ['bootout', context.serviceTarget],
    'Stopping the Runtime Host LaunchAgent failed',
  );
  const deadline = Date.now() + SERVICE_BOOTOUT_TIMEOUT_MS;
  let unloaded = false;
  while (Date.now() < deadline) {
    if (!unloaded) unloaded = !(await readLaunchAgentStatus(context)).loaded;
    if (unloaded && (status.pid === null || !context.isProcessAlive(status.pid))) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SERVICE_BOOTOUT_POLL_MS));
  }
  throw new RuntimeHostServiceManagerError(
    'service_manager_operation_failed',
    'The Runtime Host LaunchAgent did not finish stopping',
  );
}

async function requireLaunchctl(
  context: LaunchAgentContext,
  args: readonly string[],
  message: string,
): Promise<void> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await context.runLaunchctl(args);
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

async function readLogTail(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return '';
    throw error;
  }
  try {
    const size = (await file.stat()).size;
    const length = Math.min(size, Math.floor(RUNTIME_HOST_SERVICE_LOG_MAX_BYTES / 2));
    if (length === 0) return '';
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await file.close();
  }
}

async function defaultRunLaunchctl(
  args: readonly string[],
): Promise<RuntimeHostServiceManagerCommandResult> {
  return runRuntimeHostServiceManagerCommand('/bin/launchctl', args);
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ESRCH')) return false;
    if (isNodeError(error, 'EPERM')) return true;
    throw error;
  }
}

function readLaunchctlProperty(output: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^\\s*${escaped} = (.+)$`, 'mu').exec(output)?.[1]?.trim();
}

function positiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function escapeXml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new TypeError('LaunchAgent strings cannot contain XML control characters');
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
