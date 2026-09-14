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
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import { BOT_PROVIDERS, type BotProvider } from '@maka/core/bot-chat-settings';
import type { OsPermissionState } from '@maka/core/capabilities';
import { createDefaultSettings } from '@maka/core/settings';
import type { ComputerHistoryStatus } from '@maka/core/computer-history';
import type { BotStatus } from '@maka/runtime/bots';
import type { MakaBridge } from '../../preload/bridge-contract.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';

const NOW = 1_000;
const HISTORY: ComputerHistoryStatus = {
  platformSupported: true, helperAvailable: true, state: 'running',
  accessibilityGranted: true, inputMonitoringGranted: true,
  eventCount: 0, suppressedEventCount: 0, segmentCount: 0, summaryState: 'disabled',
  settings: {
    enabled: true, captureText: false, summariesEnabled: false, summaryTextEnabled: false,
    blockedApplications: [], blockedDomains: [],
  },
};
const botStatuses = Object.fromEntries(BOT_PROVIDERS.map((platform) => [
  platform, { platform, running: false, readiness: 'scaffolded', connection: 'none' },
])) as Record<BotProvider, BotStatus>;

test('unified snapshots retain Electron and collector AX truth and block denied collector capabilities', async () => {
  const { api } = await fixture();
  const snapshot = api.buildPermissionSnapshot(NOW, 'darwin', {
    accessibility: 'denied', inputMonitoring: 'granted',
  });
  assert.equal(snapshot.permissions.accessibility.status, 'granted');
  assert.equal(snapshot.permissions.accessibility.consumers?.activity_recorder?.status, 'denied');
  assert.equal(snapshot.permissions.input_monitoring.status, 'granted');
  const capabilities = api.buildCapabilitySnapshotCollection({
    settings: createDefaultSettings(), permissions: snapshot, botStatuses, computerHistory: HISTORY,
    computerUse: { backendId: 'none', health: { state: 'not_available', reason: 'cu_backend_unavailable' } },
  });
  const recorder = capabilities.capabilities.find((capability) => capability.id === 'activity_recorder')!;
  assert.equal(recorder.readiness, 'denied', 'even stale history granted cannot override collector denial');
  assert.deepEqual(structuredClone(recorder.osPermissions), [
    { id: 'accessibility', required: true, status: 'denied' },
    { id: 'input_monitoring', required: true, status: 'granted' },
  ]);
});

test('collector permission unknown/unsupported/denied remain distinct and screen denial does not block history', async () => {
  const { api } = await fixture();
  for (const [status, readiness] of [
    ['denied', 'denied'], ['unknown', 'not_configured'], ['unsupported', 'denied'], ['granted', 'enabled'],
  ] as const) {
    const snapshot = api.buildPermissionSnapshot(NOW, 'darwin', {
      accessibility: 'granted', inputMonitoring: status,
    });
    assert.equal(snapshot.permissions.screen_recording.status, 'denied');
    const recorder = api.buildCapabilitySnapshotCollection({
      settings: createDefaultSettings(), permissions: snapshot, botStatuses, computerHistory: HISTORY,
    }).capabilities.find((capability) => capability.id === 'activity_recorder')!;
    assert.equal(recorder.readiness, readiness);
  }
  const unknown = api.buildPermissionSnapshot(NOW, 'darwin');
  assert.equal(unknown.permissions.accessibility.status, 'granted');
  assert.equal(unknown.permissions.accessibility.consumers?.activity_recorder?.status, 'unknown');
  assert.equal(unknown.permissions.input_monitoring.status, 'unknown');
  const unsupported = api.buildPermissionSnapshot(NOW, 'linux');
  assert.equal(unsupported.permissions.input_monitoring.status, 'unsupported');
  assert.equal(unsupported.permissions.input_monitoring.canOpenSettings, false);
});

