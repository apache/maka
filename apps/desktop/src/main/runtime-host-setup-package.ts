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
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { copyFile, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  DEFAULT_PROCESS_TERMINATION_GRACE_MS,
  terminateChildProcessTree,
} from '@maka/runtime/process-tree-terminator';
const DEVELOPMENT_ARCHIVE_ENV = 'MAKA_RUNTIME_HOST_SETUP_ARCHIVE';

export type DesktopRuntimeHostSetupPackage =
  | { readonly kind: 'npm'; readonly specifier: string }
  | {
      readonly kind: 'development_archive';
      readonly path: string;
      readonly integrity: string;
    };

function isExactRuntimeHostSetupPackageSpecifier(value: unknown): value is string {
  return typeof value === 'string' && /^maka-agent@[0-9][0-9A-Za-z.+-]*$/u.test(value);
}

interface DevelopmentArchiveBuild {
  readonly result: Promise<string>;
  close(): Promise<void>;
}

interface DevelopmentBuildState {
  readonly task: DevelopmentArchiveBuild;
  readonly result: Promise<DesktopRuntimeHostSetupPackage>;
  waiters: number;
  settled: boolean;
  closing?: Promise<void>;
}

export type DesktopRuntimeHostDevelopmentPeerTarget =
  | 'none'
  | 'darwin-arm64'
  | 'linux-arm64'
  | 'linux-x64'
  | 'win32-x64';

export interface RuntimeHostSetupPackageResolver {
  readonly mode: 'published' | 'development';
  resolve(
    peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
    signal?: AbortSignal,
  ): Promise<DesktopRuntimeHostSetupPackage>;
  close(): Promise<void>;
}

export function desktopRuntimeHostDevelopmentPeerTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): Exclude<DesktopRuntimeHostDevelopmentPeerTarget, 'none'> {
  const target = `${platform}-${arch}`;
  if (
    target !== 'darwin-arm64' &&
    target !== 'linux-arm64' &&
    target !== 'linux-x64' &&
    target !== 'win32-x64'
  ) {
    throw new Error(`Direct peer is not available on ${target}`);
  }
  return target;
}

export function createRuntimeHostSetupPackageResolver(input: {
  readonly isPackaged: boolean;
  readonly appPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly startDevelopmentArchiveBuild?: (
    repoRoot: string,
    peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
  ) => DevelopmentArchiveBuild;
}): RuntimeHostSetupPackageResolver {
  let closed = false;
  const developmentBuilds = new Map<
    DesktopRuntimeHostDevelopmentPeerTarget,
    DevelopmentBuildState
  >();
  let overrideSnapshot: ReturnType<typeof snapshotDevelopmentSetupPackage> | undefined;

  const resolveOverrideSnapshot = (path: string) => {
    overrideSnapshot ??= snapshotDevelopmentSetupPackage(path).catch((error: unknown) => {
      overrideSnapshot = undefined;
      throw error;
    });
    return overrideSnapshot;
  };

  const startBuild = (
    peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
  ): DevelopmentBuildState => {
    const repoRoot = resolve(input.appPath, '..', '..');
    const task = input.startDevelopmentArchiveBuild?.(repoRoot, peerTarget) ??
      startDevelopmentArchiveBuild(repoRoot, input.environment, peerTarget);
    const build: DevelopmentBuildState = {
      task,
      result: task.result.then(developmentSetupPackage),
      waiters: 0,
      settled: false,
    };
    developmentBuilds.set(peerTarget, build);
    void build.result.then(
      () => {
        build.settled = true;
      },
      () => {
        build.settled = true;
        if (developmentBuilds.get(peerTarget) === build) {
          developmentBuilds.delete(peerTarget);
        }
        void stopBuild(peerTarget, build).catch(() => undefined);
      },
    );
    return build;
  };

  const stopBuild = async (
    peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
    build: DevelopmentBuildState,
  ) => {
    build.closing ??= build.task.close().finally(() => {
      if (developmentBuilds.get(peerTarget) === build) developmentBuilds.delete(peerTarget);
    });
    await build.closing;
    await build.result.catch(() => undefined);
  };

  const acquireBuild = async (
    peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
    signal?: AbortSignal,
  ) => {
    while (true) {
      if (closed) throw new Error('Runtime Host setup package resolver is closed');
      const build = developmentBuilds.get(peerTarget);
      if (!build) return startBuild(peerTarget);
      if (!build.closing) return build;
      await waitForPackage(build.closing, signal);
    }
  };

  return {
    mode: input.isPackaged ? 'published' : 'development',
    async resolve(peerTarget, signal) {
      if (closed) throw new Error('Runtime Host setup package resolver is closed');
      if (input.isPackaged) return packagedSetupPackage(input.appPath);

      const override = input.environment[DEVELOPMENT_ARCHIVE_ENV];
      if (override) {
        const snapshot = await waitForPackage(resolveOverrideSnapshot(override), signal);
        return snapshot.setupPackage;
      }

      const build = await acquireBuild(peerTarget, signal);
      build.waiters += 1;
      try {
        return await waitForPackage(build.result, signal);
      } finally {
        build.waiters -= 1;
        if (signal?.aborted && build.waiters === 0 && !build.settled) {
          await stopBuild(peerTarget, build);
        }
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const builds = [...developmentBuilds.entries()];
      developmentBuilds.clear();
      await Promise.all(builds.map(([peerTarget, build]) => stopBuild(peerTarget, build)));
      const snapshot = await overrideSnapshot?.catch(() => undefined);
      if (snapshot) await rm(snapshot.root, { recursive: true, force: true });
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
  peerTarget: DesktopRuntimeHostDevelopmentPeerTarget,
): DevelopmentArchiveBuild {
  const script = join(repoRoot, 'scripts', 'release-cli-package.mjs');
  const nodeExecutable = environment.npm_node_execpath?.trim() || 'node';
  const outputBase = join(repoRoot, 'packages', 'cli', '.development');
  mkdirSync(outputBase, { recursive: true, mode: 0o755 });
  const outputRoot = mkdtempSync(join(outputBase, 'desktop-'));
  const child = spawn(nodeExecutable, [script, '--development'], {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: {
      ...environment,
      MAKA_CLI_DEVELOPMENT_OUTPUT_ROOT: outputRoot,
      MAKA_CLI_DEVELOPMENT_PEER_TARGET: peerTarget,
    },
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

async function developmentSetupPackage(path: string): Promise<DesktopRuntimeHostSetupPackage> {
  const archive = await realpath(path);
  if (!(await stat(archive)).isFile() || !archive.endsWith('.tgz')) {
    throw new Error('Runtime Host development package must be a .tgz file');
  }
  return {
    kind: 'development_archive',
    path: archive,
    integrity: await sha512Integrity(archive),
  };
}

async function snapshotDevelopmentSetupPackage(path: string): Promise<{
  readonly root: string;
  readonly setupPackage: DesktopRuntimeHostSetupPackage;
}> {
  const source = await realpath(path);
  if (!(await stat(source)).isFile() || !source.endsWith('.tgz')) {
    throw new Error('Runtime Host development package must be a .tgz file');
  }
  const root = await mkdtemp(join(tmpdir(), 'maka-runtime-host-setup-override-'));
  const snapshot = join(root, 'package.tgz');
  try {
    await copyFile(source, snapshot);
    return { root, setupPackage: await developmentSetupPackage(snapshot) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function sha512Integrity(path: string): Promise<string> {
  return new Promise((resolveIntegrity, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => resolveIntegrity(`sha512-${hash.digest('base64')}`));
  });
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
