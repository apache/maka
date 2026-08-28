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
import { createGunzip } from 'node:zlib';
import { isRuntimeHostNpmDeploymentIdentity } from '@maka/runtime-host/operator/update-package-evidence';
import type { RuntimeHostUpdateCandidate } from './runtime-host-registry-update.js';

const PACKAGE_NAME = 'maka-agent';
const NPM_REGISTRY = 'https://registry.npmjs.org/';
const OFFLINE_REGISTRY = 'http://127.0.0.1:9/';
const NPM_TIMEOUT_MS = 5 * 60_000;
const NPM_OUTPUT_MAX_BYTES = 64 * 1024;
const ARCHIVE_MAX_BYTES = 256 * 1024 * 1024;
// Integrity proves the archive matches the registry metadata; it does not make
// its expansion safe. A small valid .tgz can still exhaust the user's disk
// while npm extracts it, so the tar headers are budgeted before any npm
// install consumes the archive — staging, managed extraction, and the final
// npm-global switch all pass through the same bound.
const ARCHIVE_EXTRACTED_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const ARCHIVE_MAX_ENTRIES = 100_000;
const TAR_BLOCK_BYTES = 512;
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

export interface RuntimeHostRegistryUpdateArtifact {
  readonly archivePath: string;
  readonly packageRoot: string;
}

export async function withRuntimeHostRegistryUpdatePackage<T>(
  candidate: RuntimeHostUpdateCandidate,
  use: (packageRoot: string) => Promise<T>,
  runNpm: RunNpm = runNpmCommand,
): Promise<T> {
  return withRuntimeHostRegistryUpdateArtifact(
    candidate,
    ({ packageRoot }) => use(packageRoot),
    runNpm,
  );
}

export async function withRuntimeHostRegistryUpdateArtifact<T>(
  candidate: RuntimeHostUpdateCandidate,
  use: (artifact: RuntimeHostRegistryUpdateArtifact) => Promise<T>,
  runNpm: RunNpm = runNpmCommand,
): Promise<T> {
  return withRuntimeHostRegistryUpdateArchive(
    candidate,
    (archivePath) => withVerifiedRuntimeHostUpdateArchive(candidate, archivePath, use, runNpm),
    runNpm,
  );
}

