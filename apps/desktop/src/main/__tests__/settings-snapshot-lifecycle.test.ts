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
  type PermissionCenterSnapshot,
} from '../../renderer/settings/settings-snapshot-cache.js';
import type { SettingsHostTarget } from '../../renderer/settings/runtime-host-settings-target.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

interface SnapshotPageProps<T> {
  initialSnapshot?: T;
  onSnapshot(key: string, snapshot: T): void;
}

let components: {
  HealthCenterPage: ComponentType<SnapshotPageProps<HealthSnapshot>>;
  PermissionCenterPage: ComponentType<SnapshotPageProps<PermissionCenterSnapshot>>;
  RuntimeHostSettingsTarget: ComponentType<{ host: SettingsHostTarget; children: ReactNode }>;
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

function setup(page: 'health' | 'permissions') {
  const { root } = installReactRenderer();
  const cache = createSettingsSnapshotCache();
  const first = pendingReads();
  const { health, permissions, capabilities } = first;
  const readsByHost = new Map([[runtimeHostSettingsKey(HOST_A), first]]);
  const readsFor = (host: SettingsHostTarget) => {
    const key = runtimeHostSettingsKey(host);
    if (!readsByHost.has(key)) readsByHost.set(key, pendingReads());
    return readsByHost.get(key)!;
  };
  const requests: SettingsHostTarget[] = [];
  Object.assign(window, {
    maka: {
      health: { getSnapshot: (host: SettingsHostTarget) => { requests.push(host); return readsFor(host).health.promise; } },
      permissions: { getSnapshot: (host: SettingsHostTarget) => { requests.push(host); return readsFor(host).permissions.promise; } },
      capabilities: { getSnapshot: (host: SettingsHostTarget) => readsFor(host).capabilities.promise },
    },
  });
  return {
    cache, health, permissions, capabilities, requests,
    read: (host: SettingsHostTarget) => page === 'health'
      ? cache.readRuntimeHostHealth(runtimeHostSettingsKey(host))
      : cache.readRuntimeHostPermissionCenter(runtimeHostSettingsKey(host)),
    async render(host?: SettingsHostTarget) {
      await act(async () => {
        root.render(host ? createElement(LocaleProvider, {
          locale: 'en',
          children: createElement(AstryxLocaleProvider, {
            children: createElement(ToastProvider, {
              children: createElement(components.RuntimeHostSettingsTarget, {
                host,
                key: runtimeHostSettingsKey(host),
                children: page === 'health'
                  ? createElement(components.HealthCenterPage, { onSnapshot: cache.commitRuntimeHostHealthRead })
                  : createElement(components.PermissionCenterPage, { onSnapshot: cache.commitRuntimeHostPermissionCenterRead }),
              }),
            }),
          }),
        }) : null);
      });
    },
    async finish() {
      await act(async () => {
        health.resolve(HEALTH);
        permissions.resolve(PERMISSIONS);
        capabilities.resolve(CAPABILITIES);
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
