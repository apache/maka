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

import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { isCanonicalExtensionId } from '@maka/runtime/plugin-runtime';
import {
  exportExtensionBundle,
  extensionPackageContentDigest,
  materializeExtensionPackage,
} from './extension-bundle.js';
import {
  EXTENSION_PACKAGE_MANIFEST_FILE,
  type ExtensionPackageManifest,
  loadExtensionPackageManifest,
} from './extension-package-manifest.js';

const STORE_DIRECTORY = 'plugin-packages-v2';
const MAX_FILES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;

interface PackageFile {
  readonly path: string;
  readonly content: Buffer;
}

export interface InstalledPluginPackage {
  readonly extensionId: string;
  readonly contentDigest: string;
  readonly root: string;
  readonly entry: string;
  readonly manifest: ExtensionPackageManifest;
}

export interface PreparedPluginPackageInstall {
  readonly installed: InstalledPluginPackage;
  publish(baseGeneration: number, nextGeneration: number): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

interface PackageInstallTransaction {
  readonly schemaVersion: 1;
  readonly extensionId: string;
  readonly baseGeneration: number;
  readonly nextGeneration: number;
}

export class PluginPackageStoreError extends Error {
  readonly name = 'PluginPackageStoreError';

  constructor(
    readonly code:
      | 'not_found'
      | 'invalid_package'
      | 'persistence_failed'
      | 'commit_outcome_unknown',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Atomic, root-private storage for trusted in-process Plugin packages. */
export class PluginPackageStore {
  readonly root: string;
  readonly #controlDirectory: string;

  constructor(controlDirectory: string) {
    this.#controlDirectory = controlDirectory;
    this.root = join(controlDirectory, STORE_DIRECTORY);
  }

  protected async publishCandidate(staging: string, target: string): Promise<void> {
    await rename(staging, target);
  }

  /** Repairs or removes package-store transaction remnants after owner death. */
  async recover(authorityGeneration = 0): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw persistence('Unable to recover Plugin package storage', error);
    }
    let changed = false;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith('.')) continue;
      const path = join(this.root, entry.name);
      if (entry.name.startsWith('.install-')) {
        await this.#recoverInstall(path, authorityGeneration);
        changed = true;
        continue;
      }
      if (entry.name.startsWith('.previous-')) {
        try {
          const files = await readPackage(path);
          const decoded = await decodePackage(path, files);
          const target = join(this.root, decoded.manifest.id);
          try {
            await stat(target);
            await rm(path, { recursive: true, force: true });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            await rename(path, target);
          }
          changed = true;
          continue;
        } catch (error) {
          throw persistence(`Unable to recover Plugin package transaction ${entry.name}`, error);
        }
      }
      if (
        entry.name.startsWith('.staging-') ||
        entry.name.startsWith('.rejected-') ||
        entry.name.startsWith('.removed-')
      ) {
        await rm(path, { recursive: true, force: true });
        changed = true;
      }
    }
    if (changed) await syncDirectory(this.root);
  }

  async identities(): Promise<readonly string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Object.freeze([]);
      throw persistence('Unable to list Plugin package identities', error);
    }
    return Object.freeze(
      entries
        .filter((entry) => entry.isDirectory() && isCanonicalExtensionId(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right)),
    );
  }

  async prepareInstall(sourcePath: string): Promise<PreparedPluginPackageInstall> {
    const source = await materializeExtensionPackage(sourcePath, this.#controlDirectory);
    try {
      const files = await readPackage(source.root);
      const decoded = await decodePackage(source.root, files);
      const target = join(this.root, decoded.manifest.id);
      const transaction = join(this.root, `.install-${randomUUID()}`);
      const staging = join(transaction, 'candidate');
      const previous = join(transaction, 'previous');
      let movedPrevious = false;
      let published = false;
      let settled = false;
      try {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        await mkdir(transaction, { mode: 0o700 });
        await mkdir(staging, { mode: 0o700 });
        for (const file of files) await writeFile(staging, file);
        await syncTree(staging, files);
        await syncDirectory(transaction);
        await syncDirectory(this.root);
        const installed = freezeInstalled(staging, decoded);
        return Object.freeze({
          installed,
          publish: async (baseGeneration: number, nextGeneration: number) => {
            if (settled || published)
              throw persistence('Plugin package install is already settled');
            if (
              !Number.isSafeInteger(baseGeneration) ||
              !Number.isSafeInteger(nextGeneration) ||
              baseGeneration < 0 ||
              nextGeneration !== baseGeneration + 1
            ) {
              throw invalid('Plugin package install generations are invalid');
            }
            await writeTransaction(transaction, {
              schemaVersion: 1,
              extensionId: decoded.manifest.id,
              baseGeneration,
              nextGeneration,
            });
            try {
              await rename(target, previous)
                .then(() => {
                  movedPrevious = true;
                })
                .catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error;
                });
              await this.publishCandidate(staging, target);
              published = true;
              await syncDirectory(this.root);
            } catch (error) {
              throw new PluginPackageStoreError(
                'commit_outcome_unknown',
                `Plugin package publication outcome is unknown: ${decoded.manifest.id}`,
                { cause: error },
              );
            }
          },
          commit: async () => {
            if (settled) return;
            if (!published) throw persistence('Plugin package install was not published');
            settled = true;
            await rm(transaction, { recursive: true, force: true }).catch(() => undefined);
          },
          rollback: async () => {
            if (settled) return;
            settled = true;
            if (!published) {
              await rm(transaction, { recursive: true, force: true });
              return;
            }
            await rollbackPublishedInstall(this.root, target, transaction, movedPrevious);
          },
        });
      } catch (error) {
        if (published) {
          try {
            await rollbackPublishedInstall(this.root, target, transaction, movedPrevious);
          } catch (rollbackError) {
            if (rollbackError instanceof PluginPackageStoreError) throw rollbackError;
            throw new PluginPackageStoreError(
              'commit_outcome_unknown',
              `Plugin package installation outcome is unknown: ${decoded.manifest.id}`,
              { cause: new AggregateError([error, rollbackError]) },
            );
          }
        } else {
          await rm(transaction, { recursive: true, force: true }).catch(() => undefined);
        }
        if (error instanceof PluginPackageStoreError) throw error;
        throw persistence(`Unable to install Plugin package ${decoded.manifest.id}`, error);
      }
    } finally {
      await source.dispose();
    }
  }

  async #recoverInstall(transactionRoot: string, authorityGeneration: number): Promise<void> {
    const transaction = await readTransaction(transactionRoot);
    if (!transaction) {
      // The journal is synced before the first canonical Package rename. A
      // journal-less directory is therefore either an abandoned preparation
      // or a partially removed, already-committed transaction. In both cases
      // the transaction directory is only a remnant and is safe to discard.
      await rm(transactionRoot, { recursive: true, force: true });
      return;
    }
    const target = join(this.root, transaction.extensionId);
    const candidate = join(transactionRoot, 'candidate');
    const previous = join(transactionRoot, 'previous');
    const rejected = join(transactionRoot, 'rejected');
    const candidateExists = await exists(candidate);
    const targetExists = await exists(target);
    const previousExists = await exists(previous);
    const rejectedExists = await exists(rejected);
    if (authorityGeneration === transaction.baseGeneration) {
      if (rejectedExists) {
        // Rollback has already moved the candidate away from the canonical
        // target. If target exists it is the restored previous Package; if it
        // does not, finish restoring previous before dropping the rejected
        // candidate with the transaction directory.
        if (!targetExists && previousExists) await rename(previous, target);
      } else {
        if (!candidateExists && targetExists) {
          await rm(target, { recursive: true, force: true });
        }
        if (previousExists) await rename(previous, target);
      }
      await syncDirectory(this.root);
      await rm(transactionRoot, { recursive: true, force: true });
      return;
    }
    if (authorityGeneration >= transaction.nextGeneration) {
      if (candidateExists || !targetExists) {
        throw persistence(
          `Plugin package transaction does not match committed authority: ${transaction.extensionId}`,
        );
      }
      await rm(transactionRoot, { recursive: true, force: true });
      return;
    }
    throw persistence(
      `Plugin package transaction generation is ambiguous: ${transaction.extensionId}`,
    );
  }

  async list(): Promise<readonly InstalledPluginPackage[]> {
    const installed: InstalledPluginPackage[] = [];
    for (const extensionId of await this.identities()) installed.push(await this.load(extensionId));
    return Object.freeze(installed);
  }

  async load(extensionId: string): Promise<InstalledPluginPackage> {
    requireIdentity(extensionId);
    const root = join(this.root, extensionId);
    try {
      if (!(await stat(root)).isDirectory()) throw invalid('Installed package is not a directory');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PluginPackageStoreError(
          'not_found',
          `Plugin package is not installed: ${extensionId}`,
        );
      }
      if (error instanceof PluginPackageStoreError) throw error;
      throw persistence(`Unable to read Plugin package ${extensionId}`, error);
    }
    const files = await readPackage(root);
    const decoded = await decodePackage(root, files);
    if (decoded.manifest.id !== extensionId) {
      throw invalid(`Installed Plugin identity does not match its directory: ${extensionId}`);
    }
    return freezeInstalled(root, decoded);
  }

  async export(extensionId: string, targetPath: string): Promise<void> {
    const installed = await this.load(extensionId);
    await exportExtensionBundle(installed.root, targetPath);
  }

  async uninstall(extensionId: string): Promise<void> {
    await this.load(extensionId);
    const target = join(this.root, extensionId);
    const removed = join(this.root, `.removed-${extensionId}-${randomUUID()}`);
    let published = false;
    try {
      await rename(target, removed);
      published = true;
      await syncDirectory(this.root);
      await rm(removed, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      if (published) {
        throw new PluginPackageStoreError(
          'commit_outcome_unknown',
          `Plugin package uninstall outcome is unknown: ${extensionId}`,
          { cause: error },
        );
      }
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw persistence(`Unable to uninstall Plugin package ${extensionId}`, error);
      }
    }
  }
}

