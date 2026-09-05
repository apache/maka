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

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import {
  normalizeRuntimeHostWslDistribution,
  resolveSystemRuntimeHostWslExecutable,
  type RuntimeHostWslProcessFactory,
} from '@maka/runtime-host/client';
import {
  decodeRuntimeHostSetupFrame,
  decodeRuntimeHostServiceManagementFrame,
  RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
  RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
  createRuntimeHostOperatorCommand,
  decodeRuntimeHostPosixOperatorCommand,
  runtimeHostOperatorInvocation,
  type RuntimeHostNodeOperatorCommand,
  type RuntimeHostPosixOperatorCommand,
  type RuntimeHostSetupFrame,
  type RuntimeHostSetupPhase,
  type RuntimeHostServiceManagementFrame,
} from '@maka/runtime-host/operator';
import { createRuntimeHostFramedOutputFilter } from './runtime-host-framed-output.js';
import type { DesktopRuntimeHostSetupPackage } from './runtime-host-setup-package.js';

const WSL_SETUP_TIMEOUT_MS = 10 * 60_000;
const WSL_SETUP_OUTPUT_MAX_BYTES = 64 * 1024;
const WSL_SETUP_STDERR_MAX_BYTES = 8 * 1024;

type RuntimeHostSetupCompleteFrame = Extract<RuntimeHostSetupFrame, { kind: 'complete' }>;
type RuntimeHostWslSetupCompleteFrame = Omit<RuntimeHostSetupCompleteFrame, 'operator'> & {
  readonly operator: RuntimeHostNodeOperatorCommand<'posix'>;
};
type RuntimeHostManagementTerminalFrame = Exclude<
  RuntimeHostServiceManagementFrame,
  { readonly kind: 'progress' }
>;

export interface DesktopRuntimeHostWslManagementInput {
  readonly distribution: string;
  readonly operator: RuntimeHostPosixOperatorCommand;
  readonly action: 'status' | 'configure';
  readonly expectedTarget: {
    readonly serviceId: string;
    readonly rootPath: string;
    readonly rootId: string;
    readonly deploymentId?: string;
  };
  readonly projectDirectoryRoots?: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly expectedConfigFingerprint?: string;
  readonly allowInterruptActiveTasks?: boolean;
  readonly signal?: AbortSignal;
}

type RuntimeHostWslManagementProcessFactory = (
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) => ChildProcessWithoutNullStreams;

export async function runDesktopRuntimeHostWslManagement(
  input: DesktopRuntimeHostWslManagementInput,
  overrides: {
    readonly processFactory?: RuntimeHostWslManagementProcessFactory;
    readonly wslExecutable?: string;
  } = {},
): Promise<RuntimeHostManagementTerminalFrame> {
  input.signal?.throwIfAborted();
  const distribution = normalizeRuntimeHostWslDistribution(input.distribution);
  const operator = decodeRuntimeHostPosixOperatorCommand(input.operator);
  const invocation = runtimeHostOperatorInvocation(operator, [
    input.action,
    '--framed',
    ...(input.projectDirectoryRoots === undefined
      ? []
      : input.projectDirectoryRoots.length === 0
        ? ['--no-project-roots']
        : input.projectDirectoryRoots.flatMap(({ label, path }) => [
            '--project-root-json',
            JSON.stringify({ label, path }),
          ])),
    ...(input.expectedConfigFingerprint
      ? ['--expected-config-fingerprint', input.expectedConfigFingerprint]
      : []),
    ...(input.allowInterruptActiveTasks ? ['--allow-interrupt-active-tasks'] : []),
    '--expected-service-id',
    input.expectedTarget.serviceId,
    '--expected-root-path',
    input.expectedTarget.rootPath,
    '--expected-root-id',
    input.expectedTarget.rootId,
    ...(input.expectedTarget.deploymentId
      ? ['--expected-deployment-id', input.expectedTarget.deploymentId]
      : []),
  ]);
  const args = [
    '--distribution',
    distribution,
    '--exec',
    invocation.executable,
    ...invocation.args,
  ];
  const environment = passEnvironmentToWsl(
    process.env,
    RUNTIME_HOST_OPERATOR_PROJECT_DIRECTORY_CONFIGURATION_REQUEST_ENV,
    '1',
  );
  const child = (overrides.processFactory ?? spawnWslManagement)(
    overrides.wslExecutable ?? resolveSystemRuntimeHostWslExecutable(),
    args,
    environment,
  );
  const terminal = await runWslFramedProcess({
    child,
    signal: input.signal,
    prefix: RUNTIME_HOST_SERVICE_MANAGEMENT_FRAME_PREFIX,
    decode: decodeRuntimeHostServiceManagementFrame,
    label: 'WSL Runtime Host management',
    onFrame: (frame) => {
      if (frame.kind === 'progress') {
        throw new Error('WSL Runtime Host management returned unexpected progress');
      }
      return frame;
    },
  });
  if (terminal.action !== input.action) {
    throw new Error('WSL Runtime Host returned an unrelated management result');
  }
  return terminal;
}

