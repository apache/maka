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
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import {
  normalizeRuntimeHostWslDistribution,
  resolveSystemRuntimeHostWslExecutable,
  type RuntimeHostWslProcessFactory,
} from '@maka/runtime-host/client';
import {
  decodeRuntimeHostSetupFrame,
  RUNTIME_HOST_SETUP_FRAME_PREFIX,
  RUNTIME_HOST_SETUP_SOURCE_PACKAGE_INTEGRITY_ENV,
  type RuntimeHostSetupFrame,
  type RuntimeHostSetupPhase,
} from '@maka/runtime-host/operator';
import { createRuntimeHostFramedOutputFilter } from './runtime-host-framed-output.js';
import {
  isExactRuntimeHostSetupPackageSpecifier,
  type DesktopRuntimeHostSetupPackage,
} from './runtime-host-ssh-terminal.js';

const WSL_SETUP_TIMEOUT_MS = 10 * 60_000;
const WSL_SETUP_OUTPUT_MAX_BYTES = 64 * 1024;
const WSL_SETUP_STDERR_MAX_BYTES = 8 * 1024;

type RuntimeHostSetupCompleteFrame = Extract<RuntimeHostSetupFrame, { kind: 'complete' }>;

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
): Promise<RuntimeHostSetupCompleteFrame> {
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
  const abort = () => child.kill();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  child.stdin.end();
  let complete: RuntimeHostSetupCompleteFrame | undefined;
  let failure: Error | undefined;
  const filter = createRuntimeHostFramedOutputFilter({
    prefix: RUNTIME_HOST_SETUP_FRAME_PREFIX,
    pendingMaxBytes: WSL_SETUP_OUTPUT_MAX_BYTES,
    decode: decodeRuntimeHostSetupFrame,
    label: 'WSL Maka setup',
    onFrame: (frame) => {
      if (frame.kind === 'progress') onProgress(frame);
      else if (frame.kind === 'complete') {
        if (complete) failure = new Error('WSL Maka setup returned multiple results');
        else {
          complete = frame;
          onComplete?.();
        }
      } else failure = new Error(frame.error.message);
    },
    onError: (error) => {
      failure = error;
    },
  });
  let outputBytes = 0;
  child.stdout.on('data', (value: Buffer | string) => {
    const chunk = typeof value === 'string' ? Buffer.from(value) : value;
    outputBytes += chunk.byteLength;
    if (outputBytes > WSL_SETUP_OUTPUT_MAX_BYTES) {
      failure = new Error('WSL Maka setup output exceeded its byte limit');
      child.kill();
      return;
    }
    filter.push(chunk.toString('utf8'));
  });
  const stderr = collectBounded(child.stderr, WSL_SETUP_STDERR_MAX_BYTES);
  const timeout = setTimeout(() => child.kill(), WSL_SETUP_TIMEOUT_MS);
  const exit = await childExit(child).finally(() => {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  });
  filter.finish();
  input.signal?.throwIfAborted();
  if (failure) throw failure;
  if (!complete) {
    const diagnostic = (await stderr).toString('utf8').trim();
    throw new Error(
      `WSL Maka setup exited with code ${String(exit.code)} without a result${diagnostic ? `: ${diagnostic}` : ''}`,
    );
  }
  return complete;
}

async function resolveWslPackageSpecifier(
  setupPackage: DesktopRuntimeHostSetupPackage,
  distribution: string,
  executable: string,
  processFactory: RuntimeHostWslProcessFactory,
): Promise<{ readonly specifier: string; readonly integrity?: string }> {
  if (setupPackage.kind === 'npm') {
    if (!isExactRuntimeHostSetupPackageSpecifier(setupPackage.specifier)) {
      throw new Error('Runtime Host setup package is invalid');
    }
    return { specifier: setupPackage.specifier };
  }
  const archive = await realpath(setupPackage.path);
  if (!(await stat(archive)).isFile() || !archive.endsWith('.tgz')) {
    throw new Error('Runtime Host development package must be a .tgz file');
  }
  const child = processFactory(executable, ['--distribution', distribution, '--exec', 'wslpath', '-a', '-u', archive]);
  child.stdin.end();
  const stdout = collectBounded(child.stdout, 4 * 1024);
  const stderr = collectBounded(child.stderr, WSL_SETUP_STDERR_MAX_BYTES);
  const exit = await childExit(child);
  const path = (await stdout).toString('utf8').trim();
  if (exit.code !== 0 || !path.startsWith('/')) {
    const diagnostic = (await stderr).toString('utf8').trim();
    throw new Error(`WSL could not resolve the setup package path${diagnostic ? `: ${diagnostic}` : ''}`);
  }
  return { specifier: path, integrity: await sha512Integrity(archive) };
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

function sha512Integrity(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolve(`sha512-${hash.digest('base64')}`));
  });
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

function childExit(child: ChildProcessWithoutNullStreams): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function collectBounded(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on('data', (value: Buffer | string) => {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      bytes += chunk.byteLength;
      if (bytes > maxBytes) {
        reject(new Error('WSL process output exceeded its byte limit'));
        return;
      }
      chunks.push(chunk);
    });
    stream.once('end', () => resolve(Buffer.concat(chunks)));
    stream.once('error', reject);
  });
}
