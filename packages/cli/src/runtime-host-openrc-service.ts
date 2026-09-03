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

import { lstat, mkdir, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import {
  RUNTIME_HOST_SERVICE_LOG_MAX_BYTES,
  type RuntimeHostSupervisorProvider,
} from '@maka/runtime-host/operator';
import { resolveXdgConfigHome } from '@maka/storage/workspace-root';
import { readStableBoundedFile } from '@maka/storage/stable-storage';
import {
  formatRuntimeHostServiceLogs,
  removeRuntimeHostServiceFile,
  RuntimeHostServiceManagerError,
  writeRuntimeHostServiceFile,
} from './runtime-host-service-manager.js';
import {
  RUNTIME_HOST_UPDATE_INITIAL_DELAY_SECONDS,
  RUNTIME_HOST_UPDATE_INTERVAL_SECONDS,
  RUNTIME_HOST_UPDATE_RANDOM_DELAY_SECONDS,
} from './runtime-host-service-launch.js';
import {
  runRuntimeHostServiceManagerCommand,
  type RuntimeHostServiceManagerCommandResult,
} from './runtime-host-service-manager-process.js';
import {
  assertRuntimeHostProviderDefinition,
  type RuntimeHostLifecycleProvider,
  type RuntimeHostProviderDefinition,
  type RuntimeHostSupervisorStatus,
} from './runtime-host-lifecycle-provider.js';

type OpenRcProvider = Extract<RuntimeHostSupervisorProvider, 'openrc_user' | 'openrc_system'>;
type OpenRcCommand = 'rc-service' | 'rc-status' | 'rc-update' | 'supervise-daemon';
type OpenRcRunner = (
  command: OpenRcCommand,
  args: readonly string[],
) => Promise<RuntimeHostServiceManagerCommandResult>;

interface OpenRcServiceContext {
  readonly provider: OpenRcProvider;
  readonly name: string;
  readonly servicePath: string;
  readonly runlevelPath: string;
  readonly pidPath?: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly run: OpenRcRunner;
}

export interface OpenRcRuntimeHostLifecycleProviderOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string;
  readonly uid?: number;
  readonly runCommand?: OpenRcRunner;
  readonly paths?: {
    readonly initDirectory: string;
    readonly runlevelDirectory: string;
    readonly artifactDirectory: string;
    readonly logDirectory: string;
    readonly stateDirectory?: string;
  };
}

export function createOpenRcRuntimeHostLifecycleProvider(
  serviceId: string,
  provider: OpenRcProvider,
  options: OpenRcRuntimeHostLifecycleProviderOptions = {},
): RuntimeHostLifecycleProvider {
  assertServiceId(serviceId);
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const paths = options.paths ?? defaultPaths(provider, serviceId, env, homeDir);
  const run = options.runCommand ?? defaultRunOpenRcCommand;
  const host = createContext(provider, serviceId, '', 'host', paths, run);
  const update = createContext(provider, serviceId, '-update', 'update', paths, run);
  const updateCommandPath = join(paths.artifactDirectory, 'update');
  const uid = options.uid ?? process.getuid?.();

  const preflight = async (): Promise<void> => {
    if (provider === 'openrc_system' && uid !== 0) {
      throw unavailable(
        'OpenRC system services require an explicit root session; sudo is not used',
      );
    }
    if (provider === 'openrc_user') {
      const runtimeDirectory = env.XDG_RUNTIME_DIR;
      if (!runtimeDirectory || !isAbsolute(runtimeDirectory)) {
        throw unavailable('OpenRC user services require an absolute XDG_RUNTIME_DIR');
      }
      const runtime = await stat(runtimeDirectory).catch(() => undefined);
      if (!runtime?.isDirectory()) {
        throw unavailable('OpenRC user services require an active XDG_RUNTIME_DIR');
      }
      if (!(await detectOpenRcUserSessionActivation(currentUsername()))) {
        throw unavailable(
          'OpenRC user services are not configured for automatic session or boot activation; use an on-demand Runtime Host',
        );
      }
    }
    await requireProbe(run, 'supervise-daemon', ['--help'], false);
    await requireProbe(run, 'rc-service', ['--help'], false);
    const runlevel = await requireProbe(run, 'rc-status', [...scopeArgs(provider), '--runlevel']);
    if (runlevel.stdout.trim() !== 'default') {
      throw unavailable('The OpenRC default runlevel is not active');
    }
    await requireProbe(run, 'rc-update', [...scopeArgs(provider), 'show', 'default']);
  };

  return {
    supervisor: {
      provider,
      preflight,
      converge: (definition) => convergeOpenRcService(host, definition),
      verify: (definition) => verifyOpenRcService(host, definition),
      status: () => readOpenRcSupervisorStatus(host),
      activate: () => startOpenRcService(host),
      retire: () => stopOpenRcService(host),
      logs: () => readOpenRcLogs(host),
      uninstall: () => uninstallOpenRcService(host),
    },
    reconciliationTrigger: {
      provider: 'openrc_supervised_loop',
      converge: (definition) => convergeOpenRcService(update, definition, updateCommandPath),
      verify: (definition) => verifyOpenRcService(update, definition, updateCommandPath),
      status: async () => {
        const observed = await readOpenRcStatus(update);
        return { installed: observed.installed, active: observed.active };
      },
      activate: () => startOpenRcService(update),
      logs: () => readOpenRcLogs(update),
      uninstall: () => uninstallOpenRcService(update, updateCommandPath),
    },
  };
}

