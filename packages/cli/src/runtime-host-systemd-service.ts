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
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveXdgConfigHome } from '@maka/storage';
import {
  removeRuntimeHostServiceFile,
  RuntimeHostServiceManagerError,
  type RuntimeHostManagedServiceConfig,
  type RuntimeHostServiceBackend,
  type RuntimeHostServiceBackendStatus,
  type RuntimeHostServiceDeployment,
  writeRuntimeHostServiceFile,
} from './runtime-host-service-manager.js';

const SERVICE_MANAGER_COMMAND_TIMEOUT_MS = 30_000;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface SystemdUnitContext {
  readonly unitName: string;
  readonly unitPath: string;
  readonly runSystemctl: (args: readonly string[]) => Promise<CommandResult>;
}

export interface SystemdUserServiceOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly uid?: number;
  readonly runSystemctl?: (args: readonly string[]) => Promise<CommandResult>;
  readonly runLoginctl?: (args: readonly string[]) => Promise<CommandResult>;
  readonly runJournalctl?: (args: readonly string[]) => Promise<CommandResult>;
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
      await validateLaunchFiles(config);
      const previous = await captureSystemdDeployment(context.unitPath, readStatus);
      try {
        await applySystemdDeployment(context, config);
      } catch (error) {
        await restoreFailedSystemdDeployment(previous, context, error);
      }
      let rolledBack = false;
      return {
        rollback: async () => {
          if (rolledBack) return;
          rolledBack = true;
          await restoreSystemdDeployment(previous, context);
        },
      } satisfies RuntimeHostServiceDeployment;
    },
    status: readStatus,
    start: () => runLifecycleAction(context, 'start'),
    stop: () => runLifecycleAction(context, 'stop'),
    restart: () => runLifecycleAction(context, 'restart'),
    logs: async () => {
      const result = await runJournalctl([
        '--user-unit',
        context.unitName,
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
    },
    uninstall: async () => {
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

function resolveSystemdUserRuntimeHostServiceName(serviceId: string): string {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
  return `maka-runtime-host-${serviceId}.service`;
}

export function renderSystemdUnit(config: RuntimeHostManagedServiceConfig): string {
  const args = [
    config.launch.nodePath,
    config.launch.cliPath,
    'runtime-host',
    'serve',
    '--root',
    config.rootPath,
    ...config.projectDirectoryRoots.flatMap(({ label, path }) => [
      '--project-root',
      `${label}=${path}`,
    ]),
    '--websocket-host',
    config.websocket.host,
    '--websocket-port',
    String(config.websocket.port),
    '--websocket-path',
    config.websocket.path,
    '--json',
  ];
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
    // A clean idle exit must not silently remove a configured remote Host.
    'Restart=always',
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

interface SystemdStatus {
  readonly loadState: string;
  readonly activeState: string;
  readonly unitFileState: string;
  readonly mainPid?: string;
  readonly execMainStatus?: string;
}

interface SystemdDeploymentSnapshot {
  readonly unit: string | null;
  readonly status: RuntimeHostServiceBackendStatus;
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
  context: SystemdUnitContext,
  originalError: unknown,
): Promise<never> {
  try {
    await restoreSystemdDeployment(snapshot, context);
  } catch (rollbackError) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Updating the Runtime Host service failed and the previous systemd deployment could not be restored',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  throw originalError;
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
  let result: CommandResult;
  try {
    result = await context.runSystemctl([
      'show',
      context.unitName,
      '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,ExecMainStatus',
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
    mainPid: properties.get('MainPID'),
    execMainStatus: properties.get('ExecMainStatus'),
  };
}

async function validateLaunchFiles(config: RuntimeHostManagedServiceConfig): Promise<void> {
  try {
    const [nodePath, cliPath] = await Promise.all([
      realpath(config.launch.nodePath),
      realpath(config.launch.cliPath),
    ]);
    const [node, cli] = await Promise.all([stat(nodePath), stat(cliPath)]);
    if (!node.isFile() || !cli.isFile()) throw new Error('Launch path is not a file');
    await Promise.all([access(nodePath, constants.X_OK), access(cliPath, constants.R_OK)]);
  } catch (error) {
    throw new RuntimeHostServiceManagerError(
      'invalid_launch',
      'The configured Node.js or Maka CLI installation is unavailable',
      { cause: error },
    );
  }
}

async function assertUserSystemd(
  runSystemctl: (args: readonly string[]) => Promise<CommandResult>,
): Promise<void> {
  let result: CommandResult;
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
  runLoginctl: (args: readonly string[]) => Promise<CommandResult>,
): Promise<void> {
  if (uid === undefined) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'The current Linux user identity could not be determined',
    );
  }
  let result: CommandResult;
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
  runSystemctl: (args: readonly string[]) => Promise<CommandResult>,
  args: readonly string[],
  message: string,
): Promise<void> {
  let result: CommandResult;
  try {
    result = await runSystemctl(args);
  } catch (error) {
    throw new RuntimeHostServiceManagerError('service_manager_unavailable', message, {
      cause: error,
    });
  }
  if (result.exitCode !== 0) throw managerError(message, result);
}

function managerError(message: string, result: CommandResult): RuntimeHostServiceManagerError {
  const detail = result.stderr.trim() || result.stdout.trim();
  return new RuntimeHostServiceManagerError(
    'service_manager_operation_failed',
    detail ? `${message}: ${detail}` : message,
  );
}

async function defaultRunSystemctl(args: readonly string[]): Promise<CommandResult> {
  return runCommand('systemctl', ['--user', ...args]);
}

async function defaultRunLoginctl(args: readonly string[]): Promise<CommandResult> {
  return runCommand('loginctl', args);
}

async function defaultRunJournalctl(args: readonly string[]): Promise<CommandResult> {
  return runCommand('journalctl', args);
}

async function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: SERVICE_MANAGER_COMMAND_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (exitCode) => {
      resolveResult({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
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