export interface DesktopRuntimeHostWslSetupInput {
  readonly distribution: string;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
  readonly principalId: string;
  readonly projectDirectoryRoots?: readonly {
    readonly label: string;
    readonly path: string;
  }[];
  readonly signal?: AbortSignal;
}

export async function runDesktopRuntimeHostWslSetup(
  input: DesktopRuntimeHostWslSetupInput,
  onProgress: (frame: { readonly phase: RuntimeHostSetupPhase }) => void,
  onComplete?: () => void,
  overrides: {
    readonly processFactory?: RuntimeHostWslProcessFactory;
    readonly wslExecutable?: string;
  } = {},
): Promise<RuntimeHostWslSetupCompleteFrame> {
  input.signal?.throwIfAborted();
  const distribution = normalizeRuntimeHostWslDistribution(input.distribution);
  const processFactory = overrides.processFactory ?? spawnWsl;
  const executable = overrides.wslExecutable ?? resolveSystemRuntimeHostWslExecutable();
  const setupPackage = await resolveWslPackageSpecifier(
    input.setupPackage,
    distribution,
    executable,
    processFactory,
  );
  const command = runtimeHostWslSetupCommand(setupPackage, input);
  const child = processFactory(executable, ['--distribution', distribution, '--exec', '/bin/sh', '-lc', command]);
  return runWslFramedProcess({
    child,
    signal: input.signal,
    prefix: RUNTIME_HOST_SETUP_FRAME_PREFIX,
    decode: decodeRuntimeHostSetupFrame,
    label: 'WSL Maka setup',
    onFrame: (frame) => {
      if (frame.kind === 'progress') {
        onProgress(frame);
        return undefined;
      }
      if (frame.kind === 'error') throw new Error(frame.error.message);
      if (frame.operator.platform !== 'posix') {
        throw new Error('WSL Runtime Host setup returned a non-POSIX operator');
      }
      return {
        ...frame,
        operator: createRuntimeHostOperatorCommand({
          platform: 'posix',
          nodePath: frame.operator.nodePath,
          modulePath: frame.operator.modulePath,
        }),
      };
    },
    onResult: () => onComplete?.(),
  });
}