function renderOpenRcReconciliationLoop(definition: RuntimeHostProviderDefinition): string {
  assertRuntimeHostProviderDefinition(definition);
  const command = definition.command.map(quoteShellWord).join(' ');
  return [
    '#!/bin/sh',
    'umask 077',
    `initial_delay=${String(RUNTIME_HOST_UPDATE_INITIAL_DELAY_SECONDS)}`,
    `random_delay=${String(RUNTIME_HOST_UPDATE_RANDOM_DELAY_SECONDS)}`,
    "now=$(date +%s 2>/dev/null || printf '0')",
    'sleep "$((initial_delay + now % (random_delay + 1)))"',
    'while :; do',
    `  ${command} || :`,
    `  sleep ${String(RUNTIME_HOST_UPDATE_INTERVAL_SECONDS)}`,
    'done',
    '',
  ].join('\n');
}

function renderOpenRcService(
  context: OpenRcServiceContext,
  definition: RuntimeHostProviderDefinition,
  periodicCommandPath?: string,
): string {
  const command = periodicCommandPath ? '/bin/sh' : definition.command[0];
  const commandArguments = periodicCommandPath
    ? [periodicCommandPath]
    : definition.command.slice(1);
  return [
    '#!/sbin/openrc-run',
    `description=${quoteShellWord(context.name)}`,
    'supervisor=supervise-daemon',
    `command=${quoteDoubleQuotedShellValue(quoteShellWord(command))}`,
    `command_args=${quoteDoubleQuotedShellValue(commandArguments.map(quoteShellWord).join(' '))}`,
    `output_log=${quoteDoubleQuotedShellValue(quoteShellWord(context.stdoutPath))}`,
    `error_log=${quoteDoubleQuotedShellValue(quoteShellWord(context.stderrPath))}`,
    'retry=TERM/20/KILL/5',
    'respawn_delay=2',
    'respawn_max=0',
    '',
  ].join('\n');
}

async function convergeOpenRcService(
  context: OpenRcServiceContext,
  definition: RuntimeHostProviderDefinition,
  periodicCommandPath?: string,
): Promise<void> {
  assertRuntimeHostProviderDefinition(definition);
  await stopOpenRcService(context);
  await mkdir(dirname(context.stdoutPath), { recursive: true, mode: 0o700 });
  await writeRuntimeHostServiceFile(
    context.servicePath,
    renderOpenRcService(context, definition, periodicCommandPath),
    0o700,
  );
  if (periodicCommandPath) {
    await writeRuntimeHostServiceFile(
      periodicCommandPath,
      renderOpenRcReconciliationLoop(definition),
      0o700,
    );
  }
  await requireOpenRc(
    context,
    'rc-update',
    [...scopeArgs(context.provider), 'add', context.name, 'default'],
    'Enabling the Runtime Host OpenRC service failed',
  );
}

async function verifyOpenRcService(
  context: OpenRcServiceContext,
  definition: RuntimeHostProviderDefinition,
  periodicCommandPath?: string,
): Promise<void> {
  assertRuntimeHostProviderDefinition(definition);
  const expectedService = renderOpenRcService(context, definition, periodicCommandPath);
  const [service, enabled] = await Promise.all([
    readManagedFile(context.servicePath, expectedService),
    isEnabled(context),
  ]);
  const expectedCommand = periodicCommandPath
    ? renderOpenRcReconciliationLoop(definition)
    : undefined;
  const command = expectedCommand
    ? await readManagedFile(periodicCommandPath!, expectedCommand)
    : undefined;
  if (service !== expectedService || command !== expectedCommand || !enabled) {
    throw new RuntimeHostServiceManagerError(
      'target_mismatch',
      `The ${context.provider} service does not match its managed deployment`,
    );
  }
}

async function readOpenRcSupervisorStatus(
  context: OpenRcServiceContext,
): Promise<RuntimeHostSupervisorStatus> {
  const observed = await readOpenRcStatus(context);
  return { provider: context.provider, ...observed };
}

