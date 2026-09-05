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

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import {
  assertRuntimeHostProviderDefinition,
  type RuntimeHostLifecycleProvider,
  type RuntimeHostProviderDefinition,
  type RuntimeHostSupervisorStatus,
} from './runtime-host-lifecycle-provider.js';
import { resolveRuntimeHostNativePath } from './runtime-host-peer-artifact.js';
import { RuntimeHostServiceManagerError } from './runtime-host-service-manager.js';
import { resolveRuntimeHostWindowsTaskLauncherPath } from './runtime-host-windows-task-launcher-artifact.js';

const require = createRequire(import.meta.url);
const ROOT_ID_PATTERN = /^[a-f0-9]{64}$/u;

type WindowsTaskTarget = 'host' | 'reconciliation';

interface WindowsTaskStatus {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly state: RuntimeHostSupervisorStatus['state'];
  readonly pid: number | null;
  readonly lastExitCode: number | null;
}

interface WindowsTaskNativeStatus {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly state: RuntimeHostSupervisorStatus['state'];
  readonly pid?: number;
  readonly lastExitCode?: number;
}

interface WindowsLifecycleNative {
  readonly windowsTaskProbe: () => void;
  readonly windowsTaskConverge: (
    rootId: string,
    target: WindowsTaskTarget,
    runnerPath: string,
    command: string[],
  ) => void;
  readonly windowsTaskVerify: (
    rootId: string,
    target: WindowsTaskTarget,
    runnerPath: string,
    command: string[],
  ) => void;
  readonly windowsTaskConvergeLauncher?: (
    rootId: string,
    target: WindowsTaskTarget,
    launcherPath: string,
    command: string[],
  ) => void;
  readonly windowsTaskVerifyLauncher?: (
    rootId: string,
    target: WindowsTaskTarget,
    launcherPath: string,
    command: string[],
  ) => void;
  readonly windowsTaskStatus: (rootId: string, target: WindowsTaskTarget) => unknown;
  readonly windowsTaskActivate: (rootId: string) => void;
  readonly windowsTaskRetire: (rootId: string) => void;
  readonly windowsTaskUninstall: (rootId: string, target: WindowsTaskTarget) => void;
  readonly ownCurrentProcessTree: () => void;
}

export interface WindowsRuntimeHostLifecycleProviderOptions {
  readonly cliPath: string;
}

export function createWindowsRuntimeHostLifecycleProvider(
  rootId: string,
  options: WindowsRuntimeHostLifecycleProviderOptions,
): RuntimeHostLifecycleProvider {
  if (!ROOT_ID_PATTERN.test(rootId)) {
    throw new RuntimeHostServiceManagerError(
      'invalid_config',
      'The Runtime Host Root ID is invalid',
    );
  }
  const native = createWindowsLifecycleNativeLoader(options.cliPath);
  const runnerPath = join(dirname(options.cliPath), 'runtime-host-windows-task-runner.js');
  let launcherPath: Promise<string> | undefined;
  const resolveLauncherPath = (): Promise<string> => {
    launcherPath ??= resolveRuntimeHostWindowsTaskLauncherPath(options.cliPath);
    return launcherPath;
  };
  const converge = async (
    target: WindowsTaskTarget,
    definition: RuntimeHostProviderDefinition,
  ): Promise<void> => {
    assertRuntimeHostProviderDefinition(definition);
    const control = await native();
    if (supportsLauncherProjection(control)) {
      control.windowsTaskConvergeLauncher(rootId, target, await resolveLauncherPath(), [
        ...definition.command,
      ]);
    } else {
      control.windowsTaskConverge(rootId, target, runnerPath, [...definition.command]);
    }
  };
  const verify = async (
    target: WindowsTaskTarget,
    definition: RuntimeHostProviderDefinition,
  ): Promise<void> => {
    assertRuntimeHostProviderDefinition(definition);
    const control = await native();
    if (supportsLauncherProjection(control)) {
      control.windowsTaskVerifyLauncher(rootId, target, await resolveLauncherPath(), [
        ...definition.command,
      ]);
    } else {
      control.windowsTaskVerify(rootId, target, runnerPath, [...definition.command]);
    }
  };
  const status = async (target: WindowsTaskTarget): Promise<WindowsTaskStatus> =>
    decodeStatus((await native()).windowsTaskStatus(rootId, target));

  return {
    supervisor: {
      provider: 'windows_task',
      preflight: async () => {
        const control = await native();
        if (supportsLauncherProjection(control)) await resolveLauncherPath();
        control.windowsTaskProbe();
      },
      converge: (definition) => converge('host', definition),
      verify: (definition) => verify('host', definition),
      status: async () => {
        const observed = await status('host');
        return {
          provider: 'windows_task',
          ...observed,
          active: observed.state === 'running' && observed.pid !== null,
        };
      },
      activate: async () => (await native()).windowsTaskActivate(rootId),
      retire: async () => (await native()).windowsTaskRetire(rootId),
      logs: async () => formatTaskStatus('host', await status('host')),
      uninstall: async () => (await native()).windowsTaskUninstall(rootId, 'host'),
    },
    reconciliationTrigger: {
      provider: 'windows_task_timer',
      converge: (definition) => converge('reconciliation', definition),
      verify: (definition) => verify('reconciliation', definition),
      status: async () => {
        const observed = await status('reconciliation');
        return { installed: observed.installed, active: observed.installed && observed.enabled };
      },
      activate: async () => {
        const observed = await status('reconciliation');
        if (!observed.installed || !observed.enabled) {
          throw new RuntimeHostServiceManagerError(
            'target_mismatch',
            'The Windows reconciliation task is not enabled',
          );
        }
      },
      logs: async () => formatTaskStatus('reconciliation', await status('reconciliation')),
      uninstall: async () => (await native()).windowsTaskUninstall(rootId, 'reconciliation'),
    },
  };
}

