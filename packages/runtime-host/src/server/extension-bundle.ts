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

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve } from 'node:path';

const MAX_FILES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;
const BUNDLE_IMPORTS_DIRECTORY = 'bundle-imports-v1';

interface BundleFile {
  readonly path: string;
  readonly sha256: string;
  readonly content: string;
}

interface ExtensionBundleDocument {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly files: readonly BundleFile[];
}

export class ExtensionBundleError extends Error {
  readonly name = 'ExtensionBundleError';
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export async function exportExtensionBundle(sourceRoot: string, targetPath: string): Promise<void> {
  if (!isAbsolute(targetPath)) throw invalid('Extension bundle targetPath must be absolute');
  const files = await readDirectory(sourceRoot);
  const document: ExtensionBundleDocument = Object.freeze({
    schemaVersion: 1,
    digest: extensionPackageContentDigest(files),
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({
          path: file.path,
          sha256: createHash('sha256').update(file.content).digest('hex'),
          content: file.content.toString('base64'),
        }),
      ),
    ),
  });
  const encoded = Buffer.from(`${JSON.stringify(document)}\n`, 'utf8');
  if (encoded.byteLength > MAX_BUNDLE_BYTES * 2)
    throw invalid('Encoded Extension bundle is too large');
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(encoded);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await copyFile(temporary, targetPath, constants.COPYFILE_EXCL);
  } catch (error) {
    throw invalid('Unable to export Extension bundle', error);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function materializeExtensionPackage(
  sourcePath: string,
  controlDirectory: string,
): Promise<{ readonly root: string; readonly dispose: () => Promise<void> }> {
  if (!isAbsolute(sourcePath)) throw invalid('Extension package sourcePath must be absolute');
  const canonical = await realpath(resolve(sourcePath)).catch((error) => {
    throw invalid('Extension package source is unavailable', error);
  });
  const metadata = await stat(canonical);
  if (metadata.isDirectory()) return { root: canonical, dispose: async () => undefined };
  if (!metadata.isFile())
    throw invalid('Extension package source must be a directory or bundle file');
  if (metadata.size > MAX_BUNDLE_BYTES * 2)
    throw invalid('Extension bundle exceeds its size limit');
  const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  let document: ExtensionBundleDocument;
  try {
    document = decodeBundle(JSON.parse((await handle.readFile()).toString('utf8')));
  } catch (error) {
    if (error instanceof ExtensionBundleError) throw error;
    throw invalid('Extension bundle is invalid', error);
  } finally {
    await handle.close();
  }
  const imports = join(controlDirectory, BUNDLE_IMPORTS_DIRECTORY);
  const root = join(imports, randomUUID());
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    for (const file of document.files) {
      const target = join(root, ...file.path.split('/'));
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const output = await open(target, 'wx', 0o600);
      try {
        await output.writeFile(Buffer.from(file.content, 'base64'));
      } finally {
        await output.close();
      }
    }
    return { root, dispose: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw invalid('Unable to materialize Extension bundle', error);
  }
}

/** Removes bundle materializations left behind when the previous owner died. */
export async function recoverExtensionBundleImports(controlDirectory: string): Promise<void> {
  try {
    await rm(join(controlDirectory, BUNDLE_IMPORTS_DIRECTORY), {
      recursive: true,
      force: true,
    });
  } catch (error) {
    throw invalid('Unable to recover Extension bundle imports', error);
  }
}

async function readDirectory(
  rootValue: string,
): Promise<readonly { path: string; content: Buffer }[]> {
  const root = await realpath(rootValue);
  if (!(await stat(root)).isDirectory())
    throw invalid('Extension bundle source is not a directory');
  const paths: string[] = [];
  await collect(root, '', paths);
  if (paths.length === 0 || paths.length > MAX_FILES)
    throw invalid('Extension bundle file count is invalid');
  let total = 0;
  const files: { path: string; content: Buffer }[] = [];
  for (const path of paths.sort()) {
    const handle = await open(
      join(root, ...path.split('/')),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_FILE_BYTES)
        throw invalid(`Extension bundle file is invalid: ${path}`);
      const content = await handle.readFile();
      total += content.byteLength;
      if (total > MAX_BUNDLE_BYTES) throw invalid('Extension bundle payload is too large');
      files.push({ path, content });
    } finally {
      await handle.close();
    }
  }
  return files;
}

async function collect(root: string, directory: string, paths: string[]): Promise<void> {
  const entries = await readdir(directory ? join(root, ...directory.split('/')) : root, {
    withFileTypes: true,
  });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === '.git') continue;
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    safePath(path);
    if (entry.isSymbolicLink()) throw invalid(`Extension bundle may not contain symlinks: ${path}`);
    if (entry.isDirectory()) await collect(root, path, paths);
    else if (entry.isFile()) paths.push(path);
    else throw invalid(`Extension bundle contains an unsupported entry: ${path}`);
    if (paths.length > MAX_FILES) throw invalid('Extension bundle contains too many files');
  }
}

function decodeBundle(value: unknown): ExtensionBundleDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid('Extension bundle must be an object');
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join() !== 'digest,files,schemaVersion' ||
    record.schemaVersion !== 1 ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_FILES
  ) {
    throw invalid('Extension bundle fields are invalid');
  }
  let total = 0;
  const paths = new Set<string>();
  const files = record.files.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw invalid('Extension bundle file is invalid');
    const file = value as Record<string, unknown>;
    if (
      Object.keys(file).sort().join() !== 'content,path,sha256' ||
      typeof file.path !== 'string' ||
      typeof file.content !== 'string' ||
      typeof file.sha256 !== 'string'
    )
      throw invalid('Extension bundle file fields are invalid');
    const path = safePath(file.path);
    if (paths.has(path)) throw invalid(`Extension bundle repeats file: ${path}`);
    paths.add(path);
    const content = Buffer.from(file.content, 'base64');
    total += content.byteLength;
    if (
      content.byteLength > MAX_FILE_BYTES ||
      total > MAX_BUNDLE_BYTES ||
      createHash('sha256').update(content).digest('hex') !== file.sha256
    ) {
      throw invalid(`Extension bundle file integrity failed: ${path}`);
    }
    return { path, content };
  });
  if (typeof record.digest !== 'string' || extensionPackageContentDigest(files) !== record.digest)
    throw invalid('Extension bundle digest is invalid');
  return Object.freeze({
    schemaVersion: 1,
    digest: record.digest,
    files: Object.freeze(
      files.map((file) =>
        Object.freeze({
          path: file.path,
          sha256: createHash('sha256').update(file.content).digest('hex'),
          content: file.content.toString('base64'),
        }),
      ),
    ),
  });
}

export function extensionPackageContentDigest(
  files: readonly { path: string; content: Buffer }[],
): string {
  const hash = createHash('sha256');
  for (const file of files) {
    const path = Buffer.from(file.path, 'utf8');
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(path.byteLength));
    hash.update(length).update(path);
    length.writeBigUInt64BE(BigInt(file.content.byteLength));
    hash.update(length).update(file.content);
  }
  return `sha256-${hash.digest('hex')}`;
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
    throw invalid('Extension bundle path is invalid');
  }
  return value;
}

function invalid(message: string, cause?: unknown): ExtensionBundleError {
  return new ExtensionBundleError(message, { cause });
}