async function writeTransaction(
  root: string,
  transaction: PackageInstallTransaction,
): Promise<void> {
  const handle = await open(join(root, 'transaction.json'), 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(transaction)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(root);
  await syncDirectory(dirname(root));
}

async function readTransaction(root: string): Promise<PackageInstallTransaction | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(root, 'transaction.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw persistence('Unable to read Plugin package install transaction', error);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw persistence('Plugin package install transaction is invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    record.schemaVersion !== 1 ||
    !isCanonicalExtensionId(record.extensionId) ||
    !Number.isSafeInteger(record.baseGeneration) ||
    !Number.isSafeInteger(record.nextGeneration) ||
    (record.baseGeneration as number) < 0 ||
    record.nextGeneration !== (record.baseGeneration as number) + 1
  ) {
    throw persistence('Plugin package install transaction is invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    extensionId: record.extensionId as string,
    baseGeneration: record.baseGeneration as number,
    nextGeneration: record.nextGeneration as number,
  });
}

async function rollbackPublishedInstall(
  storeRoot: string,
  target: string,
  transactionRoot: string,
  movedPrevious: boolean,
): Promise<void> {
  const rejected = join(transactionRoot, 'rejected');
  try {
    await rename(target, rejected).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (movedPrevious) await rename(join(transactionRoot, 'previous'), target);
    await rename(rejected, join(transactionRoot, 'candidate')).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    await syncDirectory(storeRoot);
    await rm(transactionRoot, { recursive: true, force: true });
    await syncDirectory(storeRoot);
  } catch (error) {
    throw new PluginPackageStoreError(
      'commit_outcome_unknown',
      'Plugin package rollback outcome is unknown',
      { cause: error },
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function decodePackage(
  root: string,
  files: readonly PackageFile[],
): Promise<{
  readonly manifest: ExtensionPackageManifest;
  readonly entry: string;
  readonly contentDigest: string;
}> {
  if (!files.some((file) => file.path === EXTENSION_PACKAGE_MANIFEST_FILE)) {
    throw invalid(`Plugin package is missing ${EXTENSION_PACKAGE_MANIFEST_FILE}`);
  }
  const manifest = await loadExtensionPackageManifest(root);
  if (!manifest) throw invalid(`Plugin package is missing ${EXTENSION_PACKAGE_MANIFEST_FILE}`);
  if (!manifest.runtime?.entry) throw invalid('Plugin package has no trusted Runtime entry');
  if (!files.some((file) => file.path === manifest.runtime!.entry)) {
    throw invalid(`Plugin Runtime entry does not exist: ${manifest.runtime.entry}`);
  }
  if (manifest.composition && !files.some((file) => file.path === manifest.composition!.patch)) {
    throw invalid(`Plugin Composition patch does not exist: ${manifest.composition.patch}`);
  }
  return Object.freeze({
    manifest,
    entry: manifest.runtime.entry,
    contentDigest: extensionPackageContentDigest(files),
  });
}

async function readPackage(rootValue: string): Promise<readonly PackageFile[]> {
  let root: string;
  try {
    root = await realpath(rootValue);
  } catch (error) {
    throw invalid('Plugin package source is unavailable', error);
  }
  const paths: string[] = [];
  await collect(root, '', paths);
  if (paths.length === 0 || paths.length > MAX_FILES) {
    throw invalid('Plugin package file count is invalid');
  }
  let total = 0;
  const files: PackageFile[] = [];
  for (const path of paths.sort()) {
    const handle = await open(join(root, ...path.split('/')), 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES) {
        throw invalid(`Plugin package file is invalid: ${path}`);
      }
      const content = await handle.readFile();
      total += content.byteLength;
      if (total > MAX_PACKAGE_BYTES) throw invalid('Plugin package is too large');
      files.push(Object.freeze({ path, content }));
    } finally {
      await handle.close();
    }
  }
  return Object.freeze(files);
}

async function collect(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory ? join(root, ...directory.split('/')) : root, {
    withFileTypes: true,
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git') continue;
    const path = safePath(directory ? `${directory}/${entry.name}` : entry.name);
    if (entry.isSymbolicLink()) throw invalid(`Plugin package may not contain symlinks: ${path}`);
    if (entry.isDirectory()) await collect(root, path, paths);
    else if (entry.isFile()) paths.push(path);
    else throw invalid(`Plugin package contains an unsupported entry: ${path}`);
    if (paths.length > MAX_FILES) throw invalid('Plugin package contains too many files');
  }
}

async function writeFile(root: string, file: PackageFile): Promise<void> {
  const target = join(root, ...file.path.split('/'));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(file.content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncTree(root: string, files: readonly PackageFile[]): Promise<void> {
  const directories = new Set<string>([root]);
  for (const file of files) {
    let current = dirname(join(root, ...file.path.split('/')));
    while (current.startsWith(root)) {
      directories.add(current);
      if (current === root) break;
      current = dirname(current);
    }
  }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
    await syncDirectory(directory);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function freezeInstalled(
  root: string,
  decoded: {
    readonly manifest: ExtensionPackageManifest;
    readonly entry: string;
    readonly contentDigest: string;
  },
): InstalledPluginPackage {
  return Object.freeze({
    extensionId: decoded.manifest.id,
    contentDigest: decoded.contentDigest,
    root,
    entry: join(root, ...decoded.entry.split('/')),
    manifest: decoded.manifest,
  });
}

function safePath(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    value.includes('\\') ||
    value.startsWith('/') ||
    posix.normalize(value) !== value ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw invalid('Plugin package path is invalid');
  }
  return value;
}

function requireIdentity(extensionId: string): void {
  if (!isCanonicalExtensionId(extensionId)) throw invalid('Plugin package identity is invalid');
}

function invalid(message: string, cause?: unknown): PluginPackageStoreError {
  return new PluginPackageStoreError('invalid_package', message, { cause });
}

function persistence(message: string, cause?: unknown): PluginPackageStoreError {
  return new PluginPackageStoreError('persistence_failed', message, { cause });
}
