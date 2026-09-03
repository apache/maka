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

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  createDefaultSettings,
  type RuntimeHostAppSettings,
} from '@maka/core/settings';
import {
  beginSettingsResourceLoad,
  completeSettingsResourceLoad,
  createSettingsResourceState,
  failSettingsResourceLoad,
  invalidateSettingsResourceGeneration,
  reconcileRuntimeHostProfileSelection,
  settingsResourceSnapshot,
  settingsResourceStatus,
} from '../../renderer/settings/settings-resource-state.js';
import {
  createSettingsSnapshotCache,
  settingsSnapshotCacheFor,
} from '../../renderer/settings/settings-snapshot-cache.js';
import type { DesktopRuntimeHostProfileSnapshot } from '../../preload/bridge-contract.js';
import { createSettingsRequestAuthority } from '../../renderer/settings/settings-request-authority.js';

const LOCAL_KEY = 'local:host-local-1';
const REMOTE_KEY = 'remote:host-remote-1';

function runtimeHostSettings(): RuntimeHostAppSettings {
  const settings = createDefaultSettings();
  return {
    ...settings,
    network: {
      proxy: {
        ...settings.network.proxy,
        passwordConfigured: false,
      },
    },
  };
}

function catalog(entries: DesktopRuntimeHostProfileSnapshot['entries']): DesktopRuntimeHostProfileSnapshot {
  return {
    defaultProfileId: 'local',
    entries,
  };
}

describe('Settings resource state', () => {
  it('keeps a last-ready snapshot visible while it revalidates', () => {
    const snapshot = { value: 'ready' };
    const ready = completeSettingsResourceLoad(LOCAL_KEY, snapshot);

    const loading = beginSettingsResourceLoad(ready, LOCAL_KEY);

    assert.equal(loading.phase, 'loading');
    assert.equal(settingsResourceSnapshot(loading, LOCAL_KEY), snapshot);
    assert.deepEqual(settingsResourceStatus(loading, LOCAL_KEY), {
      phase: 'loading',
      hasSnapshot: true,
      isVerified: true,
      message: undefined,
    });
  });

  it('retains the snapshot and records a failed refresh', () => {
    const snapshot = { value: 'ready' };
    const loading = beginSettingsResourceLoad(
      completeSettingsResourceLoad(LOCAL_KEY, snapshot),
      LOCAL_KEY,
    );

    const failed = failSettingsResourceLoad(loading, LOCAL_KEY, 'offline');

    assert.equal(settingsResourceSnapshot(failed, LOCAL_KEY), snapshot);
    assert.deepEqual(settingsResourceStatus(failed, LOCAL_KEY), {
      phase: 'error',
      hasSnapshot: true,
      isVerified: true,
      message: 'offline',
    });
  });

  it('keeps a previous-generation snapshot visible without keeping its authority', () => {
    const snapshot = { value: 'ready' };
    const invalidated = invalidateSettingsResourceGeneration(
      completeSettingsResourceLoad(LOCAL_KEY, snapshot),
    );

    assert.equal(settingsResourceSnapshot(invalidated, LOCAL_KEY), snapshot);
    assert.deepEqual(settingsResourceStatus(invalidated, LOCAL_KEY), {
      phase: 'loading',
      hasSnapshot: true,
      isVerified: false,
      message: undefined,
    });

    const failed = failSettingsResourceLoad(
      beginSettingsResourceLoad(invalidated, LOCAL_KEY),
      LOCAL_KEY,
      'replacement offline',
    );
    assert.equal(settingsResourceSnapshot(failed, LOCAL_KEY), snapshot);
    assert.equal(settingsResourceStatus(failed, LOCAL_KEY).isVerified, false);
  });

  it('never exposes one Runtime Host snapshot through another Host key', () => {
    const local = completeSettingsResourceLoad(LOCAL_KEY, { value: 'local' });

    assert.equal(settingsResourceSnapshot(local, REMOTE_KEY), undefined);
    assert.deepEqual(settingsResourceStatus(local, REMOTE_KEY), {
      phase: 'idle',
      hasSnapshot: false,
      isVerified: false,
    });
  });

  it('seeds a cold load from a matching cached snapshot', () => {
    const cached = { value: 'cached' };

    const loading = beginSettingsResourceLoad(
      createSettingsResourceState(),
      LOCAL_KEY,
      cached,
    );

    assert.equal(settingsResourceSnapshot(loading, LOCAL_KEY), cached);
    assert.equal(settingsResourceStatus(loading, LOCAL_KEY).hasSnapshot, true);
    assert.equal(settingsResourceStatus(loading, LOCAL_KEY).isVerified, false);
  });

  it('keeps an initially cached snapshot read-only when validation fails', () => {
    const cached = { value: 'cached' };
    const loading = beginSettingsResourceLoad(
      createSettingsResourceState(LOCAL_KEY, cached),
      LOCAL_KEY,
      cached,
    );

    const failed = failSettingsResourceLoad(loading, LOCAL_KEY, 'offline', cached);

    assert.equal(settingsResourceSnapshot(failed, LOCAL_KEY), cached);
    assert.deepEqual(settingsResourceStatus(failed, LOCAL_KEY), {
      phase: 'error',
      hasSnapshot: true,
      isVerified: false,
      message: 'offline',
    });
  });

  it('uses a fresh default over a cached bootstrap selection', () => {
    assert.equal(
      reconcileRuntimeHostProfileSelection({
        currentProfileId: 'cached-default',
        defaultProfileId: 'fresh-default',
        enabledProfileIds: ['cached-default', 'fresh-default'],
        preserveCurrentSelection: false,
      }),
      'fresh-default',
    );
  });

  it('preserves an explicit valid selection after hydration', () => {
    assert.equal(
      reconcileRuntimeHostProfileSelection({
        currentProfileId: 'remote',
        defaultProfileId: 'local',
        enabledProfileIds: ['local', 'remote'],
        preserveCurrentSelection: true,
      }),
      'remote',
    );
  });
});

