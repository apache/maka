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

import type { AppSettings, RuntimeHostAppSettings } from '@maka/core/settings';
import type { ProjectedLlmConnection } from '@maka/core/llm-connections';
import type {
  CapabilitySnapshotCollection,
  PermissionSnapshot,
} from '@maka/core/capabilities';
import type { HealthSnapshot } from '@maka/core/health';
import type { DesktopRuntimeHostProfileSnapshot } from '../../preload/bridge-contract.js';
import { runtimeHostSettingsKey } from '../application/contracts/settings-presentation/runtime-host-settings-target.js';

export { runtimeHostSettingsKey };

export interface RuntimeHostConnectionsSnapshot {
  readonly connections: ProjectedLlmConnection[];
  readonly defaultSlug: string | null;
}

export interface PermissionCenterSnapshot {
  readonly permissions: PermissionSnapshot;
  readonly capabilities: CapabilitySnapshotCollection;
}

export interface SettingsSnapshotTarget {
  readonly hostKey: string;
  readonly generationKey: string;
}

export interface SettingsSnapshotCache {
  readClient(): AppSettings | undefined;
  commitClientRead(snapshot: AppSettings): void;

  readRuntimeHostCatalog(): DesktopRuntimeHostProfileSnapshot | undefined;
  commitRuntimeHostCatalogRead(snapshot: DesktopRuntimeHostProfileSnapshot): void;

  readRuntimeHostSettings(key: string): RuntimeHostAppSettings | undefined;
  commitRuntimeHostSettingsRead(key: string, snapshot: RuntimeHostAppSettings): void;

  readRuntimeHostConnections(key: string): RuntimeHostConnectionsSnapshot | undefined;
  commitRuntimeHostConnectionsRead(
    key: string,
    snapshot: RuntimeHostConnectionsSnapshot,
  ): void;

  readRuntimeHostHealth(target: SettingsSnapshotTarget): HealthSnapshot | undefined;
  beginRuntimeHostHealthRead(target: SettingsSnapshotTarget): (snapshot: HealthSnapshot) => void;

  readRuntimeHostPermissionCenter(target: SettingsSnapshotTarget): PermissionCenterSnapshot | undefined;
  beginRuntimeHostPermissionCenterRead(target: SettingsSnapshotTarget): (snapshot: PermissionCenterSnapshot) => void;
}

/** One incarnation per Host, with a commit authority that survives page unmounts. */
function createHostSnapshotCache<T>() {
  const entries = new Map<string, {
    generationKey: string;
    snapshot?: T;
    latestRead?: object;
  }>();
  return {
    read(target: SettingsSnapshotTarget): T | undefined {
      const entry = entries.get(target.hostKey);
      return entry?.generationKey === target.generationKey ? entry.snapshot : undefined;
    },
    beginRead(target: SettingsSnapshotTarget): (snapshot: T) => void {
      const previous = entries.get(target.hostKey);
      const entry = previous?.generationKey === target.generationKey
        ? previous
        : { generationKey: target.generationKey, snapshot: undefined, latestRead: undefined };
      const read = {};
      entry.latestRead = read;
      entries.set(target.hostKey, entry);
      return (snapshot) => {
        if (entries.get(target.hostKey) === entry && entry.latestRead === read) {
          entry.snapshot = snapshot;
        }
      };
    },
    prune(currentHostKeys: ReadonlySet<string>): void {
      for (const key of entries.keys()) {
        if (!currentHostKeys.has(key)) entries.delete(key);
      }
    },
  };
}

/**
 * Renderer-memory cache for successful Settings reads. It deliberately has no
 * method that accepts a settings mutation response: update responses may
 * reveal the just-submitted secret, while subsequent GETs are masked again.
 */
export function createSettingsSnapshotCache(): SettingsSnapshotCache {
  let client: AppSettings | undefined;
  let runtimeHostCatalog: DesktopRuntimeHostProfileSnapshot | undefined;
  const runtimeHostSettings = new Map<string, RuntimeHostAppSettings>();
  const runtimeHostConnections = new Map<string, RuntimeHostConnectionsSnapshot>();
  const runtimeHostHealth = createHostSnapshotCache<HealthSnapshot>();
  const runtimeHostPermissionCenter = createHostSnapshotCache<PermissionCenterSnapshot>();

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
      runtimeHostHealth.prune(currentHostKeys);
      runtimeHostPermissionCenter.prune(currentHostKeys);
    },
    readRuntimeHostSettings: (key) => runtimeHostSettings.get(key),
    commitRuntimeHostSettingsRead: (key, snapshot) => {
      runtimeHostSettings.set(key, snapshot);
    },
    readRuntimeHostConnections: (key) => runtimeHostConnections.get(key),
    commitRuntimeHostConnectionsRead: (key, snapshot) => {
      runtimeHostConnections.set(key, snapshot);
    },
    readRuntimeHostHealth: runtimeHostHealth.read,
    beginRuntimeHostHealthRead: runtimeHostHealth.beginRead,
    readRuntimeHostPermissionCenter: runtimeHostPermissionCenter.read,
    beginRuntimeHostPermissionCenterRead: runtimeHostPermissionCenter.beginRead,
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
