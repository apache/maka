import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { lstat, mkdir, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS,
  manageChildProcessLifecycle,
} from '@maka/runtime/child-process-lifecycle';
import type { ManagedDependencyEnvironmentProducerInput } from '@maka/storage/managed-dependency-environment';

const DEFAULT_PRODUCER_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_OUTPUT_TAIL_BYTES = 1024 * 1024;
const QUOTA_MONITOR_INTERVAL_MS = 100;
export const MANAGED_NPM_PACKAGE_MANAGER_VERSION = '12.0.2';
const MANAGED_NPM_MAX_PROVISION_BYTES = 2 * 1024 * 1024 * 1024;
const MANAGED_NPM_MAX_PROVISION_ENTRIES = 250_000;

export function isManagedNpmNodeVersionSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major >= 26) return true;
  if (major === 24) return minor > 15 || (minor === 15 && patch >= 0);
  if (major === 22) return minor > 22 || (minor === 22 && patch >= 2);
  return false;
}

export interface RunManagedNpmDependencyProvisionInput {
  readonly producerInput: ManagedDependencyEnvironmentProducerInput;
  readonly nodeExecutablePath: string;
  readonly npmRuntimeRoot: string;
  readonly npmCliPath: string;
}

export async function runManagedNpmDependencyProvision(
  input: RunManagedNpmDependencyProvisionInput,
): Promise<void> {
  assertSafeNpmInputs(input.producerInput);
  const outputRoot = normalize(await realpath(input.producerInput.outputRoot));
  const scratchRoot = normalize(await realpath(input.producerInput.scratchRoot));
  const projectRoot = dirname(outputRoot);
  if (
    basename(outputRoot) !== 'node_modules' ||
    basename(scratchRoot) !== '.maka-runtime' ||
    dirname(scratchRoot) !== projectRoot
  ) {
    throw new TypeError('Managed npm producer requires one exact owned staging project');
  }
  const nodeExecutablePath = await canonicalRegularFile(
    input.nodeExecutablePath,
    'Managed npm Node runtime',
  );
  const npmRuntimeRoot = await canonicalDirectory(input.npmRuntimeRoot, 'Managed npm runtime');
  const npmCliPath = await canonicalRegularFile(input.npmCliPath, 'Managed npm CLI');
  if (!isPathWithin(npmCliPath, npmRuntimeRoot)) {
    throw new Error('Managed npm CLI escapes its verified runtime root');
  }
  const [homeRoot, npmCache, temporaryRoot, compileCacheRoot] = await Promise.all([
    createOwnedScratchDirectory(scratchRoot, 'home'),
    createOwnedScratchDirectory(scratchRoot, 'cache'),
    createOwnedScratchDirectory(scratchRoot, 'temp'),
    createOwnedScratchDirectory(scratchRoot, 'node-compile-cache'),
  ]);
  const userConfig = join(homeRoot, 'npmrc');
  const globalConfig = join(homeRoot, 'global-npmrc');
  const exactConfig = 'registry=https://registry.npmjs.org/\n';
  await Promise.all([
    writeFile(userConfig, exactConfig, { encoding: 'utf8', flag: 'wx' }),
    writeFile(globalConfig, exactConfig, { encoding: 'utf8', flag: 'wx' }),
    writeFile(join(projectRoot, 'package.json'), input.producerInput.manifestBytes, {
      flag: 'wx',
    }),
    writeFile(join(projectRoot, 'package-lock.json'), input.producerInput.lockfileBytes, {
      flag: 'wx',
    }),
  ]);
  await runManagedDependencyProducerProcess({
    argv: [
      nodeExecutablePath,
      '--permission',
      `--allow-fs-read=${npmRuntimeRoot}`,
      `--allow-fs-read=${projectRoot}`,
      `--allow-fs-write=${projectRoot}`,
      npmCliPath,
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=true',
      `--cache=${npmCache}`,
      `--userconfig=${userConfig}`,
      `--globalconfig=${globalConfig}`,
    ],
    cwd: projectRoot,
    env: hermeticNpmEnvironment(
      homeRoot,
      userConfig,
      globalConfig,
      temporaryRoot,
      compileCacheRoot,
    ),
    monitorRoot: projectRoot,
    ...(input.producerInput.abortSignal ? { abortSignal: input.producerInput.abortSignal } : {}),
    timeoutMs: DEFAULT_PRODUCER_TIMEOUT_MS,
    maxBytes: MANAGED_NPM_MAX_PROVISION_BYTES,
    maxEntries: MANAGED_NPM_MAX_PROVISION_ENTRIES,
  });
}