describe('Settings snapshot cache', () => {
  it('reuses masked read snapshots for the same renderer bridge identity only', () => {
    const firstBridge = {};
    const secondBridge = {};
    const clientSettings = createDefaultSettings();

    settingsSnapshotCacheFor(firstBridge).commitClientRead(clientSettings);

    assert.equal(settingsSnapshotCacheFor(firstBridge).readClient(), clientSettings);
    assert.equal(settingsSnapshotCacheFor(secondBridge).readClient(), undefined);
  });

  it('isolates settings and connections by selected Runtime Host key', () => {
    const cache = createSettingsSnapshotCache();
    const localSettings = runtimeHostSettings();
    const remoteSettings = {
      ...runtimeHostSettings(),
      personalization: {
        ...createDefaultSettings().personalization,
        displayName: 'Remote Host',
      },
    };
    const localConnections = { connections: [], defaultSlug: 'local-default' };

    cache.commitRuntimeHostSettingsRead(LOCAL_KEY, localSettings);
    cache.commitRuntimeHostSettingsRead(REMOTE_KEY, remoteSettings);
    cache.commitRuntimeHostConnectionsRead(LOCAL_KEY, localConnections);

    assert.equal(cache.readRuntimeHostSettings(LOCAL_KEY), localSettings);
    assert.equal(cache.readRuntimeHostSettings(REMOTE_KEY), remoteSettings);
    assert.equal(cache.readRuntimeHostConnections(LOCAL_KEY), localConnections);
    assert.equal(cache.readRuntimeHostConnections(REMOTE_KEY), undefined);
  });

  it('prunes snapshots when a profile reconnects with a new host id', () => {
    const cache = createSettingsSnapshotCache();
    cache.commitRuntimeHostSettingsRead(LOCAL_KEY, runtimeHostSettings());
    cache.commitRuntimeHostConnectionsRead(LOCAL_KEY, {
      connections: [],
      defaultSlug: null,
    });

    cache.commitRuntimeHostCatalogRead(catalog([
      {
        profile: { id: 'local', name: 'Local', kind: 'local' },
        enabled: true,
        isDefault: true,
        readiness: 'ready',
        hostId: 'host-local-2',
      },
    ]));

    assert.equal(cache.readRuntimeHostSettings(LOCAL_KEY), undefined);
    assert.equal(cache.readRuntimeHostConnections(LOCAL_KEY), undefined);
  });

  it('stores settings and connection reads independently', () => {
    const cache = createSettingsSnapshotCache();
    const settings = runtimeHostSettings();
    cache.commitRuntimeHostSettingsRead(LOCAL_KEY, settings);

    assert.equal(cache.readRuntimeHostSettings(LOCAL_KEY), settings);
    assert.equal(cache.readRuntimeHostConnections(LOCAL_KEY), undefined);

    const connections = { connections: [], defaultSlug: null };
    cache.commitRuntimeHostConnectionsRead(LOCAL_KEY, connections);

    assert.equal(cache.readRuntimeHostSettings(LOCAL_KEY), settings);
    assert.equal(cache.readRuntimeHostConnections(LOCAL_KEY), connections);
  });
});