async function readOpenRcStatus(context: OpenRcServiceContext): Promise<{
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly active: boolean;
  readonly state: RuntimeHostSupervisorStatus['state'];
  readonly pid: number | null;
  readonly lastExitCode: null;
}> {
  const installed = await isRegularFile(context.servicePath);
  const enabled = await isEnabled(context);
  if (!installed) {
    return {
      installed: false,
      enabled,
      active: false,
      state: 'not_installed',
      pid: null,
      lastExitCode: null,
    };
  }
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await context.run('rc-service', [
      ...scopeArgs(context.provider),
      context.name,
      'status',
    ]);
  } catch (error) {
    throw unavailable('Unable to query the OpenRC service manager', error);
  }
  const active = result.exitCode === 0;
  return {
    installed,
    enabled,
    active,
    state:
      result.exitCode === 0
        ? 'running'
        : result.exitCode === 8 || result.exitCode === 4
          ? 'starting'
          : result.exitCode === 3 || result.exitCode === 16
            ? 'stopped'
            : 'failed',
    pid: active ? await readOpenRcPid(context.pidPath) : null,
    lastExitCode: null,
  };
}

async function startOpenRcService(context: OpenRcServiceContext): Promise<void> {
  if (!(await isRegularFile(context.servicePath))) return;
  const status = await readOpenRcStatus(context);
  if (status.active) return;
  await requireOpenRc(
    context,
    'rc-service',
    [...scopeArgs(context.provider), context.name, 'start'],
    'Starting the Runtime Host OpenRC service failed',
  );
}

async function stopOpenRcService(context: OpenRcServiceContext): Promise<void> {
  if (!(await isRegularFile(context.servicePath))) return;
  const status = await readOpenRcStatus(context);
  if (status.state === 'stopped') return;
  await requireOpenRc(
    context,
    'rc-service',
    [...scopeArgs(context.provider), context.name, 'stop'],
    'Stopping the Runtime Host OpenRC service failed',
  );
}

async function uninstallOpenRcService(
  context: OpenRcServiceContext,
  periodicCommandPath?: string,
): Promise<void> {
  await stopOpenRcService(context);
  if (await pathExists(context.runlevelPath)) {
    await requireOpenRc(
      context,
      'rc-update',
      [...scopeArgs(context.provider), 'del', context.name, 'default'],
      'Disabling the Runtime Host OpenRC service failed',
    );
  }
  await Promise.all([
    removeRuntimeHostServiceFile(context.servicePath, 'OpenRC service'),
    ...(periodicCommandPath
      ? [removeRuntimeHostServiceFile(periodicCommandPath, 'OpenRC command')]
      : []),
  ]);
  const status = await readOpenRcStatus(context);
  if (
    status.installed ||
    status.enabled ||
    status.active ||
    (await pathExists(context.runlevelPath))
  ) {
    throw new RuntimeHostServiceManagerError(
      'uninstall_incomplete',
      'The Runtime Host OpenRC service still has managed state',
    );
  }
}

async function readOpenRcLogs(context: OpenRcServiceContext): Promise<string> {
  const [stdout, stderr] = await Promise.all([
    readLogTail(context.stdoutPath),
    readLogTail(context.stderrPath),
  ]);
  return formatRuntimeHostServiceLogs([
    { label: 'stdout', logs: stdout },
    { label: 'stderr', logs: stderr },
  ]);
}

function createContext(
  provider: OpenRcProvider,
  serviceId: string,
  suffix: string,
  artifact: string,
  paths: NonNullable<OpenRcRuntimeHostLifecycleProviderOptions['paths']>,
  run: OpenRcRunner,
): OpenRcServiceContext {
  const name = `maka-runtime-host-${serviceId}${suffix}`;
  return {
    provider,
    name,
    servicePath: join(paths.initDirectory, name),
    runlevelPath: join(paths.runlevelDirectory, name),
    ...(paths.stateDirectory
      ? { pidPath: join(paths.stateDirectory, 'options', name, 'child_pid') }
      : {}),
    stdoutPath: join(paths.logDirectory, `${artifact}.stdout.log`),
    stderrPath: join(paths.logDirectory, `${artifact}.stderr.log`),
    run,
  };
}

