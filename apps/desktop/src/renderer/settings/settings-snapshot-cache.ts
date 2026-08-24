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

import type { AppSettings } from '@maka/core/settings';
import type { LlmConnection } from '@maka/core/llm-connections';
import type {
  DesktopRuntimeHostProfileSnapshot,
  DesktopRuntimeHostRef,
} from '../../preload/bridge-contract.js';

export interface RuntimeHostConnectionsSnapshot {
  readonly connections: LlmConnection[];
  readonly defaultSlug: string | null;
}

export interface SettingsSnapshotCache {
  readClient(): AppSettings | undefined;
  commitClientRead(snapshot: AppSettings): void;

  readRuntimeHostCatalog(): DesktopRuntimeHostProfileSnapshot | undefined;
  commitRuntimeHostCatalogRead(snapshot: DesktopRuntimeHostProfileSnapshot): void;

  readRuntimeHostSettings(key: string): AppSettings | undefined;
  commitRuntimeHostSettingsRead(key: string, snapshot: AppSettings): void;

  readRuntimeHostConnections(key: string): RuntimeHostConnectionsSnapshot | undefined;
  commitRuntimeHostConnectionsRead(
    key: string,
    snapshot: RuntimeHostConnectionsSnapshot,
  ): void;
}

export function runtimeHostSettingsKey(host: DesktopRuntimeHostRef): string {
  return `${host.profileId}:${host.hostId}`;
}

/**
 * Renderer-memory cache for masked read snapshots. It deliberately has no
 * method that accepts a settings mutation response: update responses may
 * reveal the just-submitted secret, while subsequent GETs are masked again.
 */
export function createSettingsSnapshotCache(): SettingsSnapshotCache {
  let client: AppSettings | undefined;
  let runtimeHostCatalog: DesktopRuntimeHostProfileSnapshot | undefined;
  const runtimeHostSettings = new Map<string, AppSettings>();
  const runtimeHostConnections = new Map<string, RuntimeHostConnectionsSnapshot>();

  return {
    readClient: () => client,
    commitClientRead: (snapshot) => {
      client = snapshot;
    },
    readRuntimeHostCatalog: () => runtimeHostCatalog,
    commitRuntimeHostCatalogRead: (snapshot) => {
      runtimeHostCatalog = snapshot;
      const currentHostKeys = new Set(
        snapshot.entries.flatMap((entry) =>
          entry.hostId
            ? [runtimeHostSettingsKey({ profileId: entry.profile.id, hostId: entry.hostId })]
            : [],
        ),
      );
      for (const key of runtimeHostSettings.keys()) {
        if (!currentHostKeys.has(key)) runtimeHostSettings.delete(key);
      }
      for (const key of runtimeHostConnections.keys()) {
        if (!currentHostKeys.has(key)) runtimeHostConnections.delete(key);
      }
    },
    readRuntimeHostSettings: (key) => runtimeHostSettings.get(key),
    commitRuntimeHostSettingsRead: (key, snapshot) => {
      runtimeHostSettings.set(key, snapshot);
    },
    readRuntimeHostConnections: (key) => runtimeHostConnections.get(key),
    commitRuntimeHostConnectionsRead: (key, snapshot) => {
      runtimeHostConnections.set(key, snapshot);
    },
  };
}

const settingsSnapshotCaches = new WeakMap<object, SettingsSnapshotCache>();

/**
 * One cache per bridge identity survives Settings modal unmounts without
 * moving Settings data into AppShell. Storybook and tests get isolated caches
 * by installing distinct bridge objects.
 */
export function settingsSnapshotCacheFor(owner: object): SettingsSnapshotCache {
  const existing = settingsSnapshotCaches.get(owner);
  if (existing) return existing;
  const cache = createSettingsSnapshotCache();
  settingsSnapshotCaches.set(owner, cache);
  return cache;
}
