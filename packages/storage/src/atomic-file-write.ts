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
import { dirname } from 'node:path';
import { syncDirectory } from './stable-storage.js';

/**
 * Owner-only atomic write for JSON config files: an exclusive temp file
 * ('wx'/O_EXCL so a pre-planted symlink at the predictable-ish temp path is
 * never followed), a durability fence before AND after the atomic rename, and
 * temp cleanup on failure. This is the single write-side authority for the
 * package's JSON stores (settings / mcp / credentials) so their strictness
 * cannot drift apart again.
 *
 * chmod policy is a documented invariant of this module, not a per-call
 * choice:
 *  - file chmod: fail-loud on POSIX, skipped on Windows (no POSIX mode).
 *    Applies after the exclusive open so umask can never loosen the file.
 *  - `dir: 'harden'`: mkdir + fail-closed chmod — we must not write plaintext
 *    secrets into a directory we could not lock down. Windows is best-effort
 *    for the same reason as above.
 */

export interface AtomicFileWriteOptions {
  /** Mode for the final file. The temp is opened with it and re-chmod'd, so a
   * pre-existing looser target is always tightened on the next write. */
  fileMode?: number;
  /** Directory handling. 'none' (default) leaves the directory entirely to
   * the caller; 'harden' creates/locks down an owner-only directory before
   * the temp is written (the credentials-store semantics). */
  dir?: 'none' | 'harden';
  /** Mode for `dir: 'harden'`. */
  dirMode?: number;
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

export async function writeAtomicFile(
  path: string,
  contents: string,
  options: AtomicFileWriteOptions = {},
  dependencies: Partial<AtomicFileWriteDependencies> = {},
): Promise<void> {
  const deps = { ...defaultDependencies, ...dependencies };
  const fileMode = options.fileMode ?? 0o600;
  if (options.dir === 'harden') {
    await hardenDirectory(dirname(path), options.dirMode ?? 0o700);
  }
  const tempPath = `${path}.${deps.randomUUID()}.tmp`;
  // Only the entry this call created — and hasn't renamed away — may be
  // cleaned up. A pre-existing file or planted symlink the 'wx' open refused
  // must not be deleted as "our" temp.
  let tempCreated = false;
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
    tempCreated = false;
    await deps.syncDirectory(dirname(path));
  } catch (error) {
    if (tempCreated) {
      // Cleanup must never mask the original failure.
      await rm(tempPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

/**
 * Create (or harden) an owner-only directory: recursive mkdir plus a
 * fail-closed chmod, since mkdir's mode only applies on creation. Shared by
 * the 'harden' write path and the credentials lock so their directory
 * strictness cannot drift apart.
 */
export async function hardenDirectory(dir: string, mode: number = 0o700): Promise<void> {
  await mkdir(dir, { recursive: true, mode });
  if (process.platform === 'win32') {
    await chmod(dir, mode).catch(() => {});
    return;
  }
  await chmod(dir, mode);
}