export async function ownWindowsRuntimeHostProcessTree(cliPath: string): Promise<void> {
  const nativePath = await resolveRuntimeHostNativePath(cliPath);
  loadWindowsLifecycleNative(nativePath).ownCurrentProcessTree();
}

function createWindowsLifecycleNativeLoader(
  cliPath: string,
): () => Promise<WindowsLifecycleNative> {
  let native: Promise<WindowsLifecycleNative> | undefined;
  return () => {
    native ??= resolveRuntimeHostNativePath(cliPath).then(loadWindowsLifecycleNative);
    return native;
  };
}

function loadWindowsLifecycleNative(path: string): WindowsLifecycleNative {
  const loaded = require(path) as Partial<WindowsLifecycleNative>;
  const methods = [
    'windowsTaskProbe',
    'windowsTaskConverge',
    'windowsTaskVerify',
    'windowsTaskStatus',
    'windowsTaskActivate',
    'windowsTaskRetire',
    'windowsTaskUninstall',
    'ownCurrentProcessTree',
  ] as const satisfies readonly (keyof WindowsLifecycleNative)[];
  if (methods.some((method) => typeof loaded[method] !== 'function')) {
    throw unavailable(
      'The Runtime Host native artifact does not support Windows lifecycle control',
    );
  }
  if (
    (typeof loaded.windowsTaskConvergeLauncher === 'function') !==
    (typeof loaded.windowsTaskVerifyLauncher === 'function')
  ) {
    throw unavailable(
      'The Runtime Host native artifact has an incomplete Windows launcher contract',
    );
  }
  return loaded as WindowsLifecycleNative;
}

function supportsLauncherProjection(
  native: WindowsLifecycleNative,
): native is WindowsLifecycleNative &
  Required<
    Pick<WindowsLifecycleNative, 'windowsTaskConvergeLauncher' | 'windowsTaskVerifyLauncher'>
  > {
  return typeof native.windowsTaskConvergeLauncher === 'function';
}

function decodeStatus(value: unknown): WindowsTaskStatus {
  if (
    !isRecord(value) ||
    typeof value.installed !== 'boolean' ||
    typeof value.enabled !== 'boolean' ||
    !['not_installed', 'stopped', 'starting', 'running', 'failed'].includes(String(value.state)) ||
    !(value.pid === undefined || (Number.isSafeInteger(value.pid) && Number(value.pid) > 0)) ||
    !(
      value.lastExitCode === undefined ||
      (Number.isSafeInteger(value.lastExitCode) && Number(value.lastExitCode) >= 0)
    )
  ) {
    throw unavailable('The Windows lifecycle status response is invalid');
  }
  const status = value as unknown as WindowsTaskNativeStatus;
  return {
    ...status,
    pid: status.pid ?? null,
    lastExitCode: status.lastExitCode ?? null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatTaskStatus(target: WindowsTaskTarget, status: WindowsTaskStatus): string {
  return `Windows Task Scheduler ${target}: ${JSON.stringify(status)}\n`;
}

function unavailable(message: string, cause?: unknown): RuntimeHostServiceManagerError {
  return new RuntimeHostServiceManagerError('service_manager_unavailable', message, { cause });
}
