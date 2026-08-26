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

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from '@maka/runtime/process-tree-terminator';
import {
  isExactRuntimeHostSetupPackageSpecifier,
  type DesktopRuntimeHostSetupPackage,
} from './runtime-host-ssh-terminal.js';

const DEVELOPMENT_ARCHIVE_ENV = 'MAKA_RUNTIME_HOST_SETUP_ARCHIVE';

interface DevelopmentArchiveBuild {
  readonly result: Promise<string>;
  close(): Promise<void>;
}

export interface RuntimeHostSetupPackageResolver {
  resolve(signal?: AbortSignal): Promise<DesktopRuntimeHostSetupPackage>;
  close(): Promise<void>;
}

export function createRuntimeHostSetupPackageResolver(input: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly startDevelopmentArchiveBuild?: (repoRoot: string) => DevelopmentArchiveBuild;
}): RuntimeHostSetupPackageResolver {
  let closed = false;
  let developmentBuild:
    | {
        readonly task: DevelopmentArchiveBuild;
        readonly result: Promise<DesktopRuntimeHostSetupPackage>;
        waiters: number;
        settled: boolean;
        closing?: Promise<void>;
      }
    | undefined;

  const startBuild = () => {
    const repoRoot = resolve(input.appPath, '..', '..');
    const task = input.startDevelopmentArchiveBuild?.(repoRoot) ??
      startDevelopmentArchiveBuild(repoRoot, input.environment);
    const build = {
      task,
      result: task.result.then((path) => ({
        kind: 'development_archive' as const,
        path,
      })),
      waiters: 0,
      settled: false,
    };
    developmentBuild = build;
    void build.result.then(
      () => {
        build.settled = true;
      },
      () => {
        build.settled = true;
        if (developmentBuild === build) developmentBuild = undefined;
      },
    );
    return build;
  };

  const stopBuild = async (build: NonNullable<typeof developmentBuild>) => {
    build.closing ??= build.task.close().finally(() => {
      if (developmentBuild === build) developmentBuild = undefined;
    });
    await build.closing;
    await build.result.catch(() => undefined);
  };

  const acquireBuild = async (signal?: AbortSignal) => {
    while (true) {
      if (closed) throw new Error('Runtime Host setup package resolver is closed');
      const build = developmentBuild;
      if (!build) return startBuild();
      if (!build.closing) return build;
      await waitForPackage(build.closing, signal);
    }
  };

  return {
    async resolve(signal) {
      if (closed) throw new Error('Runtime Host setup package resolver is closed');
      if (input.isPackaged) return packagedSetupPackage(input.appPath);

      const override = input.environment[DEVELOPMENT_ARCHIVE_ENV];
      if (override) return { kind: 'development_archive', path: override };

      const build = await acquireBuild(signal);
      build.waiters += 1;
      try {
        return await waitForPackage(build.result, signal);
      } finally {
        build.waiters -= 1;
        if (signal?.aborted && build.waiters === 0 && !build.settled) {
          await stopBuild(build);
        }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const build = developmentBuild;
      developmentBuild = undefined;
      if (build) await stopBuild(build);
    },
  };
}

function packagedSetupPackage(appPath: string): DesktopRuntimeHostSetupPackage {
  const manifest = JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')) as {
    runtimeHostSetupPackage?: unknown;
  };
  if (!isExactRuntimeHostSetupPackageSpecifier(manifest.runtimeHostSetupPackage)) {
    throw new Error('Desktop does not declare an exact Runtime Host setup package');
  }
  return { kind: 'npm', specifier: manifest.runtimeHostSetupPackage };
}

function startDevelopmentArchiveBuild(
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): DevelopmentArchiveBuild {
  const script = join(repoRoot, 'scripts', 'release-cli-package.mjs');
  const nodeExecutable = environment.npm_node_execpath?.trim() || 'node';
  const outputBase = join(repoRoot, 'packages', 'cli', '.development');
  mkdirSync(outputBase, { recursive: true, mode: 0o755 });
  const outputRoot = mkdtempSync(join(outputBase, 'desktop-'));
  const child = spawn(nodeExecutable, [script, '--development'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: { ...environment, MAKA_CLI_DEVELOPMENT_OUTPUT_ROOT: outputRoot },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let settled = false;
  let stdout = '';
  let stderr = '';
  let processError: Error | undefined;
  const appendOutput = (current: string, chunk: Buffer): string => {
    const next = current + chunk.toString('utf8');
    if (Buffer.byteLength(next, 'utf8') <= 64 * 1024 * 1024) return next;
    processError = new Error('Local Runtime Host CLI build output exceeded 64 MiB');
    void terminateChildProcessTree(child, 'SIGKILL');
    return current;
  };
  const output = new Promise<string>((resolveOutput, reject) => {
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendOutput(stdout, chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendOutput(stderr, chunk);
    });
    child.once('error', (error) => {
      processError = error;
    });
    child.once('close', (code, signal) => {
      settled = true;
      if (code === 0 && !processError) {
        resolveOutput(stdout);
        return;
      }
      const detail = (
        stderr.trim() ||
        processError?.message ||
        `process exited with ${code === null ? signal ?? 'an unknown status' : `code ${code}`}`
      ).slice(-2_000);
      reject(new Error(`Failed to prepare the local Runtime Host CLI: ${detail}`));
    });
  });
  const result = output.then((stdout) => {
    const archive = Array.from(stdout.matchAll(/^\[release-cli\] tarball: (.+)$/gmu)).at(-1)?.[1];
    if (!archive) throw new Error('The local Runtime Host CLI build did not report an archive');
    const resolvedArchive = resolve(archive.trim());
    const relativeArchive = relative(outputRoot, resolvedArchive);
    if (
      !relativeArchive ||
      relativeArchive.startsWith('..') ||
      isAbsolute(relativeArchive) ||
      !resolvedArchive.endsWith('.tgz') ||
      !existsSync(resolvedArchive)
    ) {
      throw new Error('The local Runtime Host CLI build returned an invalid archive path');
    }
    return resolvedArchive;
  });
  void result.catch(() => rmSync(outputRoot, { recursive: true, force: true }));
  let closing: Promise<void> | undefined;
  return {
    result,
    close() {
      closing ??= (async () => {
        try {
          if (!settled) await terminateBuildProcess(child, result);
        } finally {
          rmSync(outputRoot, { recursive: true, force: true });
        }
      })();
      return closing;
    },
  };
}

function waitForPackage<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolvePackage, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(resolvePackage, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    });
  });
}

async function terminateBuildProcess(child: ChildProcess, result: Promise<unknown>): Promise<void> {
  await terminateChildProcessTree(child, 'SIGTERM');
  if (await settlesWithin(result, DEFAULT_PROCESS_TERMINATION_GRACE_MS)) return;
  await terminateChildProcessTree(child, 'SIGKILL');
  if (!(await settlesWithin(result, DEFAULT_PROCESS_TERMINATION_GRACE_MS))) {
    throw new Error('Local Runtime Host CLI build did not exit after forced termination');
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