function assertSafeNpmInputs(input: ManagedDependencyEnvironmentProducerInput): void {
  if (
    input.identity.packageManagerName !== 'npm' ||
    input.identity.packageManagerVersion !== MANAGED_NPM_PACKAGE_MANAGER_VERSION ||
    !isManagedNpmNodeVersionSupported(input.identity.nodeVersion) ||
    input.identity.platform !== process.platform ||
    input.identity.arch !== process.arch
  ) {
    throw new Error('Managed npm producer identity mismatch');
  }
  if (
    input.manifestBytes.byteLength > 1024 * 1024 ||
    input.lockfileBytes.byteLength > 64 * 1024 * 1024
  ) {
    throw new Error('Managed npm producer input exceeds its bounded size policy');
  }
  const manifest = decodeJsonObject(input.manifestBytes, 'manifest');
  const lockfile = decodeJsonObject(input.lockfileBytes, 'lockfile');
  if (
    manifest.packageManager !== `npm@${MANAGED_NPM_PACKAGE_MANAGER_VERSION}` ||
    manifest.workspaces !== undefined ||
    lockfile.lockfileVersion !== 3 ||
    !lockfile.packages ||
    typeof lockfile.packages !== 'object' ||
    Array.isArray(lockfile.packages)
  ) {
    throw new Error('Managed npm producer accepts only exact non-workspace package-lock v3 input');
  }
  const packageEntries = Object.entries(lockfile.packages as Record<string, unknown>);
  if (packageEntries.length > 25_000) {
    throw new Error('Managed npm producer lockfile exceeds its package-count policy');
  }
  for (const [packagePath, value] of packageEntries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Managed npm producer rejected an unsafe dependency entry');
    }
    const entry = value as Record<string, unknown>;
    if (packagePath === '') continue;
    if (
      !packagePath.startsWith('node_modules/') ||
      entry.link === true ||
      entry.hasInstallScript === true ||
      typeof entry.resolved !== 'string' ||
      !entry.resolved.startsWith('https://registry.npmjs.org/') ||
      typeof entry.integrity !== 'string' ||
      !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/u.test(entry.integrity)
    ) {
      throw new Error('Managed npm producer rejected an unsafe dependency entry');
    }
  }
}

function decodeJsonObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (cause) {
    throw new Error(`Managed npm producer ${label} is invalid JSON`, { cause });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Managed npm producer ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

async function canonicalRegularFile(path: string, label: string): Promise<string> {
  const sourceInfo = await lstat(path);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) {
    throw new Error(`${label} is unavailable`);
  }
  const canonical = normalize(await realpath(path));
  const info = await lstat(canonical);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is unavailable`);
  return canonical;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  const sourceInfo = await lstat(path);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error(`${label} is unavailable`);
  }
  const canonical = normalize(await realpath(path));
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is unavailable`);
  return canonical;
}

async function createOwnedScratchDirectory(root: string, name: string): Promise<string> {
  const path = join(root, name);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Error('Managed npm scratch entry was not created by this provision', {
      cause: error,
    });
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Managed npm scratch entry is not an owned directory');
  }
  const canonical = normalize(await realpath(path));
  if (!isPathWithin(canonical, root)) {
    throw new Error('Managed npm scratch entry escapes its authority root');
  }
  return canonical;
}