test('local permission IPC works without Host registration; single OS actions do not grant, capture or read history', async () => {
  const f = await fixture();
  const handlers = new Map<string, IpcHandler>();
  let probes = 0;
  f.api.registerLocalPermissionsIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    getComputerHistoryPermissions: async () => {
      probes += 1;
      return { accessibility: 'denied', inputMonitoring: 'denied' };
    },
  });
  assert.deepEqual([...handlers.keys()], [
    'permissions:getSnapshot', 'permissions:openSystemSettings', 'permissions:requestAccess',
  ]);
  const invoke = (channel: string, ...args: unknown[]) =>
    handlers.get(channel)!({} as Parameters<IpcHandler>[0], ...args);
  assert.equal((await invoke('permissions:getSnapshot')).permissions.input_monitoring.status, 'denied');
  for (const id of ['input_monitoring', 'accessibility']) {
    assert.equal((await invoke('permissions:requestAccess', id)).ok, true);
  }
  assert.equal(probes, 1, 'single actions must not probe/start Computer History');
  assert.equal(f.captures, 0, 'Input/AX requests must not enter screen capture consent');
  assert.deepEqual(f.opened, [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  ]);
  assert.equal((await invoke('permissions:getSnapshot')).permissions.input_monitoring.status, 'denied',
    'opening the pane is not a grant');
  assert.equal((await invoke('permissions:requestAccess', '../input_monitoring')).reason, 'invalid_id');
  f.failOpen = true;
  assert.equal((await invoke('permissions:openSystemSettings', 'input_monitoring')).reason, 'open_settings_failed');
  const linux = await fixture('linux');
  const unsupported = await linux.api.requestPermissionAccess('input_monitoring');
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.reason, 'unsupported_platform');
  assert.deepEqual(linux.opened, []);
});

test('bundled preload uses direct permission IPC even with an offline selected Host', async () => {
  const f = await fixture();
  const handlers = new Map<string, IpcHandler>();
  f.api.registerLocalPermissionsIpc({
    ipcMain: { handle: (channel, listener) => { handlers.set(channel, listener); } },
    getComputerHistoryPermissions: async () => ({ accessibility: 'denied', inputMonitoring: 'denied' }),
  });
  handlers.set('permissions:startDragOnboarding', async (_event, id) => {
    assert.equal(id, 'accessibility');
    return { ok: true };
  });
  const calls: string[] = [];
  let bridge!: MakaBridge;
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('../../../src/preload/preload.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', external: ['electron'],
  });
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    require: (id: string) => id === 'electron' ? {
      contextBridge: { exposeInMainWorld(name: string, value: MakaBridge) { if (name === 'maka') bridge = value; } },
      ipcRenderer: {
        on() {}, off() {}, send() {},
        async invoke(channel: string, ...args: unknown[]) {
          calls.push(channel);
          const handler = handlers.get(channel);
          if (!handler) throw new Error('Selected remote Host is offline');
          return handler({} as Parameters<IpcHandler>[0], ...args);
        },
      },
    } : require(id),
    process: { env: {} }, Buffer, console, setTimeout, clearTimeout, TextEncoder, TextDecoder,
    crypto: globalThis.crypto,
  });
  assert.equal((await bridge.permissions.getSnapshot()).permissions.input_monitoring.status, 'denied');
  await bridge.permissions.openSystemSettings('input_monitoring');
  await bridge.permissions.requestAccess('input_monitoring');
  await bridge.permissions.startDragOnboarding('accessibility');
  assert.deepEqual(calls, [
    'permissions:getSnapshot', 'permissions:openSystemSettings', 'permissions:requestAccess',
    'permissions:startDragOnboarding',
  ]);
  assert.equal('requestPermissions' in bridge.computerHistory, false);
  await assert.rejects(bridge.capabilities.getSnapshot(), /Host is offline/);
});

async function fixture(platform: NodeJS.Platform = 'darwin') {
  const f = { opened: [] as string[], failOpen: false, captures: 0 };
  const bundle = await build({
    stdin: {
      contents: `
        export * from './capability-snapshot.js';
        export * from './permissions-actions.js';
        export * from './runtime-host-permissions-ipc-main.js';
      `,
      resolveDir: fileURLToPath(new URL('../../../src/main', import.meta.url)),
    },
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  });
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  runInNewContext(bundle.outputFiles[0]!.text, {
    module, exports: module.exports,
    require: (id: string) => id === 'electron' ? {
      Notification: { isSupported: () => false },
      systemPreferences: {
        isTrustedAccessibilityClient(prompt: boolean) { assert.equal(prompt, false); return true; },
        getMediaAccessStatus: () => 'denied' satisfies OsPermissionState,
      },
      desktopCapturer: { getSources() { f.captures += 1; throw new Error('Unexpected capture'); } },
      shell: { async openExternal(url: string) {
        if (f.failOpen) throw new Error('Synthetic settings failure');
        f.opened.push(url);
      } },
    } : require(id),
    process: { platform, env: {} }, console,
  });
  return Object.assign(f, {
    api: module.exports as typeof import('../capability-snapshot.js') &
      typeof import('../permissions-actions.js') & typeof import('../runtime-host-permissions-ipc-main.js'),
  });
}
