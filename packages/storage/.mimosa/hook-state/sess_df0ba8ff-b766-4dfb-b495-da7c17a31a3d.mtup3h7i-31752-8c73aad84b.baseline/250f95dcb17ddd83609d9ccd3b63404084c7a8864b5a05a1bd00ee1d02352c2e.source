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
import fs from 'node:fs';
import { link, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { readStableBoundedFile, type StableBoundedFileHandle } from './stable-storage.js';

export interface MarkerFileHandle extends StableBoundedFileHandle {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface MarkerFileDependencies {
  open(path: string, flags: string | number, mode?: number): Promise<MarkerFileHandle>;
  randomUUID(): string;
}

const openMarkerFile = fs.promises.open.bind(fs.promises);
const defaultDependencies: MarkerFileDependencies = {
  // Capture once so later-loaded code cannot replace the marker authority's
  // filesystem primitive. Race fixtures interpose before dynamically importing
  // this module and are captured at the same boundary.
  open: openMarkerFile,
  randomUUID,
};

export interface ReadBoundedMarkerFileInput {
  path: string;
  maxBytes: number;
  invalidFile(): Error;
}

export async function readBoundedMarkerFile(
  input: ReadBoundedMarkerFileInput,
  dependencies: Partial<MarkerFileDependencies> = {},
): Promise<string> {
  const deps = { ...defaultDependencies, ...dependencies };
  const contents = await readStableBoundedFile(input, { open: deps.open });
  return contents.toString('utf8');
}

export interface PublishMarkerFileInput {
  root: string;
  markerFile: string;
  contents: string;
  maxBytes: number;
  publication: 'create' | 'replace';
  beforePublish?(): Promise<void>;
  invalidFile(): Error;
}

export async function publishMarkerFile(
  input: PublishMarkerFileInput,
  dependencies: Partial<MarkerFileDependencies> = {},
): Promise<'published' | 'already_exists'> {
  const deps = { ...defaultDependencies, ...dependencies };
  if (Buffer.byteLength(input.contents, 'utf8') > input.maxBytes) {
    throw input.invalidFile();
  }

  const markerPath = join(input.root, input.markerFile);
  const tempPath = join(input.root, `${input.markerFile}.${process.pid}.${deps.randomUUID()}.tmp`);
  let tempCreated = false;
  try {
    const handle = await deps.open(tempPath, 'wx', 0o600);
    tempCreated = true;
    try {
      await handle.writeFile(input.contents, 'utf8');
      await handle.sync();
      await handle.close();
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }

    await input.beforePublish?.();
    if (input.publication === 'create') {
      try {
        await link(tempPath, markerPath);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        return 'already_exists';
      }
    } else {
      await rename(tempPath, markerPath);
      tempCreated = false;
    }
    await syncDirectory(input.root, deps);
    return 'published';
  } finally {
    if (tempCreated) await unlinkIfPresent(tempPath);
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error, 'ENOENT')) throw error;
  }
}

async function syncDirectory(path: string, deps: MarkerFileDependencies): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await deps.open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
