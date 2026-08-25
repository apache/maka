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

import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
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
import { escapeXml, readLogTail } from './runtime-host-launch-agent-service.js';
import {
  runtimeHostUpdateSchedule,
  runtimeHostUpdateSchedulerArguments,
  type RuntimeHostUpdateSchedulerBackend,
} from './runtime-host-update-scheduler.js';

type LaunchctlRunner = (args: readonly string[]) => Promise<RuntimeHostServiceManagerCommandResult>;

export interface LaunchAgentUpdateSchedulerOptions {
  readonly homeDir?: string;
  readonly uid?: number;
  readonly runLaunchctl?: LaunchctlRunner;
}

export function createLaunchAgentRuntimeHostUpdateScheduler(
  serviceId: string,
  options: LaunchAgentUpdateSchedulerOptions = {},
): RuntimeHostUpdateSchedulerBackend {
  const homeDir = options.homeDir ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new RuntimeHostServiceManagerError(
      'service_manager_unavailable',
      'The current macOS user identity could not be determined',
    );
  }
  const paths = resolveLaunchAgentRuntimeHostUpdateSchedulerPaths(serviceId, homeDir);
  const domain = `gui/${String(uid)}`;
  const target = `${domain}/${paths.label}`;
  const runLaunchctl = options.runLaunchctl ?? defaultRunLaunchctl;

  const isLoaded = async (): Promise<boolean> => {
    const result = await runLaunchctl(['print', target]);
    return result.exitCode === 0;
  };
  const bootout = async (): Promise<void> => {
    if (!(await isLoaded())) return;
    await requireLaunchctl(
      runLaunchctl,
      ['bootout', target],
      'Stopping the Runtime Host update scheduler failed',
    );
  };
  const apply = async (config: RuntimeHostManagedServiceConfig): Promise<void> => {
    const arguments_ = runtimeHostUpdateSchedulerArguments(config);
    await bootout();
    if (!arguments_) {
      await removeFiles(paths);
      return;
    }
    await prepareLogs(paths);
    await writeRuntimeHostServiceFile(
      paths.plistPath,
      renderLaunchAgentRuntimeHostUpdateSchedulerPlist(serviceId, arguments_, paths),
      0o600,
    );
    await requireLaunchctl(
      runLaunchctl,
      ['bootstrap', domain, paths.plistPath],
      'Starting the Runtime Host update scheduler failed',
    );
  };

  return {
    install: async (config) => {
      const snapshot = await capture(paths.plistPath, isLoaded);
      try {
        await apply(config);
      } catch (error) {
        await restore(snapshot, paths, domain, target, runLaunchctl, error);
      }
      let rolledBack = false;
      return {
        rollback: async () => {
          if (rolledBack) return;
          rolledBack = true;
          await restore(snapshot, paths, domain, target, runLaunchctl);
        },
      } satisfies RuntimeHostServiceDeployment;
    },
    verifyDeployment: async (config) => {
      const arguments_ = runtimeHostUpdateSchedulerArguments(config);
      const [plist, loaded] = await Promise.all([readOptional(paths.plistPath), isLoaded()]);
      if (!arguments_) {
        if (plist !== null || loaded) throw mismatch();
        return;
      }
      if (
        !loaded ||
        plist !== renderLaunchAgentRuntimeHostUpdateSchedulerPlist(serviceId, arguments_, paths)
      ) {
        throw mismatch();
      }
    },
    logs: async () => {
      const [stdout, stderr] = await Promise.all([
        readLogTail(paths.stdoutPath),
        readLogTail(paths.stderrPath),
      ]);
      return [stdout && `stdout:\n${stdout}`, stderr && `stderr:\n${stderr}`]
        .filter(Boolean)
        .join('\n');
    },
    uninstall: async () => {
      await bootout();
      await removeFiles(paths);
    },
  };
}

