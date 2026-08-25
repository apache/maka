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
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRuntimeHostNpmDeploymentIdentity } from '@maka/runtime-host/operator';
import type { RuntimeHostUpdateCandidate } from './runtime-host-update-discovery.js';

const PACKAGE_NAME = 'maka-agent';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const OFFLINE_REGISTRY = 'http://127.0.0.1:9/';
const NPM_TIMEOUT_MS = 5 * 60_000;
const NPM_OUTPUT_MAX_BYTES = 64 * 1024;
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;

export class RuntimeHostUpdatePackageError extends Error {
  constructor(
    readonly code: 'package_download_failed' | 'package_integrity_mismatch' | 'invalid_package',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeHostUpdatePackageError';
  }
}

type RunNpm = (args: readonly string[], cwd: string) => Promise<number>;

export async function withRuntimeHostRegistryUpdatePackage<T>(
  candidate: RuntimeHostUpdateCandidate,
  use: (packageRoot: string) => Promise<T>,
  runNpm: RunNpm = runNpmCommand,
): Promise<T> {
  if (
    !isRuntimeHostNpmDeploymentIdentity(candidate) ||
    (candidate.compatibility !== undefined &&
      (!Number.isInteger(candidate.compatibility) || candidate.compatibility <= 0))
  ) {
    throw new RuntimeHostUpdatePackageError(
      'invalid_package',
      'The selected Runtime Host update candidate is invalid',
    );
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-host-update-'));
  try {
    let packageRoot: string;
    try {
      const downloadRoot = join(temporaryRoot, 'download');
      const downloadCache = join(temporaryRoot, 'download-cache');
      const installRoot = join(temporaryRoot, 'install');
      const emptyCache = join(temporaryRoot, 'empty-cache');
      await mkdir(downloadRoot, { mode: 0o700 });
      const packed = await runNpm(
        [
          'pack',
          `${PACKAGE_NAME}@${candidate.version}`,
          '--pack-destination',
          downloadRoot,
          '--registry',
          NPM_REGISTRY,
          '--cache',
          downloadCache,
          '--ignore-scripts',
        ],
        temporaryRoot,
      );
      if (packed !== 0) {
        throw new RuntimeHostUpdatePackageError(
          'package_download_failed',
          `Unable to download Maka ${candidate.version} from the official npm registry`,
        );
      }

      const archive = await requireDownloadedArchive(downloadRoot);
      if ((await packageIntegrity(archive)) !== candidate.integrity) {
        throw new RuntimeHostUpdatePackageError(
          'package_integrity_mismatch',
          `The downloaded Maka ${candidate.version} package does not match its registry integrity`,
        );
      }

      const installed = await runNpm(
        [
          'install',
          '--prefix',
          installRoot,
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--offline',
          '--cache',
          emptyCache,
          '--registry',
          OFFLINE_REGISTRY,
          archive,
        ],
        temporaryRoot,
      );
      if (installed !== 0) {
        throw new RuntimeHostUpdatePackageError(
          'invalid_package',
          `Unable to extract the verified Maka ${candidate.version} package`,
        );
      }

      packageRoot = await validateExtractedPackage(installRoot, candidate);
    } catch (error) {
      if (error instanceof RuntimeHostUpdatePackageError) throw error;
      throw new RuntimeHostUpdatePackageError(
        'package_download_failed',
        `Unable to prepare Maka ${candidate.version} for a managed Runtime Host update`,
        { cause: error },
      );
    }
    return await use(packageRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function requireDownloadedArchive(downloadRoot: string): Promise<string> {
  const entries = await readdir(downloadRoot, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isFile() || !entries[0].name.endsWith('.tgz')) {
    throw new RuntimeHostUpdatePackageError(
      'package_download_failed',
      'The npm registry did not return one Maka package archive',
    );
  }
  const archive = join(downloadRoot, entries[0].name);
  const [metadata, target] = await Promise.all([stat(archive), lstat(archive)]);
  if (
    !metadata.isFile() ||
    target.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > ARCHIVE_MAX_BYTES
  ) {
    throw new RuntimeHostUpdatePackageError(
      'invalid_package',
      'The downloaded Maka package archive is invalid',
    );
  }
  return archive;
}

async function packageIntegrity(path: string): Promise<string> {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha512-${hash.digest('base64')}`;
}

async function validateExtractedPackage(
  installRoot: string,
  candidate: RuntimeHostUpdateCandidate,
): Promise<string> {
  try {
    const packageRoot = await realpath(join(installRoot, 'node_modules', PACKAGE_NAME));
    const manifestPath = join(packageRoot, 'package.json');
    const [manifestMetadata, cli, runtimeHost] = await Promise.all([
      stat(manifestPath),
      stat(join(packageRoot, 'dist', 'cli.js')),
      stat(join(packageRoot, 'node_modules', '@maka', 'runtime-host', 'package.json')),
    ]);
    if (
      !manifestMetadata.isFile() ||
      manifestMetadata.size > MANIFEST_MAX_BYTES ||
      !cli.isFile() ||
      !runtimeHost.isFile()
    ) {
      throw new RuntimeHostUpdatePackageError(
        'invalid_package',
        'The downloaded Maka package is not a self-contained release',
      );
    }
    const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const compatibility =
      isRecord(manifest) && isRecord(manifest.maka)
        ? positiveInteger(manifest.maka.managedRuntimeHostUpdateCompatibility)
        : undefined;
    if (
      !isRecord(manifest) ||
      manifest.name !== PACKAGE_NAME ||
      manifest.version !== candidate.version ||
      compatibility !== candidate.compatibility
    ) {
      throw new RuntimeHostUpdatePackageError(
        'invalid_package',
        'The downloaded Maka package does not match its registry metadata',
      );
    }
    return packageRoot;
  } catch (error) {
    if (error instanceof RuntimeHostUpdatePackageError) throw error;
    throw new RuntimeHostUpdatePackageError(
      'invalid_package',
      'The downloaded Maka package manifest is invalid',
      { cause: error },
    );
  }
}

function runNpmCommand(args: readonly string[], cwd: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', [...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NPM_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    let outputBytes = 0;
    let outputExceeded = false;
    const observe = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes <= NPM_OUTPUT_MAX_BYTES) return;
      outputExceeded = true;
      child.kill('SIGKILL');
    };
    child.stdout.on('data', observe);
    child.stderr.on('data', observe);
    child.once('error', reject);
    child.once('close', (code) => {
      if (outputExceeded) {
        reject(new Error('npm returned too much output while preparing the update package'));
      } else {
        resolve(code ?? 1);
      }
    });
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