function hermeticNpmEnvironment(
  homeRoot: string,
  userConfig: string,
  globalConfig: string,
  temporaryRoot: string,
  compileCacheRoot: string,
): NodeJS.ProcessEnv {
  return {
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    TMPDIR: temporaryRoot,
    NODE_COMPILE_CACHE: compileCacheRoot,
    ...(process.platform === 'win32'
      ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
      : {}),
    ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
}

export interface ManagedDependencyProducerProcessInput {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly monitorRoot: string;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes: number;
  readonly maxEntries: number;
}

export interface ManagedDependencyProducerProcessResult {
  readonly exitCode: number;
  readonly outputTail: string;
}

export type ManagedDependencyProducerProcessFailureReason =
  | 'aborted'
  | 'timeout'
  | 'filesystem_quota'
  | 'filesystem_invalid'
  | 'process_failed';

export class ManagedDependencyProducerProcessError extends Error {
  readonly name = 'ManagedDependencyProducerProcessError';

  constructor(
    readonly reason: ManagedDependencyProducerProcessFailureReason,
    message?: string,
    options?: ErrorOptions,
  ) {
    super(message ?? defaultFailureMessage(reason), options);
  }
}

export async function runManagedDependencyProducerProcess(
  input: ManagedDependencyProducerProcessInput,
): Promise<ManagedDependencyProducerProcessResult> {
  const executable = input.argv[0];
  if (!executable) throw new TypeError('Managed dependency producer argv must include a program');
  assertPositiveLimit(input.maxBytes, 'byte quota');
  assertPositiveLimit(input.maxEntries, 'entry quota');
  if (input.abortSignal?.aborted) throw new ManagedDependencyProducerProcessError('aborted');
  const cwd = normalize(await realpath(input.cwd));
  const monitorRoot = normalize(await realpath(input.monitorRoot));
  if (cwd !== monitorRoot) {
    throw new TypeError('Managed dependency producer monitor root must equal its owned cwd');
  }
  const child = spawn(executable, input.argv.slice(1), {
    cwd,
    env: input.env as NodeJS.ProcessEnv,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }) as ChildProcessByStdio<null, Readable, Readable>;
  return await observeProducerProcess(child, { ...input, cwd, monitorRoot });
}

async function observeProducerProcess(
  child: ChildProcessByStdio<null, Readable, Readable>,
  input: ManagedDependencyProducerProcessInput,
): Promise<ManagedDependencyProducerProcessResult> {
  const output = createBoundedTail(MAX_OUTPUT_TAIL_BYTES);
  child.stdout.on('data', (chunk: Buffer) => output.append(chunk));
  child.stderr.on('data', (chunk: Buffer) => output.append(chunk));
  const lifecycle = manageChildProcessLifecycle(
    child,
    [
      { key: 'stdout', stream: child.stdout },
      { key: 'stderr', stream: child.stderr },
    ],
    {
      killGraceMs: DEFAULT_KILL_GRACE_MS,
      ioDrainTimeoutMs: DEFAULT_PROCESS_IO_DRAIN_TIMEOUT_MS,
    },
  );
  let termination: ManagedDependencyProducerProcessFailureReason | undefined;
  let monitorFailure: Error | undefined;
  const terminate = (reason: ManagedDependencyProducerProcessFailureReason) => {
    if (termination) return;
    termination = reason;
    lifecycle.terminate();
  };
  const timeout = setTimeout(
    () => terminate('timeout'),
    input.timeoutMs ?? DEFAULT_PRODUCER_TIMEOUT_MS,
  );
  const abort = () => terminate('aborted');
  let quotaCheck: Promise<void> | undefined;
  const monitor = setInterval(() => {
    if (quotaCheck || termination) return;
    const current = enforceFilesystemQuota(input.monitorRoot, input.maxBytes, input.maxEntries)
      .catch((error: unknown) => {
        monitorFailure = asError(error);
        terminate(
          error instanceof ManagedDependencyProducerProcessError &&
            error.reason === 'filesystem_quota'
            ? 'filesystem_quota'
            : 'filesystem_invalid',
        );
      })
      .finally(() => {
        if (quotaCheck === current) quotaCheck = undefined;
      });
    quotaCheck = current;
  }, QUOTA_MONITOR_INTERVAL_MS);
  if (input.abortSignal?.aborted) abort();
  else input.abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    const result = await lifecycle.completion;
    clearInterval(monitor);
    await quotaCheck;
    if (!result.ioDrained) {
      throw new Error('Managed dependency producer output tree did not drain');
    }
    if (termination) {
      if (termination === 'filesystem_quota') {
        throw new ManagedDependencyProducerProcessError(
          termination,
          'Managed dependency producer exceeded its filesystem quota',
          monitorFailure ? { cause: monitorFailure } : undefined,
        );
      }
      if (termination === 'filesystem_invalid') {
        throw new ManagedDependencyProducerProcessError(
          termination,
          `Managed dependency producer output is invalid${monitorFailure ? `: ${monitorFailure.message}` : ''}`,
          monitorFailure ? { cause: monitorFailure } : undefined,
        );
      }
      throw new ManagedDependencyProducerProcessError(termination);
    }
    try {
      await enforceFilesystemQuota(input.monitorRoot, input.maxBytes, input.maxEntries);
    } catch (error) {
      if (error instanceof ManagedDependencyProducerProcessError) throw error;
      throw new ManagedDependencyProducerProcessError(
        'filesystem_invalid',
        `Managed dependency producer output is invalid: ${asError(error).message}`,
        { cause: error },
      );
    }
    const exitCode = result.exitCode ?? 1;
    if (exitCode !== 0) {
      throw new ManagedDependencyProducerProcessError(
        'process_failed',
        `Managed dependency producer failed with exit code ${exitCode}${output.text ? `: ${output.text}` : ''}`,
      );
    }
    return Object.freeze({ exitCode, outputTail: output.text });
  } finally {
    clearTimeout(timeout);
    clearInterval(monitor);
    input.abortSignal?.removeEventListener('abort', abort);
  }
}