function defaultPaths(
  provider: OpenRcProvider,
  serviceId: string,
  env: NodeJS.ProcessEnv,
  homeDir: string,
): NonNullable<OpenRcRuntimeHostLifecycleProviderOptions['paths']> {
  if (provider === 'openrc_system') {
    return {
      initDirectory: '/etc/init.d',
      runlevelDirectory: '/etc/runlevels/default',
      artifactDirectory: join('/etc/maka/runtime-host', serviceId),
      logDirectory: join('/var/log/maka/runtime-host', serviceId),
      stateDirectory: '/run/openrc',
    };
  }
  const config = resolveXdgConfigHome(env, homeDir);
  const stateHome =
    env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : join(homeDir, '.local', 'state');
  const runtime = env.XDG_RUNTIME_DIR;
  return {
    initDirectory: join(config, 'rc', 'init.d'),
    runlevelDirectory: join(config, 'rc', 'runlevels', 'default'),
    artifactDirectory: join(config, 'maka', 'runtime-host', serviceId, 'openrc'),
    logDirectory: join(stateHome, 'maka', 'runtime-host', serviceId),
    ...(runtime && isAbsolute(runtime) ? { stateDirectory: join(runtime, 'openrc') } : {}),
  };
}

function scopeArgs(provider: OpenRcProvider): readonly string[] {
  return provider === 'openrc_user' ? ['--user'] : [];
}

async function requireProbe(
  run: OpenRcRunner,
  command: OpenRcCommand,
  args: readonly string[],
  requireSuccess = true,
): Promise<RuntimeHostServiceManagerCommandResult> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await run(command, args);
  } catch (error) {
    throw unavailable(`${command} is unavailable`, error);
  }
  if (requireSuccess && result.exitCode !== 0) {
    throw unavailable(`${command} is unavailable${commandDetail(result)}`);
  }
  return result;
}

async function requireOpenRc(
  context: OpenRcServiceContext,
  command: OpenRcCommand,
  args: readonly string[],
  message: string,
): Promise<void> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await context.run(command, args);
  } catch (error) {
    throw unavailable(message, error);
  }
  if (result.exitCode !== 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      `${message}${commandDetail(result)}`,
    );
  }
}

function commandDetail(result: RuntimeHostServiceManagerCommandResult): string {
  const detail = result.stderr.trim() || result.stdout.trim();
  return detail ? `: ${detail}` : '';
}

async function isEnabled(context: OpenRcServiceContext): Promise<boolean> {
  try {
    const [target, service] = await Promise.all([
      realpath(context.runlevelPath),
      realpath(context.servicePath),
    ]);
    return target === service;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw error;
  }
}

async function readManagedFile(path: string, expected: string): Promise<string | null> {
  return readStableBoundedFile({
    path,
    maxBytes: Buffer.byteLength(expected),
    invalidFile: () =>
      new RuntimeHostServiceManagerError(
        'target_mismatch',
        'A managed OpenRC artifact is not a stable regular file',
      ),
  })
    .then((bytes) => {
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new RuntimeHostServiceManagerError(
          'target_mismatch',
          'A managed OpenRC artifact is not valid UTF-8',
        );
      }
    })
    .catch((error: unknown) => {
      if (isNodeError(error, 'ENOENT')) return null;
      throw error;
    });
}

async function readOpenRcPid(path: string | undefined): Promise<number | null> {
  if (!path) return null;
  try {
    const value = (
      await readStableBoundedFile({
        path,
        maxBytes: 32,
        invalidFile: () => new Error('Invalid OpenRC process state'),
      })
    )
      .toString('utf8')
      .trim();
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return null;
    return null;
  }
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

async function detectOpenRcUserSessionActivation(username: string | undefined): Promise<boolean> {
  if (username) {
    try {
      const [configured, template] = await Promise.all([
        realpath(join('/etc/runlevels/default', `user.${username}`)),
        realpath('/etc/init.d/user'),
      ]);
      if (configured === template) return true;
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }
  let entries;
  try {
    entries = await readdir('/etc/pam.d', { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, 'ENOENT') || isNodeError(error, 'EACCES')) return false;
    throw error;
  }
  for (const entry of entries.slice(0, 256)) {
    if (!entry.isFile()) continue;
    const contents = await readFile(join('/etc/pam.d', entry.name), 'utf8').catch(() => '');
    if (/^[^#\n]*\bpam_openrc\.so\b/mu.test(contents)) return true;
  }
  return false;
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function quoteDoubleQuotedShellValue(value: string): string {
  return `"${value.replace(/[\\"$`]/gu, '\\$&')}"`;
}

function currentUsername(): string | undefined {
  try {
    return userInfo().username;
  } catch {
    return undefined;
  }
}

function unavailable(message: string, cause?: unknown): RuntimeHostServiceManagerError {
  return new RuntimeHostServiceManagerError(
    'service_manager_unavailable',
    message,
    cause === undefined ? undefined : { cause },
  );
}

async function defaultRunOpenRcCommand(
  command: OpenRcCommand,
  args: readonly string[],
): Promise<RuntimeHostServiceManagerCommandResult> {
  return runRuntimeHostServiceManagerCommand(command, args);
}

function assertServiceId(serviceId: string): void {
  if (!/^[a-f0-9]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}
