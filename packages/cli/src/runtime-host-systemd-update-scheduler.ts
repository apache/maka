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
  removeRuntimeHostServiceFile,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostServiceDeployment,
  writeRuntimeHostServiceFile,
} from './runtime-host-service-manager.js';
import {
  runRuntimeHostServiceManagerCommand,
  type RuntimeHostServiceManagerCommandResult,
} from './runtime-host-service-manager-process.js';
import { quoteSystemdArgument } from './runtime-host-systemd-service.js';
import {
  runtimeHostUpdateSchedule,
  runtimeHostUpdateSchedulerArguments,
  type RuntimeHostUpdateSchedulerBackend,
} from './runtime-host-update-scheduler.js';

type CommandRunner = (args: readonly string[]) => Promise<RuntimeHostServiceManagerCommandResult>;

export interface SystemdUserUpdateSchedulerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly runSystemctl?: CommandRunner;
  readonly runJournalctl?: CommandRunner;
}

export function createSystemdUserRuntimeHostUpdateScheduler(
  serviceId: string,
  options: SystemdUserUpdateSchedulerOptions = {},
): RuntimeHostUpdateSchedulerBackend {
  const paths = resolveSystemdUserRuntimeHostUpdateSchedulerPaths(
    serviceId,
    options.env,
    options.homeDir,
  );
  const runSystemctl = options.runSystemctl ?? defaultRunSystemctl;
  const runJournalctl = options.runJournalctl ?? defaultRunJournalctl;

  const apply = async (config: RuntimeHostManagedServiceConfig) => {
    const arguments_ = runtimeHostUpdateSchedulerArguments(config);
    if (!arguments_) {
      await removeSchedule(paths, runSystemctl);
      return;
    }
    await writeRuntimeHostServiceFile(
      paths.servicePath,
      renderSystemdRuntimeHostUpdateService(arguments_),
      0o600,
    );
    await writeRuntimeHostServiceFile(
      paths.timerPath,
      renderSystemdRuntimeHostUpdateTimer(serviceId),
      0o600,
    );
    await requireCommand(runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
    await requireCommand(
      runSystemctl,
      ['enable', '--now', paths.timerName],
      'Enabling the Runtime Host update timer failed',
    );
  };

  return {
    install: async (config) => {
      const snapshot = await captureSchedule(paths, runSystemctl);
      try {
        await apply(config);
      } catch (error) {
        await restoreSchedule(snapshot, paths, runSystemctl, error);
      }
      let rolledBack = false;
      return {
        rollback: async () => {
          if (rolledBack) return;
          rolledBack = true;
          await restoreSchedule(snapshot, paths, runSystemctl);
        },
      } satisfies RuntimeHostServiceDeployment;
    },
    verifyDeployment: async (config) => {
      const arguments_ = runtimeHostUpdateSchedulerArguments(config);
      const [service, timer, enabled, active] = await Promise.all([
        readOptional(paths.servicePath),
        readOptional(paths.timerPath),
        runSystemctl(['is-enabled', paths.timerName]),
        runSystemctl(['is-active', paths.timerName]),
      ]);
      if (!arguments_) {
        if (service !== null || timer !== null || enabled.exitCode === 0 || active.exitCode === 0) {
          throw mismatch();
        }
        return;
      }
      if (
        service !== renderSystemdRuntimeHostUpdateService(arguments_) ||
        timer !== renderSystemdRuntimeHostUpdateTimer(serviceId) ||
        enabled.exitCode !== 0 ||
        active.exitCode !== 0
      ) {
        throw mismatch();
      }
    },
    logs: async () => {
      const result = await runJournalctl([
        '--user-unit',
        paths.serviceName,
        '--no-pager',
        '--lines=100',
        '--output=short-iso',
      ]);
      if (result.exitCode !== 0) {
        throw commandError('Reading Runtime Host update scheduler logs failed', result);
      }
      return result.stdout;
    },
    uninstall: () => removeSchedule(paths, runSystemctl),
  };
}

export function resolveSystemdUserRuntimeHostUpdateSchedulerPaths(
  serviceId: string,
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): {
  readonly serviceName: string;
  readonly servicePath: string;
  readonly timerName: string;
  readonly timerPath: string;
} {
  assertServiceId(serviceId);
  const root = join(resolveXdgConfigHome(env, homeDir), 'systemd', 'user');
  const stem = `maka-runtime-host-update-${serviceId}`;
  return {
    serviceName: `${stem}.service`,
    servicePath: join(root, `${stem}.service`),
    timerName: `${stem}.timer`,
    timerPath: join(root, `${stem}.timer`),
  };
}

export function renderSystemdRuntimeHostUpdateService(args: readonly string[]): string {
  return [
    '[Unit]',
    'Description=Reconcile Maka Runtime Host updates',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${args.map(quoteSystemdArgument).join(' ')}`,
    'UMask=0077',
    '',
  ].join('\n');
}

export function renderSystemdRuntimeHostUpdateTimer(serviceId: string): string {
  const schedule = runtimeHostUpdateSchedule(serviceId);
  return [
    '[Unit]',
    'Description=Schedule Maka Runtime Host update reconciliation',
    '',
    '[Timer]',
    `OnCalendar=*-*-* *:${String(schedule.minute).padStart(2, '0')}:00`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

interface ScheduleSnapshot {
  readonly service: string | null;
  readonly timer: string | null;
  readonly enabled: boolean;
  readonly active: boolean;
}

async function captureSchedule(
  paths: ReturnType<typeof resolveSystemdUserRuntimeHostUpdateSchedulerPaths>,
  runSystemctl: CommandRunner,
): Promise<ScheduleSnapshot> {
  const [service, timer, enabled, active] = await Promise.all([
    readOptional(paths.servicePath),
    readOptional(paths.timerPath),
    runSystemctl(['is-enabled', paths.timerName]),
    runSystemctl(['is-active', paths.timerName]),
  ]);
  return {
    service,
    timer,
    enabled: enabled.exitCode === 0,
    active: active.exitCode === 0,
  };
}

async function restoreSchedule(
  snapshot: ScheduleSnapshot,
  paths: ReturnType<typeof resolveSystemdUserRuntimeHostUpdateSchedulerPaths>,
  runSystemctl: CommandRunner,
  originalError?: unknown,
): Promise<never | void> {
  try {
    const [enabled, active] = await Promise.all([
      runSystemctl(['is-enabled', paths.timerName]),
      runSystemctl(['is-active', paths.timerName]),
    ]);
    if (enabled.exitCode === 0 || active.exitCode === 0) {
      await requireCommand(
        runSystemctl,
        ['disable', '--now', paths.timerName],
        'Disabling the replacement Runtime Host update timer failed',
      );
    }
    await restoreFile(paths.servicePath, snapshot.service);
    await restoreFile(paths.timerPath, snapshot.timer);
    await requireCommand(runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
    if (snapshot.enabled) {
      await requireCommand(
        runSystemctl,
        snapshot.active ? ['enable', '--now', paths.timerName] : ['enable', paths.timerName],
        'Restoring the Runtime Host update timer failed',
      );
    } else if (snapshot.active) {
      await requireCommand(
        runSystemctl,
        ['start', paths.timerName],
        'Restoring the Runtime Host update timer failed',
      );
    }
  } catch (rollbackError) {
    if (originalError === undefined) throw rollbackError;
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Installing the Runtime Host update timer failed and its previous state could not be restored',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  if (originalError !== undefined) throw originalError;
}

async function removeSchedule(
  paths: ReturnType<typeof resolveSystemdUserRuntimeHostUpdateSchedulerPaths>,
  runSystemctl: CommandRunner,
): Promise<void> {
  const [timerEnabled, timerActive, serviceActive] = await Promise.all([
    runSystemctl(['is-enabled', paths.timerName]),
    runSystemctl(['is-active', paths.timerName]),
    runSystemctl(['is-active', paths.serviceName]),
  ]);
  if (timerEnabled.exitCode === 0 || timerActive.exitCode === 0) {
    await requireCommand(
      runSystemctl,
      ['disable', '--now', paths.timerName],
      'Disabling the Runtime Host update timer failed',
    );
  }
  if (serviceActive.exitCode === 0) {
    await requireCommand(
      runSystemctl,
      ['stop', paths.serviceName],
      'Stopping Runtime Host update reconciliation failed',
    );
  }
  await Promise.all([
    removeRuntimeHostServiceFile(paths.servicePath, 'systemd update service'),
    removeRuntimeHostServiceFile(paths.timerPath, 'systemd update timer'),
  ]);
  await requireCommand(runSystemctl, ['daemon-reload'], 'Reloading systemd failed');
  await Promise.all([
    runSystemctl(['reset-failed', paths.serviceName]),
    runSystemctl(['reset-failed', paths.timerName]),
  ]);
}

async function restoreFile(path: string, contents: string | null): Promise<void> {
  if (contents === null) {
    await removeRuntimeHostServiceFile(path, 'systemd update schedule');
  } else {
    await writeRuntimeHostServiceFile(path, contents, 0o600);
  }
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  });
}

function mismatch(): RuntimeHostServiceManagerError {
  return new RuntimeHostServiceManagerError(
    'target_mismatch',
    'The loaded Runtime Host update timer does not match its managed deployment',
  );
}

async function requireCommand(
  run: CommandRunner,
  args: readonly string[],
  message: string,
): Promise<void> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await run(args);
  } catch (error) {
    throw new RuntimeHostServiceManagerError('service_manager_unavailable', message, {
      cause: error,
    });
  }
  if (result.exitCode !== 0) {
    throw commandError(message, result);
  }
}

function commandError(
  message: string,
  result: RuntimeHostServiceManagerCommandResult,
): RuntimeHostServiceManagerError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new RuntimeHostServiceManagerError(
    'service_manager_operation_failed',
    `${message}${detail ? `: ${detail}` : ''}`,
  );
}

function assertServiceId(serviceId: string): void {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function defaultRunSystemctl(args: readonly string[]) {
  return runRuntimeHostServiceManagerCommand('systemctl', ['--user', ...args]);
}

function defaultRunJournalctl(args: readonly string[]) {
  return runRuntimeHostServiceManagerCommand('journalctl', args);
}