describe('Settings Runtime Host request authority', () => {
  it('invalidates reads without discarding a same-Host mutation', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY);
    const settingsRead = authority.beginSettingsRead(LOCAL_KEY);
    const connectionsRead = authority.beginConnectionsRead(LOCAL_KEY);
    const settingsWrite = authority.beginSettingsWrite(LOCAL_KEY);
    assert.ok(settingsRead);
    assert.ok(connectionsRead);
    assert.ok(settingsWrite);

    authority.invalidateReads();

    assert.equal(authority.acceptsSettingsRead(settingsRead), false);
    assert.equal(authority.acceptsConnectionsRead(connectionsRead), false);
    assert.equal(authority.acceptsSettingsWrite(settingsWrite), true);
  });

  it('rejects every in-flight operation synchronously when the selected Host changes', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY);
    const settingsRead = authority.beginSettingsRead(LOCAL_KEY);
    const connectionsRead = authority.beginConnectionsRead(LOCAL_KEY);
    const settingsWrite = authority.beginSettingsWrite(LOCAL_KEY);
    assert.ok(settingsRead);
    assert.ok(connectionsRead);
    assert.ok(settingsWrite);

    authority.selectTarget(REMOTE_KEY);

    assert.equal(authority.acceptsSettingsRead(settingsRead), false);
    assert.equal(authority.acceptsConnectionsRead(connectionsRead), false);
    assert.equal(authority.acceptsSettingsWrite(settingsWrite), false);
  });

  it('rejects every in-flight operation when the same Host key enters a new epoch', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY, 'epoch-1');
    const settingsRead = authority.beginSettingsRead(LOCAL_KEY);
    const connectionsRead = authority.beginConnectionsRead(LOCAL_KEY);
    const settingsWrite = authority.beginSettingsWrite(LOCAL_KEY);
    assert.ok(settingsRead);
    assert.ok(connectionsRead);
    assert.ok(settingsWrite);

    assert.equal(authority.selectTarget(LOCAL_KEY, 'epoch-2'), true);

    assert.equal(authority.acceptsSettingsRead(settingsRead), false);
    assert.equal(authority.acceptsConnectionsRead(connectionsRead), false);
    assert.equal(authority.acceptsSettingsWrite(settingsWrite), false);
    assert.equal(authority.isCurrentTarget(settingsWrite), false);
  });

  it('does not revoke tickets for a repeated observation of the same Host epoch', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY, 'epoch-1');
    const settingsRead = authority.beginSettingsRead(LOCAL_KEY);
    const settingsWrite = authority.beginSettingsWrite(LOCAL_KEY);
    assert.ok(settingsRead);
    assert.ok(settingsWrite);

    assert.equal(authority.selectTarget(LOCAL_KEY, 'epoch-1'), false);

    assert.equal(authority.acceptsSettingsRead(settingsRead), true);
    assert.equal(authority.acceptsSettingsWrite(settingsWrite), true);
  });

  it('rejects an in-flight write while the same Host epoch reconnects', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY, 'epoch-1');
    const settingsWrite = authority.beginSettingsWrite(LOCAL_KEY);
    assert.ok(settingsWrite);

    assert.equal(authority.selectTarget(undefined, 'epoch-1'), true);

    assert.equal(authority.acceptsSettingsWrite(settingsWrite), false);
    assert.equal(authority.isCurrentTarget(settingsWrite), false);
  });

  it('keeps only the latest mutation for one Host', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY);
    const first = authority.beginSettingsWrite(LOCAL_KEY);
    const second = authority.beginSettingsWrite(LOCAL_KEY);
    assert.ok(first);
    assert.ok(second);

    assert.equal(authority.acceptsSettingsWrite(first), false);
    assert.equal(authority.acceptsSettingsWrite(second), true);
  });

  it('refuses to start a delayed mutation for a no-longer-selected Host', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY);

    authority.selectTarget(REMOTE_KEY);

    assert.equal(authority.beginSettingsWrite(LOCAL_KEY), undefined);
    assert.notEqual(authority.beginSettingsWrite(REMOTE_KEY), undefined);
  });

  it('does not let a delayed old-Host read invalidate the current Host reads', () => {
    const authority = createSettingsRequestAuthority(LOCAL_KEY);
    authority.selectTarget(REMOTE_KEY);
    const settingsRead = authority.beginSettingsRead(REMOTE_KEY);
    const connectionsRead = authority.beginConnectionsRead(REMOTE_KEY);
    assert.ok(settingsRead);
    assert.ok(connectionsRead);

    assert.equal(authority.beginSettingsRead(LOCAL_KEY), undefined);
    assert.equal(authority.beginConnectionsRead(LOCAL_KEY), undefined);
    assert.equal(authority.acceptsSettingsRead(settingsRead), true);
    assert.equal(authority.acceptsConnectionsRead(connectionsRead), true);
  });
});
