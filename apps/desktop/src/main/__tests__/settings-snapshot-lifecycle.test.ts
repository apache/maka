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

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import type { HealthSnapshot } from '@maka/core/health';
import {
  OS_PERMISSION_IDS,
  type CapabilitySnapshotCollection,
  type PermissionSnapshot,
} from '@maka/core/capabilities';
import {
  createSettingsSnapshotCache,
  runtimeHostSettingsKey,
  type SettingsSnapshotCache,
} from '../../renderer/settings/settings-snapshot-cache.js';
import { runtimeHostSettingsGenerationKey, type SettingsHostTarget } from '../../renderer/settings/runtime-host-settings-target.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

let components: {
  HealthCenterPage: ComponentType<{ snapshotCache: SettingsSnapshotCache }>;
  PermissionCenterPage: ComponentType<{ snapshotCache: SettingsSnapshotCache }>;
  RuntimeHostSettingsTarget: ComponentType<{ host: SettingsHostTarget; generation?: string; children: ReactNode }>;
};
let bundleDirectory: string;

before(async () => {
  const repoRoot = resolve(import.meta.dirname, '../../../../..');
  bundleDirectory = await mkdtemp(resolve(repoRoot, 'apps/desktop/dist/main/__tests__/snapshot-lifecycle-'));
  const outfile = resolve(bundleDirectory, 'components.mjs');
  // Resolve the production pages' extensionless imports without replacing their effects.
  await build({
    stdin: {
      contents: [
        "export { HealthCenterPage } from './health-center-page';",
        "export { PermissionCenterPage } from './permission-center-page';",
        "export { RuntimeHostSettingsTarget } from './runtime-host-settings-target';",
      ].join('\n'),
      resolveDir: resolve(repoRoot, 'apps/desktop/src/renderer/settings'),
    },
    outfile,
    bundle: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    target: 'node20',
    logLevel: 'silent',
  });
  components = await import(pathToFileURL(outfile).href);
});

afterEach(cleanupFakeDom);
after(async () => {
  if (bundleDirectory) await rm(bundleDirectory, { recursive: true, force: true });
});

const HOST_A = { profileId: 'local', hostId: 'host-a' };
const HOST_B = { profileId: 'remote', hostId: 'host-b' };
const HEALTH: HealthSnapshot = {
  checkedAt: 101,
  signals: [],
  summary: { ok: 0, info: 0, warning: 0, error: 0, unknown: 0 },
};
const PERMISSIONS: PermissionSnapshot = {
  checkedAt: 102,
  platform: 'darwin',
  permissions: Object.fromEntries(OS_PERMISSION_IDS.map((id) => [id, {
    id, status: 'granted', source: 'electron', checkedAt: 102,
    canRequest: false, canOpenSettings: true,
  }])) as PermissionSnapshot['permissions'],
};
const CAPABILITIES: CapabilitySnapshotCollection = { checkedAt: 103, capabilities: [] };
const PERMISSION_CENTER = { permissions: PERMISSIONS, capabilities: CAPABILITIES };

function pendingReads() {
  return {
    health: deferred<HealthSnapshot>(),
    permissions: deferred<PermissionSnapshot>(),
    capabilities: deferred<CapabilitySnapshotCollection>(),
  };
}

function snapshots(version = 0) {
  return {
    health: { ...HEALTH, checkedAt: HEALTH.checkedAt + version },
    permissions: { ...PERMISSIONS, checkedAt: PERMISSIONS.checkedAt + version },
    capabilities: { ...CAPABILITIES, checkedAt: CAPABILITIES.checkedAt + version },
  };
}

function expectedSnapshot(page: 'health' | 'permissions', version = 0) {
  const { health, permissions, capabilities } = snapshots(version);
  return page === 'health' ? health : { permissions, capabilities };
}

function setup(page: 'health' | 'permissions') {
  const { root, container } = installReactRenderer();
  const cache = createSettingsSnapshotCache();
  const first = pendingReads();
  const { health, permissions, capabilities } = first;
  const batches = [first];
  const readsAt = (index: number) => {
    batches[index] ??= pendingReads();
    return batches[index];
  };
  let healthReads = 0;
  let permissionReads = 0;
  let capabilityReads = 0;
  const requests: SettingsHostTarget[] = [];
  Object.assign(window, {
    maka: {
      health: { getSnapshot: (host: SettingsHostTarget) => { requests.push(host); return readsAt(healthReads++).health.promise; } },
      permissions: { getSnapshot: (host: SettingsHostTarget) => { requests.push(host); return readsAt(permissionReads++).permissions.promise; } },
      capabilities: { getSnapshot: () => readsAt(capabilityReads++).capabilities.promise },
    },
  });
  return {
    cache, health, permissions, capabilities, requests,
    content: () => container.textContent,
    read: (host: SettingsHostTarget, generation = 'epoch-1') => {
      const target = { hostKey: runtimeHostSettingsKey(host), generationKey: runtimeHostSettingsGenerationKey(host, generation) };
      return page === 'health'
        ? cache.readRuntimeHostHealth(target)
        : cache.readRuntimeHostPermissionCenter(target);
    },
    async render(host?: SettingsHostTarget, generation = 'epoch-1') {
      await act(async () => {
        root.render(host ? createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(AstryxLocaleProvider, {
            children: createElement(ToastProvider, {
              children: createElement(components.RuntimeHostSettingsTarget, {
                host,
                generation,
                key: runtimeHostSettingsKey(host),
                children: page === 'health'
                  ? createElement(components.HealthCenterPage, { snapshotCache: cache })
                  : createElement(components.PermissionCenterPage, { snapshotCache: cache }),
              }),
            }),
          }),
        }) : null);
      });
    },
    async finish(index = 0, version = 0) {
      const reads = readsAt(index);
      const result = snapshots(version);
      await act(async () => {
        reads.health.resolve(result.health);
        reads.permissions.resolve(result.permissions);
        reads.capabilities.resolve(result.capabilities);
      });
    },
  };
}

