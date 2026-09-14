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

import { cp, lstat, mkdir, opendir, readlink, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { redactSecrets } from '@maka/core/redaction';
import {
  runProducerProcess,
  type ProducerProcessInput,
  type ProducerProcessResult,
} from './managed-dependency-process.js';

export interface ManagedDependencyProducerInput {
  readonly nodeExecutablePath: string;
  readonly npmCliPath: string;
  readonly supervisorPath: string;
  /** Existing, exclusively owned staging directory. Never a user's project. */
  readonly projectRoot: string;
  /** Optional prefilled offline npm cache; copied into owned scratch before use. */
  readonly cacheSeedRoot?: string;
  readonly manifestBytes: Uint8Array;
  readonly lockfileBytes: Uint8Array;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxEntries?: number;
}

export type ManagedDependencyProducerResult =
  | { readonly kind: 'completed'; readonly exitCode: 0 }
  | {
      readonly kind: 'failed';
      readonly reason: ProducerFailure;
      readonly exitCode: number | null;
      readonly diagnostic: string;
    }
  | { readonly kind: 'unsettled'; readonly reason: 'supervision'; readonly diagnostic: string };

type ProducerFailure = 'unsupported' | 'input' | 'cancelled' | 'timeout' | 'quota' | 'process';
export interface ProducerLimits {
  readonly maxBytes: number;
  readonly maxEntries: number;
}

/**
 * Offline producer foundation. It does not attest a shipped runtime or mint a
 * ManagedDependencyEnvironmentProducer capability. An unsettled result must NOT
 * be translated into provision() rejection: Storage would delete its staging.
 */
export async function runManagedDependencyProducer(
  input: ManagedDependencyProducerInput,
  launch: (input: ProducerProcessInput) => Promise<ProducerProcessResult> = runProducerProcess,
): Promise<ManagedDependencyProducerResult> {
  if (process.platform !== 'win32' && process.platform !== 'linux') return failed('unsupported');
  if (input.abortSignal?.aborted) return failed('cancelled');
  const limits = {
    maxBytes: input.maxBytes ?? 2 * 1024 ** 3,
    maxEntries: input.maxEntries ?? 250_000,
  };
  const timeoutMs = input.timeoutMs ?? 600_000;
  if (
    ![limits.maxBytes, limits.maxEntries, timeoutMs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    timeoutMs > 600_000
  ) {
    return failed('input');
  }
  let environment: Record<string, string>;
  try {
    validateNpmInput(input);
    for (const file of [input.nodeExecutablePath, input.npmCliPath, input.supervisorPath]) {
      if (!isAbsolute(file) || !(await lstat(file)).isFile())
        throw new Error('Expected an absolute regular executable path');
    }
    await requireDirectory(input.projectRoot);
    const scratchRoot = join(input.projectRoot, '.maka-runtime');
    await mkdir(scratchRoot, { recursive: true });
    await requireDirectory(scratchRoot);
    // Exclusive reservation prevents concurrent callers or retries from sharing
    // writable npm state, even when Storage has already created scratchRoot.
    const ownedRoot = join(scratchRoot, 'provision');
    await mkdir(ownedRoot);
    const home = join(ownedRoot, 'home');
    const cache = join(ownedRoot, 'cache');
    const temporary = join(ownedRoot, 'tmp');
    await Promise.all([mkdir(home), mkdir(temporary)]);
    if (input.cacheSeedRoot) {
      await requireDirectory(input.cacheSeedRoot);
      if (
        within(input.projectRoot, input.cacheSeedRoot) ||
        within(input.cacheSeedRoot, input.projectRoot)
      )
        throw new Error('Cache seed overlaps staging');
      // Treat the cache as immutable input. The final scan includes its copied
      // bytes; this is a detection quota, not a filesystem reservation.
      await measureProducerTree(input.cacheSeedRoot, limits, true);
      await cp(input.cacheSeedRoot, cache, {
        recursive: true,
        dereference: false,
        errorOnExist: true,
        force: false,
      });
    } else {
      await mkdir(cache);
    }
    const config = join(home, 'npmrc');
    const globalConfig = join(home, 'global-npmrc');
    await Promise.all([
      writeFile(config, 'offline=true\nignore-scripts=true\naudit=false\nfund=false\n', {
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 }),
      writeFile(join(input.projectRoot, 'package.json'), input.manifestBytes, {
        flag: 'wx',
        mode: 0o600,
      }),
      writeFile(join(input.projectRoot, 'package-lock.json'), input.lockfileBytes, {
        flag: 'wx',
        mode: 0o600,
      }),
    ]);
    environment = {
      HOME: home,
      // libuv's Windows homedir lookup has a fixed-size buffer. Resolve this
      // short private profile against the explicitly fixed staging cwd; all
      // npm config/cache paths remain absolute and independent of user state.
      USERPROFILE: process.platform === 'win32' ? '.maka-runtime/provision/home' : home,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      npm_config_cache: cache,
      npm_config_userconfig: config,
      npm_config_globalconfig: globalConfig,
      npm_config_offline: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      npm_config_update_notifier: 'false',
      NODE_DISABLE_COMPILE_CACHE: '1',
      ...(process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {}),
    };
    await measureProducerTree(input.projectRoot, limits);
  } catch (error) {
    return {
      ...failed(error instanceof ProducerQuotaError ? 'quota' : 'input'),
      diagnostic: redactSecrets(
        error instanceof Error ? error.message : 'Preparation failed',
      ).slice(0, 4096),
    };
  }
  if (input.abortSignal?.aborted) return failed('cancelled');
  const abort = new AbortController();
  let failure: ProducerFailure | undefined;
  const stop = (reason: ProducerFailure) => {
    failure ??= reason;
    abort.abort();
  };
  const cancel = () => stop('cancelled');
  input.abortSignal?.addEventListener('abort', cancel, { once: true });
  if (input.abortSignal?.aborted) cancel();
  const timeout = setTimeout(() => stop('timeout'), timeoutMs);
  let monitoring = true;
  let scan: Promise<void> = Promise.resolve();
  let monitorTimer: ReturnType<typeof setTimeout> | undefined;
  const monitor = () => {
    scan = measureProducerTree(input.projectRoot, limits)
      .then(
        () => {},
        (error: unknown) => {
          stop(error instanceof ProducerQuotaError ? 'quota' : 'input');
        },
      )
      .finally(() => {
        if (monitoring && !abort.signal.aborted) monitorTimer = setTimeout(monitor, 250);
      });
  };
  monitorTimer = setTimeout(monitor, 250);
  const chunks: Buffer[] = [];
  let outputBytes = 0;
  let outputTruncated = false;
  let result: ProducerProcessResult;
  try {
    result = await launch({
      executable: input.nodeExecutablePath,
      arguments: [
        ...(process.platform === 'win32'
          ? ['--preserve-symlinks-main', '--preserve-symlinks']
          : []),
        input.npmCliPath,
        'ci',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      projectRoot: input.projectRoot,
      readRoots: [dirname(dirname(input.npmCliPath))],
      environment,
      supervisorPath: input.supervisorPath,
      signal: abort.signal,
      timeoutMs,
      onOutput: (chunk) => {
        const accepted = chunk.subarray(0, Math.max(0, 64 * 1024 - outputBytes));
        if (accepted.length < chunk.length) outputTruncated = true;
        if (accepted.length) {
          chunks.push(Buffer.from(accepted));
          outputBytes += accepted.length;
        }
      },
    });
  } catch {
    // A rejected launch adapter cannot attest that it failed before spawning.
    result = { settled: false };
  } finally {
    monitoring = false;
    if (monitorTimer) clearTimeout(monitorTimer);
    clearTimeout(timeout);
    input.abortSignal?.removeEventListener('abort', cancel);
    await scan;
  }
  let retained = Buffer.concat(chunks).toString('utf8');
  // Do not feed a partial secret at the retention boundary to the redactor.
  if (outputTruncated) retained = retained.slice(0, Math.max(0, retained.lastIndexOf('\n')));
  const diagnostic = redactSecrets(retained).slice(0, 4096);
  if (!result.settled) return { kind: 'unsettled', reason: 'supervision', diagnostic };
  {
    try {
      await measureProducerTree(input.projectRoot, limits);
    } catch (error) {
      failure ??= error instanceof ProducerQuotaError ? 'quota' : 'input';
    }
  }
  if (failure || result.failed)
    return { kind: 'failed', reason: failure ?? 'process', exitCode: result.exitCode, diagnostic };
  return { kind: 'completed', exitCode: 0 };
}

function failed(
  reason: ProducerFailure,
): Extract<ManagedDependencyProducerResult, { kind: 'failed' }> {
  return { kind: 'failed', reason, exitCode: null, diagnostic: '' };
}

function validateNpmInput(input: ManagedDependencyProducerInput): void {
  if (input.manifestBytes.length > 1024 ** 2 || input.lockfileBytes.length > 64 * 1024 ** 2)
    throw new Error('Input too large');
  // SyntaxError messages may quote raw input; never copy those bytes into a
  // diagnostic, even through the secret redactor.
  const parse = (bytes: Uint8Array) => {
    try {
      return JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch {
      throw new Error('Malformed dependency JSON');
    }
  };
  const manifest = parse(input.manifestBytes);
  const lock = parse(input.lockfileBytes);
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.workspaces !== undefined ||
    !lock ||
    lock.lockfileVersion !== 3 ||
    !lock.packages ||
    typeof lock.packages !== 'object' ||
    Array.isArray(lock.packages)
  )
    throw new Error('Expected non-workspace package-lock v3');
  const entries = Object.entries(lock.packages);
  if (entries.length > 25_000) throw new Error('Too many packages');
  for (const [path, value] of entries) {
    if (path === '') continue;
    const entry = value as { resolved?: unknown; integrity?: unknown; link?: unknown } | null;
    if (
      !path.startsWith('node_modules/') ||
      path.split('/').some((part) => part === '..' || part === '.') ||
      path.includes('\\') ||
      !entry ||
      typeof entry !== 'object' ||
      entry.link ||
      typeof entry.resolved !== 'string' ||
      typeof entry.integrity !== 'string' ||
      !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/u.test(entry.integrity)
    )
      throw new Error('Unsupported dependency');
    const url = new URL(entry.resolved);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'registry.npmjs.org' ||
      url.port ||
      url.username ||
      url.password
    )
      throw new Error('Unsupported dependency source');
  }
}

export class ProducerQuotaError extends Error {}

/** Logical byte/entry detection, including scratch. Never follows a symlink. */
export async function measureProducerTree(
  root: string,
  limits: ProducerLimits,
  rejectLinks = false,
): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  const pending = [root];
  while (pending.length) {
    const path = pending.pop()!;
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    entries += 1;
    if (info.isSymbolicLink()) {
      if (process.platform === 'win32' || rejectLinks)
        throw new Error('Unsupported reparse point or cache link');
      try {
        bytes += Buffer.byteLength(await readlink(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else if (info.isFile()) bytes += info.size;
    else if (info.isDirectory()) {
      try {
        const directory = await opendir(path);
        for await (const child of directory) {
          // Bound inventory memory as well as the count of processed entries.
          if (entries + pending.length >= limits.maxEntries)
            throw new ProducerQuotaError('Entry quota exceeded');
          pending.push(join(path, child.name));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    } else throw new Error('Unsupported filesystem entry');
    if (bytes > limits.maxBytes || entries > limits.maxEntries)
      throw new ProducerQuotaError('Producer quota exceeded');
  }
  return { bytes, entries };
}

async function requireDirectory(path: string): Promise<void> {
  const canonical = await realpath(path);
  const matches =
    process.platform === 'win32'
      ? canonical.toLowerCase() === path.toLowerCase()
      : canonical === path;
  if (
    !isAbsolute(path) ||
    !(await lstat(path)).isDirectory() ||
    (await lstat(path)).isSymbolicLink() ||
    !matches
  )
    throw new Error('Expected canonical owned directory');
}

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
