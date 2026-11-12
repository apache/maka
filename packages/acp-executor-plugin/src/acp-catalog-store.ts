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

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { normalizeCatalogEntry, type ExecutorCatalogEntry } from '@maka/core/executor-catalog';
import type { PluginStorageService } from '@maka/runtime/plugin-data-services';
import type { AcpCatalogStore } from './acp-catalog.js';
import type { AcpLaunchSpec } from './index.js';

// Covers both the stored shape and the semantics of the derived catalog.
// Bump when AcpExecutor.#catalogEntry, catalog normalization, or any adapter's
// displayName/describeModels changes persisted labels, groups, provider types,
// defaults, or capabilities. Configuration and executable fingerprints cannot
// detect those code-only changes. A mismatch forces one neutral discovery.
const CATALOG_SNAPSHOT_VERSION = 2;

export interface AcpCatalogPersistence {
  readonly storage: Pick<PluginStorageService, 'get' | 'set' | 'delete'>;
  /** Stable executor entry key within the Host's namespaced Plugin storage. */
  readonly key: string;
}

export function createAcpCatalogStore(
  persistence: AcpCatalogPersistence,
  executorId: string,
  config: unknown,
  launch: AcpLaunchSpec,
): AcpCatalogStore {
  // Persist only a digest, never configuration values or credentials. Do not
  // fingerprint the inherited process environment: it includes per-launch
  // values and would make an otherwise unchanged restart miss the cache.
  const configuration = JSON.stringify(
    {
      executorId,
      config,
      executable: launch.executable,
      requiredExecutables: launch.requiredExecutables,
      args: launch.args,
      cwd: launch.cwd,
      initialConfig: launch.initialConfig,
      platform: process.platform,
      arch: process.arch,
    },
    (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
  );
  const fingerprint = async () => {
    const files = await Promise.all(
      [launch.executable, ...(launch.requiredExecutables ?? [])].map(async (path) => {
        const resolved = await realpath(path);
        await access(resolved, constants.X_OK);
        const file = await stat(resolved);
        if (!file.isFile()) throw new Error('ACP executable is not a file');
        return { path: resolved, size: file.size, mtime: file.mtimeMs, ctime: file.ctimeMs };
      }),
    );
    // Check current metadata when loading or persisting a neutral probe, not on cached reads.
    return createHash('sha256').update(configuration).update(JSON.stringify(files)).digest('hex');
  };
  const { storage, key } = persistence;
  return {
    async load() {
      const value = (await storage.get(key)).value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      const record = value as Record<string, unknown>;
      // Version 1 could contain project-specific Session models. Re-probe once
      // rather than allowing those candidates to survive an upgrade indefinitely.
      if (record.version !== CATALOG_SNAPSHOT_VERSION || record.binding !== (await fingerprint()))
        return;
      const entry = normalizeCatalogEntry(record.entry as ExecutorCatalogEntry, executorId);
      return entry.readiness === 'ready' ? entry : undefined;
    },
    async save(entry) {
      if (!entry) {
        await storage.delete(key);
        return;
      }
      const normalized = normalizeCatalogEntry(entry, executorId);
      if (normalized.readiness !== 'ready') return;
      await storage.set(key, {
        version: CATALOG_SNAPSHOT_VERSION,
        binding: await fingerprint(),
        entry: normalized,
      });
    },
  };
}