export function resolveLaunchAgentRuntimeHostUpdateSchedulerPaths(
  serviceId: string,
  homeDir = homedir(),
): {
  readonly label: string;
  readonly plistPath: string;
  readonly stdoutPath: string;
  readonly stderrPath: string;
} {
  if (!/^[0-9a-f]{64}$/u.test(serviceId)) throw new TypeError('Invalid Runtime Host service ID');
  const label = `com.maka.runtime-host-update.${serviceId}`;
  const logRoot = join(homeDir, 'Library', 'Logs', 'Maka', 'runtime-host-services');
  return {
    label,
    plistPath: join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`),
    stdoutPath: join(logRoot, `${label}.stdout.log`),
    stderrPath: join(logRoot, `${label}.stderr.log`),
  };
}

export function renderLaunchAgentRuntimeHostUpdateSchedulerPlist(
  serviceId: string,
  args: readonly string[],
  paths: ReturnType<typeof resolveLaunchAgentRuntimeHostUpdateSchedulerPaths>,
): string {
  const schedule = runtimeHostUpdateSchedule(serviceId);
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
    ...args.map(stringEntry),
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    '  <dict>',
    '    <key>Minute</key>',
    `    <integer>${String(schedule.minute)}</integer>`,
    '  </dict>',
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

interface Snapshot {
  readonly plist: string | null;
  readonly loaded: boolean;
}

async function capture(path: string, isLoaded: () => Promise<boolean>): Promise<Snapshot> {
  const [plist, loaded] = await Promise.all([readOptional(path), isLoaded()]);
  return { plist, loaded };
}

async function restore(
  snapshot: Snapshot,
  paths: ReturnType<typeof resolveLaunchAgentRuntimeHostUpdateSchedulerPaths>,
  domain: string,
  target: string,
  runLaunchctl: LaunchctlRunner,
  originalError?: unknown,
): Promise<never | void> {
  try {
    const loaded = (await runLaunchctl(['print', target])).exitCode === 0;
    if (loaded) {
      await requireLaunchctl(
        runLaunchctl,
        ['bootout', target],
        'Stopping the replacement Runtime Host update scheduler failed',
      );
    }
    if (snapshot.plist === null) {
      await removeFiles(paths);
    } else {
      await writeRuntimeHostServiceFile(paths.plistPath, snapshot.plist, 0o600);
      if (snapshot.loaded) {
        await requireLaunchctl(
          runLaunchctl,
          ['bootstrap', domain, paths.plistPath],
          'Restoring the Runtime Host update scheduler failed',
        );
      }
    }
  } catch (rollbackError) {
    if (originalError === undefined) throw rollbackError;
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      'Installing the Runtime Host update scheduler failed and its previous state could not be restored',
      { cause: new AggregateError([originalError, rollbackError]) },
    );
  }
  if (originalError !== undefined) throw originalError;
}

async function prepareLogs(
  paths: ReturnType<typeof resolveLaunchAgentRuntimeHostUpdateSchedulerPaths>,
): Promise<void> {
  for (const path of [paths.stdoutPath, paths.stderrPath]) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const file = await open(path, 'a', 0o600);
    await file.close();
  }
}

async function removeFiles(
  paths: ReturnType<typeof resolveLaunchAgentRuntimeHostUpdateSchedulerPaths>,
): Promise<void> {
  await Promise.all([
    removeRuntimeHostServiceFile(paths.plistPath, 'LaunchAgent update scheduler'),
    removeRuntimeHostServiceFile(paths.stdoutPath, 'LaunchAgent update scheduler stdout log'),
    removeRuntimeHostServiceFile(paths.stderrPath, 'LaunchAgent update scheduler stderr log'),
  ]);
}

async function readOptional(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch((error: unknown) => {
    if (isNodeError(error, 'ENOENT')) return null;
    throw error;
  });
}

async function requireLaunchctl(
  runLaunchctl: LaunchctlRunner,
  args: readonly string[],
  message: string,
): Promise<void> {
  let result: RuntimeHostServiceManagerCommandResult;
  try {
    result = await runLaunchctl(args);
  } catch (error) {
    throw new RuntimeHostServiceManagerError('service_manager_unavailable', message, {
      cause: error,
    });
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new RuntimeHostServiceManagerError(
      'service_manager_operation_failed',
      `${message}${detail ? `: ${detail}` : ''}`,
    );
  }
}

function mismatch(): RuntimeHostServiceManagerError {
  return new RuntimeHostServiceManagerError(
    'target_mismatch',
    'The loaded Runtime Host update scheduler does not match its managed deployment',
  );
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

function defaultRunLaunchctl(args: readonly string[]) {
  return runRuntimeHostServiceManagerCommand('launchctl', args);
}