async function enforceFilesystemQuota(
  root: string,
  maxBytes: number,
  maxEntries: number,
): Promise<void> {
  const inventory = await measureProducerTree(root);
  if (inventory.bytes > maxBytes || inventory.entries > maxEntries) {
    throw new ManagedDependencyProducerProcessError(
      'filesystem_quota',
      'Managed dependency producer exceeded its filesystem quota',
    );
  }
}

async function measureProducerTree(
  root: string,
): Promise<{ readonly bytes: number; readonly entries: number }> {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) break;
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const name of names) {
      const path = resolve(directory, name);
      let info;
      try {
        info = await lstat(path);
      } catch (error) {
        if (isMissingPathError(error)) continue;
        throw error;
      }
      entries += 1;
      if (info.isDirectory() && !info.isSymbolicLink()) {
        pending.push(path);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        bytes += info.size;
      } else if (info.isSymbolicLink() && process.platform !== 'win32') {
        const target = await readlink(path);
        if (isAbsolute(target) || !isPathWithin(resolve(dirname(path), target), root)) {
          throw new Error('Managed dependency producer created an escaping symbolic link');
        }
        bytes += Buffer.byteLength(target, 'utf8');
      } else {
        throw new Error('Managed dependency producer created an unsupported filesystem entry');
      }
      if (bytes > Number.MAX_SAFE_INTEGER || entries > Number.MAX_SAFE_INTEGER) {
        throw new Error('Managed dependency producer inventory overflowed');
      }
    }
  }
  return Object.freeze({ bytes, entries });
}

function isPathWithin(path: string, root: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function assertPositiveLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Managed dependency producer ${label} must be a positive safe integer`);
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function defaultFailureMessage(reason: ManagedDependencyProducerProcessFailureReason): string {
  switch (reason) {
    case 'aborted':
      return 'Managed dependency producer process was aborted';
    case 'timeout':
      return 'Managed dependency producer process timed out';
    case 'filesystem_quota':
      return 'Managed dependency producer exceeded its filesystem quota';
    case 'filesystem_invalid':
      return 'Managed dependency producer output is invalid';
    case 'process_failed':
      return 'Managed dependency producer process failed';
  }
}

function createBoundedTail(maxBytes: number) {
  let tail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return {
    append(chunk: Buffer) {
      tail = appendBoundedTail(tail, chunk, maxBytes);
    },
    get text() {
      return tail.toString('utf8').trim();
    },
  };
}

function appendBoundedTail(current: Buffer, chunk: Buffer, limit: number): Buffer {
  if (chunk.length >= limit) return Buffer.from(chunk.subarray(chunk.length - limit));
  if (current.length + chunk.length <= limit) return Buffer.concat([current, chunk]);
  return Buffer.concat([current.subarray(current.length - (limit - chunk.length)), chunk]);
}
