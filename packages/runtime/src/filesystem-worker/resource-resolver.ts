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

import { realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FILESYSTEM_WORKER_BUNDLE_NAME = 'filesystem-worker.js';

export type FilesystemWorkerResourceLocation =
  | { kind: 'runtime'; moduleUrl?: string }
  | { kind: 'desktop-packaged'; resourcesPath: string };

export type FilesystemWorkerResourceResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'bundle_not_found' | 'bundle_invalid'; path: string };

export function filesystemWorkerBundleCandidate(
  location: FilesystemWorkerResourceLocation,
): string {
  if (location.kind === 'desktop-packaged') {
    return join(location.resourcesPath, 'workers', FILESYSTEM_WORKER_BUNDLE_NAME);
  }
  const moduleUrl = location.moduleUrl ?? import.meta.url;
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', 'workers', FILESYSTEM_WORKER_BUNDLE_NAME);
}

export async function resolveFilesystemWorkerBundle(
  location: FilesystemWorkerResourceLocation,
): Promise<FilesystemWorkerResourceResult> {
  const candidate = filesystemWorkerBundleCandidate(location);
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) return { ok: false, reason: 'bundle_invalid', path: candidate };
    return { ok: true, path: await realpath(candidate) };
  } catch (error) {
    return {
      ok: false,
      reason: nodeErrorCode(error) === 'ENOENT' ? 'bundle_not_found' : 'bundle_invalid',
      path: candidate,
    };
  }
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}
