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
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { BOT_PROVIDERS } from '@maka/core/bot-chat-settings';
import { deferred } from '@maka/core/test-only/async-primitives';
import { build } from 'esbuild';

test('capability and health IPC complete while overlapping permission reads wait on one native query', { timeout: 10_000 }, async () => {
  const native = deferred<number>();
  const started = deferred<void>();
  let nativeCalls = 0;
  let status = 'denied';
  const require = createRequire(import.meta.url);
  const requireModule = (id: string): unknown => {
    if (id === 'node:module') return { createRequire: () => requireModule };
    if (id === '../native/notification-settings.node') return {
      getAuthorizationStatus() {
        nativeCalls++;
        started.resolve();
        return native.promise;
      },
    };
    if (id === 'electron') return {
      Notification: { isSupported: () => true },
      systemPreferences: {
        isTrustedAccessibilityClient: () => status === 'granted',
        getMediaAccessStatus: () => status,
      },
    };
    return require(id);
  };
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/main/runtime-host-permissions-ipc-main.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    define: { 'import.meta.url': JSON.stringify(import.meta.url) },
  });
  const module = { exports: {} as typeof import('../runtime-host-permissions-ipc-main.js') };
  runInNewContext(bundle.outputFiles[0]!.text, {
    module, exports: module.exports, require: requireModule,
    process: { type: 'browser', platform: 'darwin', env: {} },
  });
  type Handler = (...args: unknown[]) => unknown;
  const handlers = new Map<string, Handler>();
  const channels = Object.fromEntries(BOT_PROVIDERS.map(provider => [provider, {
    token: '', enabled: false,
  }]));
  const botStatuses = Object.fromEntries(BOT_PROVIDERS.map(provider => [provider, {
    readiness: 'not_configured',
  }]));
  module.exports.registerRuntimeHostPermissionsIpc({
    ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
    client: {},
    getSettings: async () => ({ botChat: { channels } }),
    listConnections: async () => [],
    botRegistry: { allStatuses: () => botStatuses },
    getComputerUseCapabilityInput: () => ({
      backendId: 'none', health: { state: 'not_available' },
    }),
  } as unknown as Parameters<typeof module.exports.registerRuntimeHostPermissionsIpc>[0]);
  const invoke = (channel: string) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler();
  };
  let completed = 0;
  const pending = Array.from({ length: 8 }, () =>
    Promise.resolve(invoke('permissions:getSnapshot')).then(result => {
      completed++;
      return result as { permissions: { notifications: { status: string } } };
    }));
  try {
    await started.promise;
    const capabilities = await invoke('capabilities:getSnapshot') as {
      capabilities: { id: string; osPermissions: { status: string }[] }[];
    };
    const computer = capabilities.capabilities.find(item => item.id === 'computer_use');
    assert.ok(computer);
    assert.ok(computer.osPermissions.every(permission => permission.status !== 'granted'));
    assert.ok(await invoke('health:getSnapshot'));
    assert.equal(completed, 0, 'unrelated reads must finish before the native callback');
    assert.equal(nativeCalls, 1);

    status = 'granted';
    const refreshed = await invoke('capabilities:getSnapshot') as typeof capabilities;
    assert.ok(refreshed.capabilities.find(item => item.id === 'computer_use')
      ?.osPermissions.every(permission => permission.status === 'granted'));
    assert.equal(nativeCalls, 1, 'capability refresh must not start another notification query');
  } finally {
    native.resolve(1);
  }
  for (const result of await Promise.all(pending)) {
    assert.equal(result.permissions.notifications.status, 'denied');
  }
});
