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
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isCanonicalExtensionId,
  type MakaCompositionOperation,
} from '@maka/runtime/plugin-runtime';
import { decodePluginCompositionApplyInput } from '../protocol/plugin-platform.js';

const FILE_NAME = 'plugin-composition-v2.json';
const MAX_BYTES = 2 * 1024 * 1024;

/** Durable inputs from which the desired Entry Tree is rebuilt. */
export interface PersistedPluginComposition {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly packageLayers: readonly string[];
  readonly overlays: readonly MakaCompositionOperation[];
}

export class HostPluginCompositionStoreError extends Error {
  readonly name = 'HostPluginCompositionStoreError';

  constructor(
    readonly code: 'persistence_failed' | 'invalid_state' | 'commit_outcome_unknown',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class HostPluginCompositionStore {
  readonly path: string;

  constructor(controlDirectory: string) {
    this.path = join(controlDirectory, FILE_NAME);
  }

  async read(): Promise<PersistedPluginComposition | undefined> {
    let encoded: Buffer;
    try {
      encoded = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw persistence('Unable to read Plugin Composition', error);
    }
    if (encoded.byteLength > MAX_BYTES) throw invalid('Plugin Composition exceeds its size limit');
    try {
      return decode(JSON.parse(encoded.toString('utf8')));
    } catch (error) {
      if (error instanceof HostPluginCompositionStoreError) throw error;
      throw invalid('Plugin Composition is invalid JSON', error);
    }
  }

  async replace(composition: PersistedPluginComposition): Promise<void> {
    const normalized = decode(composition);
    const encoded = Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8');
    if (encoded.byteLength > MAX_BYTES) throw invalid('Plugin Composition exceeds its size limit');
    const directory = dirname(this.path);
    const temporary = join(directory, `.${FILE_NAME}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let published = false;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(encoded);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      published = true;
      const directoryHandle = await open(directory, 'r');
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      if (published) {
        throw new HostPluginCompositionStoreError(
          'commit_outcome_unknown',
          'Plugin Composition was renamed but its directory sync was not confirmed',
          { cause: error },
        );
      }
      throw persistence('Unable to persist Plugin Composition', error);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

function decode(value: unknown): PersistedPluginComposition {
  const root = record(value, 'Plugin Composition');
  exact(root, ['schemaVersion', 'generation', 'packageLayers', 'overlays']);
  if (
    root.schemaVersion !== 1 ||
    !Number.isSafeInteger(root.generation) ||
    (root.generation as number) < 0
  ) {
    throw invalid('Plugin Composition header is invalid');
  }
  if (
    !Array.isArray(root.packageLayers) ||
    root.packageLayers.length > 256 ||
    root.packageLayers.some((item) => !isCanonicalExtensionId(item)) ||
    new Set(root.packageLayers).size !== root.packageLayers.length
  ) {
    throw invalid('Plugin Composition package layers are invalid');
  }
  if (!Array.isArray(root.overlays) || root.overlays.length > 4096) {
    throw invalid('Plugin Composition overlays are invalid');
  }
  const overlays =
    root.overlays.length === 0
      ? Object.freeze([])
      : Object.freeze(
          decodePluginCompositionApplyInput({ operations: root.overlays }, MAX_BYTES).operations,
        );
  return Object.freeze({
    schemaVersion: 1,
    generation: root.generation as number,
    packageLayers: Object.freeze([...(root.packageLayers as string[])]),
    overlays,
  });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  ) {
    throw invalid('Plugin Composition fields are invalid');
  }
}

function invalid(message: string, cause?: unknown): HostPluginCompositionStoreError {
  return new HostPluginCompositionStoreError('invalid_state', message, { cause });
}

function persistence(message: string, cause?: unknown): HostPluginCompositionStoreError {
  return new HostPluginCompositionStoreError('persistence_failed', message, { cause });
}
