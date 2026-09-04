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
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { syncDirectory } from './stable-storage.js';

/**
 * Owner-only atomic writer shared by the legacy settings, MCP, and credentials
 * JSON stores. It publishes an exclusive hidden temp file with rename and
 * removes that temp on failures before publication.
 *
 * Durability support depends on the platform and storage stack:
 *  - Linux and POSIX systems other than macOS: sync the temp file before
 *    rename and fsync the parent directory afterwards. Persistence still
 *    depends on the filesystem, mount, device, and hardware honoring them.
 *  - macOS: use Node's ordinary fsync operations; Node does not expose
 *    F_FULLFSYNC here, so this is not a uniform sudden-power-loss guarantee.
 *  - Windows: sync the temp file before rename, but parent-directory sync is a
 *    no-op because Node does not provide an equivalent directory fence.
 *
 * File chmod policy is a documented invariant of this module, not a per-call
 * choice:
 *  - file chmod: fail-loud on POSIX, skipped on Windows (no POSIX mode).
 *    Applies after the exclusive open so umask can never loosen the file.
 * Directory creation and permission policy belong to each caller.
 */

export interface AtomicFileWriteOptions {
  /** Mode for the final file. The temp is opened with it and re-chmod'd, so a
   * pre-existing looser target is always tightened on the next write. */
  fileMode?: number;
}

/** The fs surface `writeAtomicFile` needs; injectable for fault-injection
 * tests (same pattern as marker-file.ts). */
export interface AtomicFileWriteHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  chmod(mode: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface AtomicFileWriteDependencies {
  open(path: string, flags: string, mode?: number): Promise<AtomicFileWriteHandle>;
  randomUUID(): string;
  syncDirectory(path: string): Promise<void>;
}

const defaultDependencies: AtomicFileWriteDependencies = {
  open,
  randomUUID,
  syncDirectory,
};

export class AtomicFileWriteCommitUnknownError extends Error {
  readonly published = true;

  constructor(options: { cause: unknown }) {
    super('Atomic file commit outcome is unknown; reload before retrying', options);
    this.name = 'AtomicFileWriteCommitUnknownError';
  }
}

export async function writeAtomicFile(
  path: string,
  contents: string,
  options: AtomicFileWriteOptions = {},
  dependencies: Partial<AtomicFileWriteDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies };
  const fileMode = options.fileMode ?? 0o600;
  const tempPath = join(dirname(path), `.${basename(path)}.${deps.randomUUID()}.tmp`);
  // Only the entry this call created — and hasn't renamed away — may be
  // cleaned up. A pre-existing file or planted symlink the 'wx' open refused
  // must not be deleted as "our" temp.
  let tempCreated = false;
  let published = false;
  try {
    const handle = await deps.open(tempPath, 'wx', fileMode);
    tempCreated = true;
    try {
      await handle.writeFile(contents, 'utf8');
      if (process.platform !== 'win32') await handle.chmod(fileMode);
      await handle.sync();
      await handle.close();
    } catch (error) {
      // Release the descriptor best-effort; never let a close failure mask
      // the error that actually aborted the write.
      await handle.close().catch(() => {});
      throw error;
    }
    await rename(tempPath, path);
    published = true;
    tempCreated = false;
    await deps.syncDirectory(dirname(path));
  } catch (error) {
    if (tempCreated) {
      // Cleanup must never mask the original failure.
      await rm(tempPath, { force: true }).catch(() => {});
    }
    if (published) throw new AtomicFileWriteCommitUnknownError({ cause: error });
    throw error;
  }
}

/**
 * Create (or harden) an owner-only directory: recursive mkdir plus a
 * fail-closed chmod, since mkdir's mode only applies on creation. Callers that
 * store secrets use this before creating their file or update lock.
 */
export async function hardenDirectory(dir: string, mode: number = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  if (process.platform === 'win32') {
    await chmod(dir, mode).catch(() => {});
    return;
  }
  await chmod(dir, mode);
}