export async function withRuntimeHostRegistryUpdateArchive<T>(
  candidate: RuntimeHostUpdateCandidate,
  use: (archivePath: string) => Promise<T>,
  runNpm: RunNpm = runNpmCommand,
): Promise<T> {
  assertCandidate(candidate);

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-runtime-host-update-'));
  try {
    let archive: string;
    try {
      const downloadRoot = join(temporaryRoot, 'download');
      const downloadCache = join(temporaryRoot, 'download-cache');
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

      archive = await requireDownloadedArchive(downloadRoot);
    } catch (error) {
      if (error instanceof RuntimeHostUpdatePackageError) throw error;
      throw new RuntimeHostUpdatePackageError(
        'package_download_failed',
        `Unable to prepare Maka ${candidate.version} for an update`,
        { cause: error },
      );
    }
    const verifiedArchive = await validateArchive(archive, candidate);
    return await use(verifiedArchive);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function withVerifiedRuntimeHostUpdateArchive<T>(
  candidate: RuntimeHostUpdateCandidate,
  archivePath: string,
  use: (artifact: RuntimeHostRegistryUpdateArtifact) => Promise<T>,
  runNpm: RunNpm = runNpmCommand,
  parentTemporaryRoot?: string,
): Promise<T> {
  assertCandidate(candidate);
  const temporaryRoot =
    parentTemporaryRoot ?? (await mkdtemp(join(tmpdir(), 'maka-runtime-host-update-')));
  try {
    const archive = await validateArchive(archivePath, candidate);
    await assertRuntimeHostArchiveExpansionBudget(archive);
    const installRoot = join(temporaryRoot, 'install');
    const emptyCache = join(temporaryRoot, 'empty-cache');
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
    const packageRoot = await validateExtractedPackage(installRoot, candidate);
    return await use({ archivePath: archive, packageRoot });
  } finally {
    if (parentTemporaryRoot === undefined) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

async function validateArchive(
  archivePath: string,
  candidate: RuntimeHostUpdateCandidate,
): Promise<string> {
  const archive = await realpath(archivePath);
  const [metadata, target] = await Promise.all([stat(archive), lstat(archive)]);
  if (
    !metadata.isFile() ||
    target.isSymbolicLink() ||
    metadata.size <= 0 ||
    metadata.size > ARCHIVE_MAX_BYTES
  ) {
    throw new RuntimeHostUpdatePackageError(
      'invalid_package',
      'The Maka package archive is invalid',
    );
  }
  if ((await packageIntegrity(archive)) !== candidate.integrity) {
    throw new RuntimeHostUpdatePackageError(
      'package_integrity_mismatch',
      `The downloaded Maka ${candidate.version} package does not match its registry integrity`,
    );
  }
  return archive;
}

export interface RuntimeHostArchiveExpansionBudget {
  readonly maxExtractedBytes: number;
  readonly maxEntries: number;
}

/**
 * Budget the tar headers of a verified .tgz before npm extracts it. SHA-512
 * integrity binds the archive to the registry metadata but says nothing about
 * its expansion: a small valid archive can still claim gigabytes of entry
 * data. Scanning the headers costs one pass over the compressed stream and
 * never writes a byte, so every extraction path — staging, the managed
 * prepare, and the npm-global switch — is bounded before npm runs.
 */
export async function assertRuntimeHostArchiveExpansionBudget(
  archivePath: string,
  budget: RuntimeHostArchiveExpansionBudget = {
    maxExtractedBytes: ARCHIVE_EXTRACTED_MAX_BYTES,
    maxEntries: ARCHIVE_MAX_ENTRIES,
  },
): Promise<void> {
  const fail = (message: string, options?: ErrorOptions): never => {
    throw new RuntimeHostUpdatePackageError('invalid_package', message, options);
  };
  const stream = createReadStream(archivePath).pipe(createGunzip());
  let pending = Buffer.alloc(0);
  // Payload bytes of the current entry that have not arrived yet. Header
  // bookkeeping advances past an entry's payload whether or not the payload
  // is already buffered, so the deficit must be carried across chunks —
  // otherwise the payload of any entry larger than one gunzip chunk would be
  // reparsed as the next header.
  let skipBytes = 0;
  let entries = 0;
  let extractedBytes = 0;
  let zeroBlocks = 0;
  let ended = false;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      pending = Buffer.concat([pending, chunk]);
      if (skipBytes > 0) {
        if (pending.length <= skipBytes) {
          skipBytes -= pending.length;
          // The chunk is fully consumed payload; drop it before the next
          // concat or already-skipped bytes would be counted twice.
          pending = Buffer.alloc(0);
          continue;
        }
        pending = pending.subarray(skipBytes);
        skipBytes = 0;
      }
      let offset = 0;
      while (pending.length - offset >= TAR_BLOCK_BYTES) {
        const header = pending.subarray(offset, offset + TAR_BLOCK_BYTES);
        if (isZeroBlock(header)) {
          zeroBlocks += 1;
          offset += TAR_BLOCK_BYTES;
          if (zeroBlocks === 2) {
            ended = true;
            break;
          }
          continue;
        }
        // POSIX tar uses two consecutive zero blocks as its only terminator.
        // Do not accept a stream that resumes after the first terminator block.
        if (zeroBlocks !== 0) fail('The Maka package archive has a malformed tar terminator');
        assertSupportedTarType(header, fail);
        const entryBytes = tarEntrySize(header, fail);
        entries += 1;
        extractedBytes += entryBytes;
        if (entries > budget.maxEntries || extractedBytes > budget.maxExtractedBytes) {
          fail('The Maka package archive exceeds its extraction budget');
        }
        offset += TAR_BLOCK_BYTES + Math.ceil(entryBytes / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
        if (offset > pending.length) {
          skipBytes = offset - pending.length;
          offset = pending.length;
          break;
        }
      }
      if (ended) break;
      pending = pending.subarray(offset);
    }
  } catch (error) {
    if (error instanceof RuntimeHostUpdatePackageError) throw error;
    fail('The Maka package archive is not a readable gzip tarball', { cause: error });
  } finally {
    stream.destroy();
  }
  if (!ended) {
    fail('The Maka package archive is a truncated tarball');
  }
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/**
 * This is a budget scanner, not a second tar implementation. Extended tar
 * headers can override the raw size field that the scanner sees, so reject
 * them rather than claiming a bound we cannot prove. Accept only standard
 * ustar entry kinds whose payload size is carried in this header.
 */
function assertSupportedTarType(header: Buffer, fail: (message: string) => never): void {
  const type = header[156] ?? 0;
  if (
    type === 0 ||
    type === 48 || // regular file
    type === 49 || // hard link
    type === 50 || // symbolic link
    type === 51 || // character device
    type === 52 || // block device
    type === 53 || // directory
    type === 54 || // FIFO
    type === 55 // contiguous file
  ) {
    return;
  }
  // In particular: x/g/X (PAX) and S (GNU sparse) can reinterpret payload
  // sizes, while L/K can reinterpret paths. Refuse all extended variants.
  fail('The Maka package archive uses an unsupported extended tar header');
}

/** Octal size field at offset 124 of a tar header; base-256 (GNU) sizes are refused. */
function tarEntrySize(header: Buffer, fail: (message: string) => never): number {
  const field = header.subarray(124, 136);
  if (field[0]! & 0x80) {
    fail('The Maka package archive exceeds its extraction budget');
  }
  const text = field.toString('latin1').replace(/\0.*$/u, '').trim();
  if (!/^[0-7]+$/u.test(text)) {
    fail('The Maka package archive has a malformed tar header');
  }
  const size = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(size)) {
    fail('The Maka package archive exceeds its extraction budget');
  }
  return size;
}

function assertCandidate(candidate: RuntimeHostUpdateCandidate): void {
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