for (const page of ['health', 'permissions'] as const) {
  for (const nextHost of [undefined, HOST_B]) {
    test(`${page}: a successful read after ${nextHost ? 'Host switch' : 'page unmount'} warms the original Host cache`, async () => {
      const harness = setup(page);
      await harness.render(HOST_A);
      assert.deepEqual(harness.requests, [HOST_A]);
      await harness.render(nextHost);
      assert.deepEqual(harness.requests, nextHost ? [HOST_A, nextHost] : [HOST_A]);
      await harness.finish();

      assert.deepEqual(harness.read(HOST_A), page === 'health' ? HEALTH : PERMISSION_CENTER);
      assert.equal(harness.read(HOST_B), undefined);
    });
  }

  test(`${page}: a same-key epoch change retires the pending page read without a readiness dip`, async () => {
    const harness = setup(page);
    await harness.render(HOST_A, 'epoch-1');
    await harness.render(HOST_A, 'epoch-2');
    assert.deepEqual(harness.requests, [HOST_A, HOST_A]);
    await harness.render();
    await harness.finish(1, 1);
    await harness.finish(0);

    assert.equal(harness.read(HOST_A, 'epoch-1'), undefined);
    assert.deepEqual(harness.read(HOST_A, 'epoch-2'), expectedSnapshot(page, 1));
  });

  test(`${page}: a reconnect cannot seed the new page from the previous incarnation`, async () => {
    const harness = setup(page);
    await harness.render(HOST_A, 'epoch-1');
    await harness.render();
    await harness.finish();
    assert.deepEqual(harness.read(HOST_A, 'epoch-1'), expectedSnapshot(page));

    await harness.render(HOST_A, 'epoch-2');
    assert.equal(harness.read(HOST_A, 'epoch-2'), undefined);
    await harness.render();
    await harness.finish(1, 1);
    assert.deepEqual(harness.read(HOST_A, 'epoch-2'), expectedSnapshot(page, 1));
  });

  test(`${page}: a same-key epoch change clears the displayed snapshot before the new read finishes`, async () => {
    const harness = setup(page);
    await harness.render(HOST_A, 'epoch-1');
    await harness.finish();
    assert.notEqual(harness.content(), '', 'the first incarnation has rendered its snapshot');

    await harness.render(HOST_A, 'epoch-2');
    assert.equal(harness.content(), '', 'only the loading skeleton remains for the new incarnation');
    assert.deepEqual(harness.requests, [HOST_A, HOST_A]);
  });

  test(`${page}: a slow unmounted read cannot overwrite a newer completed read`, async () => {
    const harness = setup(page);
    await harness.render(HOST_A);
    await harness.render();
    await harness.render(HOST_A);
    await harness.render();
    await harness.finish(1, 1);
    await harness.finish(0);
    assert.deepEqual(harness.read(HOST_A), expectedSnapshot(page, 1));
  });
}

test('permissions: unmounting between the two snapshot results only caches a complete pair', async () => {
  const harness = setup('permissions');
  await harness.render(HOST_A);
  await act(async () => harness.permissions.resolve(PERMISSIONS));
  await harness.render();
  assert.equal(harness.read(HOST_A), undefined);

  await act(async () => harness.capabilities.resolve(CAPABILITIES));
  assert.deepEqual(harness.read(HOST_A), PERMISSION_CENTER);
});

for (const failedRead of ['health', 'permissions', 'capabilities'] as const) {
  test(`${failedRead}: a failed read after unmount does not write a snapshot`, async () => {
    const harness = setup(failedRead === 'health' ? 'health' : 'permissions');
    await harness.render(HOST_A);
    await harness.render();
    await act(async () => {
      harness[failedRead].reject(new Error('offline'));
      if (failedRead === 'permissions') harness.capabilities.resolve(CAPABILITIES);
      if (failedRead === 'capabilities') harness.permissions.resolve(PERMISSIONS);
    });
    assert.equal(harness.read(HOST_A), undefined);
  });
}
