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

import { promises as fs } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

import {
  realpathAllowMissing,
  resolveCanonicalDirectoryEntryTarget,
  type CanonicalDirectoryEntryTarget,
} from '../path-containment.js';

/**
 * Path canonicalisation used by the worker inside its sandbox.
 *
 * On POSIX platforms this is realpath-based: symlinks are followed to their
 * targets and containment is decided in the resolved path space.
 *
 * Inside the Windows AppContainer realpath is unavailable — both node's JS
 * implementation (lstat of every ancestor up to the volume root) and the
 * native one (GetFinalPathNameByHandle) are denied by the LowBox token. The
 * Windows variant therefore resolves lexically and REJECTS reparse points
 * outright instead of following them. That is sound because request paths are
 * canonicalised by the client before launch, the broker refuses to grant any
 * tree containing a reparse point, and the ACL grants themselves are the
 * kernel-side enforcement: a link created after grant time points at an
 * ungranted target the worker cannot touch anyway.
 */
export interface SandboxPathApi {
  realpath(path: string): Promise<string>;
  realpathAllowMissing(path: string): Promise<string>;
  resolveCanonicalDirectoryEntryTarget(
    cwd: string,
    inputPath: string,
  ): Promise<CanonicalDirectoryEntryTarget>;
}

const posixSandboxPaths: SandboxPathApi = {
  realpath: (path) => fs.realpath(path),
  realpathAllowMissing,
  resolveCanonicalDirectoryEntryTarget,
};

function reparseDenied(path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `EPERM: reparse points are not supported inside the Windows sandbox, lstat '${path}'`,
  );
  error.code = 'EPERM';
  return error;
}

async function windowsRealpath(path: string): Promise<string> {
  const resolved = resolve(path);
  const metadata = await fs.lstat(resolved);
  if (metadata.isSymbolicLink()) throw reparseDenied(resolved);
  return resolved;
}

async function windowsRealpathAllowMissing(path: string): Promise<string> {
  let cursor = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      const metadata = await fs.lstat(cursor);
      if (metadata.isSymbolicLink()) throw reparseDenied(cursor);
      return resolve(cursor, ...missing.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(basename(cursor));
      cursor = parent;
    }
  }
}

const windowsSandboxPaths: SandboxPathApi = {
  realpath: windowsRealpath,
  realpathAllowMissing: windowsRealpathAllowMissing,
  resolveCanonicalDirectoryEntryTarget: async (cwd, inputPath) => {
    const root = await windowsRealpath(cwd);
    const requested = resolve(root, inputPath);
    const parent = await windowsRealpathAllowMissing(dirname(requested));
    let existingAncestor = parent;
    while (true) {
      try {
        if ((await fs.lstat(existingAncestor)).isDirectory()) break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      }
      const next = dirname(existingAncestor);
      if (next === existingAncestor)
        throw new Error(`No directory contains ${JSON.stringify(inputPath)}`);
      existingAncestor = next;
    }
    return { root, path: resolve(parent, basename(requested)), existingAncestor };
  },
};

export function sandboxPathApi(platform: NodeJS.Platform = process.platform): SandboxPathApi {
  return platform === 'win32' ? windowsSandboxPaths : posixSandboxPaths;
}