async function resolveWslPackageSpecifier(
  setupPackage: DesktopRuntimeHostSetupPackage,
  distribution: string,
  executable: string,
  processFactory: RuntimeHostWslProcessFactory,
): Promise<{ readonly specifier: string; readonly integrity?: string }> {
  if (setupPackage.kind === 'npm') {
    return { specifier: setupPackage.specifier };
  }
  const child = processFactory(executable, ['--distribution', distribution, '--exec', 'wslpath', '-a', '-u', setupPackage.path]);
  child.stdin.end();
  const stdout = collectBounded(child.stdout, 4 * 1024);
  const stderr = collectBounded(child.stderr, WSL_SETUP_STDERR_MAX_BYTES);
  const [exit, capturedStdout, capturedStderr] = await Promise.all([
    childExit(child),
    stdout,
    stderr,
  ]);
  const path = requireBoundedOutput(capturedStdout).toString('utf8').trim();
  if (exit.code !== 0 || !path.startsWith('/')) {
    const diagnostic = formatBoundedDiagnostic(capturedStderr);
    throw new Error(`WSL could not resolve the setup package path${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  return { specifier: path, integrity: setupPackage.integrity };
}

function runtimeHostWslSetupCommand(
  setupPackage: { readonly specifier: string; readonly integrity?: string },
  input: Pick<DesktopRuntimeHostWslSetupInput, 'principalId' | 'projectDirectoryRoots'>,
): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(input.principalId)) {
    throw new Error('Runtime Host setup principal is invalid');
  }
  const args = [
    'maka',
    'runtime-host',
    'setup',
    '--principal',
    input.principalId,
    '--preset',
    'desktop-client',
    '--lifecycle',
    'on-demand',
    '--repair-root-after-remount',
    '--update-existing',
    ...(input.projectDirectoryRoots === undefined
      ? []
      : input.projectDirectoryRoots.length === 0
        ? ['--no-project-roots']
        : input.projectDirectoryRoots.flatMap(({ label, path }) => [
            '--project-root-json',
            JSON.stringify({ label, path }),
          ])),
    '--json',
  ];
  const invocation = ['npx', '--yes', '--package', setupPackage.specifier, ...args]
    .map(quotePosix)
    .join(' ');
  const environment = setupPackage.integrity
    ? `${RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV}=${quotePosix(setupPackage.integrity)} `
    : '';
  const command = `maka_prefix=$(mktemp -d) || exit 1; trap 'rm -rf -- "$maka_prefix"' EXIT; cd "$maka_prefix" || exit 1; ${environment}${invocation}`;
  const loginCommand = `exec /bin/sh -c ${quotePosix(command)}`;
  return `exec "\${SHELL:-/bin/sh}" -lic ${quotePosix(loginCommand)}`;
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function spawnWsl(executable: string, args: readonly string[]) {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function spawnWslManagement(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
) {
  return spawn(executable, args, {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: environment,
  });
}

function passEnvironmentToWsl(
  source: NodeJS.ProcessEnv,
  name: string,
  value: string,
): NodeJS.ProcessEnv {
  const existing = source.WSLENV?.split(':').filter(Boolean) ?? [];
  const included = existing.some((entry) => entry.split('/')[0] === name);
  return {
    ...source,
    [name]: value,
    WSLENV: included ? existing.join(':') : [...existing, name].join(':'),
  };
}

async function runWslFramedProcess<Frame, Result>(input: {
  readonly child: ChildProcessWithoutNullStreams;
  readonly signal?: AbortSignal;
  readonly prefix: string;
  readonly decode: (line: string) => Frame | undefined;
  readonly label: string;
  readonly onFrame: (frame: Frame) => Result | undefined;
  readonly onResult?: (result: Result) => void;
}): Promise<Result> {
  const abort = () => input.child.kill();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  input.child.stdin.end();
  let result: Result | undefined;
  let failure: Error | undefined;
  const filter = createRuntimeHostFramedOutputFilter({
    prefix: input.prefix,
    pendingMaxBytes: WSL_SETUP_OUTPUT_MAX_BYTES,
    decode: input.decode,
    label: input.label,
    onFrame: (frame) => {
      try {
        const terminal = input.onFrame(frame);
        if (terminal === undefined) return;
        if (result !== undefined) {
          throw new Error(`${input.label} returned multiple results`);
        }
        result = terminal;
        input.onResult?.(terminal);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    },
    onError: (error) => {
      failure = error;
    },
  });
  let outputBytes = 0;
  input.child.stdout.setEncoding('utf8');
  input.child.stdout.on('data', (value: Buffer | string) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    outputBytes += chunk.byteLength;
    if (outputBytes > WSL_SETUP_OUTPUT_MAX_BYTES) {
      failure = new Error(`${input.label} output exceeded its byte limit`);
      input.child.kill();
      return;
    }
    filter.push(chunk.toString('utf8'));
  });
  const stderr = collectBounded(input.child.stderr, WSL_SETUP_STDERR_MAX_BYTES);
  const timeout = setTimeout(() => input.child.kill(), WSL_SETUP_TIMEOUT_MS);
  const [exit, capturedStderr] = await Promise.all([
    childExit(input.child),
    stderr,
  ]).finally(() => {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  });
  filter.finish();
  input.signal?.throwIfAborted();
  if (failure) throw failure;
  if (result === undefined) {
    const diagnostic = formatBoundedDiagnostic(capturedStderr);
    throw new Error(
      `${input.label} exited with code ${String(exit.code)} without a result${diagnostic ? `: ${diagnostic}` : ''}`,
    );
  }
  return result;
}

function childExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

interface BoundedOutput {
  readonly bytes: Buffer;
  readonly complete: boolean;
}

async function collectBounded(stream: Readable, maxBytes: number): Promise<BoundedOutput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let complete = true;
  try {
    for await (const value of stream) {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      const remaining = Math.max(0, maxBytes - bytes);
      if (remaining > 0) {
        chunks.push(chunk.subarray(0, remaining));
        bytes += Math.min(chunk.byteLength, remaining);
      }
      if (chunk.byteLength > remaining) complete = false;
    }
  } catch {
    complete = false;
  }
  return { bytes: Buffer.concat(chunks), complete };
}

function requireBoundedOutput(output: BoundedOutput): Buffer {
  if (!output.complete) {
    throw new Error('WSL process output exceeded its byte limit or could not be read');
  }
  return output.bytes;
}

function formatBoundedDiagnostic(output: BoundedOutput): string {
  const message = output.bytes.toString('utf8').trim();
  return [
    ...(message ? [message] : []),
    ...(!output.complete ? ['<stderr truncated or unavailable>'] : []),
  ].join('\n');
}
