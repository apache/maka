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
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeHostInstallationOwner } from '@maka/runtime-host/operator';
import { isProductReleaseVersion } from '@maka/runtime-host/operator/update-package-evidence';

const PACKAGE_NAME = 'maka-agent';
const MANIFEST_MAX_BYTES = 64 * 1024;
const NPM_OUTPUT_MAX_BYTES = 64 * 1024;
const NPM_TIMEOUT_MS = 15_000;

export class RuntimeHostCliInstallationError extends Error {
  constructor(
    readonly code: 'invalid_installation' | 'unsupported_installation' | 'npm_unavailable',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostCliInstallationError';
  }
}

export interface RuntimeHostNpmGlobalInstallation {
  readonly owner: RuntimeHostInstallationOwner & { readonly kind: 'cli' };
  /** Mutable local observation, not verified npm artifact identity. */
  readonly observedRelease: {
    readonly version: string;
    readonly packageRoot: string;
    readonly cliPath: string;
  };
}

interface RuntimeHostCliInstallationDeps {
  readonly resolveGlobalNodeModulesRoot: () => Promise<string>;
}

/**
 * Resolves the stable installation slot separately from the mutable package
 * currently occupying it. Exact deployment integrity must come from a staged,
 * verified registry artifact rather than this observation.
 */
export async function resolveRuntimeHostNpmGlobalInstallation(
  options: {
    readonly manifestUrl?: URL;
    readonly cliPath?: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly homeDir?: string;
  } = {},
  overrides: Partial<RuntimeHostCliInstallationDeps> = {},
): Promise<RuntimeHostNpmGlobalInstallation> {
  const manifestUrl = options.manifestUrl ?? new URL('../package.json', import.meta.url);
  const homeDir = options.homeDir ?? homedir();
  const environment = options.environment ?? process.env;
  let packageRoot: string;
  try {
    packageRoot = await realpath(fileURLToPath(new URL('.', manifestUrl)));
  } catch (cause) {
    throw invalidInstallation('The Maka CLI package root is unavailable', cause);
  }
  if (await isTemporaryNpxInstallation(packageRoot, { environment, homeDir })) {
    throw new RuntimeHostCliInstallationError(
      'unsupported_installation',
      'A temporary npx package is not a persistent Runtime Host installation owner',
    );
  }
  const manifest = await readPackageManifest(manifestUrl);
  if (manifest.private === true) {
    throw new RuntimeHostCliInstallationError(
      'unsupported_installation',
      'A development checkout is not a persistent npm CLI installation',
    );
  }
  const cliPath = await canonicalCliPath(
    options.cliPath ?? join(packageRoot, 'dist', 'cli.js'),
    packageRoot,
  );
  const globalRoot = await canonicalGlobalRoot(
    await (overrides.resolveGlobalNodeModulesRoot ?? runNpmGlobalRoot)(),
  );
  if (packageRoot !== join(globalRoot, PACKAGE_NAME)) {
    throw new RuntimeHostCliInstallationError(
      'unsupported_installation',
      'The current Maka CLI is not installed in the active npm global prefix',
    );
  }
  return {
    owner: {
      kind: 'cli',
      installationId: `npm-global:${createHash('sha256')
        .update(globalRoot)
        .update('\0')
        .update(PACKAGE_NAME)
        .digest('hex')}`,
    },
    observedRelease: { version: manifest.version, packageRoot, cliPath },
  };
}

export async function isTemporaryNpxInstallation(
  path: string,
  input: {
    readonly environment: NodeJS.ProcessEnv;
    readonly homeDir: string;
  },
): Promise<boolean> {
  const canonicalPath = await realpath(path).catch(() => resolve(path));
  const cacheRoots = await Promise.all(
    [input.environment.npm_config_cache, join(input.homeDir, '.npm')].flatMap((root) =>
      root ? [realpath(resolve(root, '_npx')).catch(() => resolve(root, '_npx'))] : [],
    ),
  );
  return cacheRoots.some((root) => isWithin(root, canonicalPath));
}

async function readPackageManifest(url: URL): Promise<{
  readonly version: string;
  readonly private?: true;
}> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(
      url,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (cause) {
    throw invalidInstallation('The Maka CLI package manifest is unavailable', cause);
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MANIFEST_MAX_BYTES) throw new Error('Invalid size');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedManifest(handle)),
    );
    if (
      !isRecord(value) ||
      value.name !== PACKAGE_NAME ||
      typeof value.version !== 'string' ||
      !isProductReleaseVersion(value.version) ||
      (value.private !== undefined && typeof value.private !== 'boolean')
    ) {
      throw new Error('Invalid package manifest');
    }
    return { version: value.version, ...(value.private === true ? { private: true } : {}) };
  } catch (cause) {
    throw invalidInstallation('The Maka CLI package manifest is invalid', cause);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBoundedManifest(handle: Awaited<ReturnType<typeof open>>): Promise<Uint8Array> {
  const bytes = Buffer.allocUnsafe(MANIFEST_MAX_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MANIFEST_MAX_BYTES) throw new Error('Manifest exceeds the byte limit');
  return bytes.subarray(0, offset);
}

async function canonicalCliPath(path: string, packageRoot: string): Promise<string> {
  try {
    const canonical = await realpath(path);
    if (dirname(dirname(canonical)) !== packageRoot || !(await stat(canonical)).isFile()) {
      throw new Error('Invalid CLI entry point');
    }
    return canonical;
  } catch (cause) {
    throw invalidInstallation('The Maka CLI entry point does not belong to its package', cause);
  }
}

async function canonicalGlobalRoot(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw invalidInstallation('npm returned a relative global package root');
  }
  try {
    const canonical = await realpath(resolve(path));
    if (!(await stat(canonical)).isDirectory()) throw new Error('Not a directory');
    return canonical;
  } catch (cause) {
    throw invalidInstallation('The npm global package root is unavailable', cause);
  }
}

function runNpmGlobalRoot(): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('npm', ['root', '--global'], {
      cwd: homedir(),
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: NPM_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let stdout = '';
    let bytes = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > NPM_OUTPUT_MAX_BYTES) child.kill('SIGKILL');
      else stdout += chunk;
    });
    child.once('error', (cause) => {
      reject(
        new RuntimeHostCliInstallationError('npm_unavailable', 'Unable to run npm', { cause }),
      );
    });
    child.once('close', (code) => {
      const lines = stdout.trim().split(/\r?\n/u);
      if (code !== 0 || bytes > NPM_OUTPUT_MAX_BYTES || lines.length !== 1 || !lines[0]) {
        reject(
          new RuntimeHostCliInstallationError(
            'npm_unavailable',
            'Unable to resolve the npm global package root',
          ),
        );
        return;
      }
      resolveResult(lines[0]);
    });
  });
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function invalidInstallation(message: string, cause?: unknown): RuntimeHostCliInstallationError {
  return new RuntimeHostCliInstallationError('invalid_installation', message, { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
