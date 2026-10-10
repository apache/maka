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
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import fs, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from '@babel/parser';
import { transform } from 'esbuild';
import type { MessageBoxOptions } from 'electron';
import type { AppSettings } from '@maka/core/settings';
import { resolveSystemUiLocale } from '@maka/core/ui-locale';
import { createSettingsStore, SettingsRecoveryCommitUnknownError } from '@maka/storage/settings-store';
import { createAppQuitCoordinator, type AppQuitCoordinatorDeps } from '../app-quit-coordinator.js';
import { createSettingsRecoveryReporter } from '../settings-recovery.js';
import { createWindowRevealGate } from '../window-reveal.js';

const require = createRequire(import.meta.url);
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const source = readFileSync(new URL('../../../src/main/early-window.ts', import.meta.url), 'utf8');
const imports = parse(source, { sourceType: 'module', plugins: ['typescript'] }).program.body
  .filter((node) => node.type === 'ImportDeclaration');
const importEnd = imports.at(-1)?.end ?? 0;
const body = source.slice(importEnd).replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/gu, '');
const boot = (await transform(`${source.slice(0, importEnd)}\nexport default async function() {\n${body}\n}`, {
  loader: 'ts', format: 'cjs', target: 'esnext',
})).code;

for (const nativeFailure of ['unsupported', 'failed', 'commit-unknown'] as const) {
  test(`early-window presents recovery guidance despite ${nativeFailure}`, {
    timeout: 5_000, skip: nativeFailure === 'commit-unknown' && process.platform === 'win32',
  }, async (t) => {
    const userData = await mkdtemp(join(tmpdir(), 'maka-recovery-window-'));
    t.after(async () => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(userData, { recursive: true, force: true });
    });
    const root = join(userData, 'workspaces', 'default');
    await mkdir(root, { recursive: true });
    const settingsPath = join(root, 'settings.json');
    await writeFile(settingsPath, 'sk-live-SECRET');
    if (nativeFailure === 'commit-unknown') {
      const originalOpen = fs.open;
      let directorySyncs = 0;
      t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === root && ++directorySyncs === 2) {
          t.mock.method(handle, 'sync', async () => { throw new Error('injected publication fence failure'); });
        }
        return handle;
      });
      syncBuiltinESMExports();
    }
    const window = Object.assign(new EventEmitter(), {
      isVisible: () => visible,
      isMinimized: () => false,
      isDestroyed: () => false,
    });
    let visible = false;
    let constructed = false;
    let windowLaunch: Promise<void> | undefined;
    let windowError: unknown;
    const dialogs: MessageBoxOptions[] = [];
    let resolveShown!: () => void;
    const shown = new Promise<void>((resolve) => { resolveShown = resolve; });
    const logs: string[] = [];
    let banners = 0;
    const deps = {
      app: {
        isPackaged: true,
        getAppPath: () => '/test/Maka.app',
        getPath: () => userData,
        getPreferredSystemLanguages: () => ['en-US'],
        on: () => undefined,
      },
      ipcMain: { handle: () => undefined },
      nativeTheme: { shouldUseDarkColors: false },
      Notification: { isSupported: () => nativeFailure === 'failed' },
      showNativeNotification: (_copy: unknown, _focus: unknown, failed: () => void) => { banners += 1; failed(); },
      isIsolatedE2e: false,
      revealMode: 'active',
      resolveSystemUiLocale,
      resolveShellEnv: async () => undefined,
      resolveBuildInfo: () => ({ mode: 'packaged' }),
      resolveE2eFixture: () => undefined,
      resolveDesktopStorageRoot: async () => ({ canonicalPath: root }),
      startupStep: (_name: string, work: Promise<unknown>) => work,
      createSettingsRecoveryReporter,
      createSettingsStore,
      createDesktopLocaleAuthority: () => ({ current: () => 'en', observe: () => 'en' }),
      isDarkAppearance: () => false,
      bootContext: {},
      createMainWindowController: (options: {
        settingsStore: { get(): Promise<AppSettings> };
        onWindowConstructed(): void;
      }) => ({
        browserWindow: () => constructed ? window : undefined,
        hasOpenWindows: () => constructed,
        createWindow: async () => {
          // The real controller reads settings before creating BrowserWindow.
          await options.settingsStore.get();
          constructed = true;
          options.onWindowConstructed();
        },
      }),
      createAppQuitCoordinator: (options: {
        focusOrCreateWindow(signal: AbortSignal): Promise<void>;
        onWindowCreationError(error: unknown): void;
      }) => ({
        focusOrCreateWindow: () => {
          windowLaunch = options.focusOrCreateWindow(new AbortController().signal).catch((error) => {
            windowError = error;
            options.onWindowCreationError(error);
          });
          return windowLaunch;
        },
        handleBeforeQuit: () => undefined,
      }),
      showBrowserMessageBox: async (options: MessageBoxOptions, parent: unknown) => {
        assert.equal(parent, nativeFailure === 'commit-unknown' ? undefined : window);
        assert.equal(visible, nativeFailure !== 'commit-unknown');
        dialogs.push(options);
        resolveShown();
        return { response: 0, checkboxChecked: false };
      },
    };
    await runInNewContext(`${boot}\nmodule.exports.default()`, {
      module: { exports: {} }, process: { env: {}, argv: [] },
      console: { warn: (message: string) => logs.push(message), error: (message: string) => logs.push(message) },
      require: (name: string) => name.startsWith('node:') ? require(name) : deps,
    });
    await windowLaunch;
    if (nativeFailure === 'commit-unknown') {
      assert.ok(windowError instanceof SettingsRecoveryCommitUnknownError);
      assert.equal(constructed, false, 'the failing storage read still aborts window creation');
    } else {
      await turn();
      assert.equal(dialogs.length, 0);
      window.emit('ready-to-show');
      await turn();
      assert.equal(dialogs.length, 0, 'a hidden window must not consume the guidance');
      visible = true;
      window.emit('show');
    }
    await shown;
    assert.equal(dialogs.length, 1);
    assert.notEqual(dialogs[0].message, dialogs[0].title);
    assert.match(dialogs[0].message, nativeFailure === 'commit-unknown' ? /unconfirmed/u : /reset to defaults/u);
    if (nativeFailure === 'commit-unknown') assert.match(dialogs[0].message + (dialogs[0].detail ?? ''), /unconfirmed/u);
    assert.ok(dialogs[0].detail?.includes(settingsPath));
    const backup = (await readdir(root)).find((file) => file.includes('.corrupt-'));
    assert.ok(backup);
    assert.ok(dialogs[0].detail?.includes(join(root, backup)));
    assert.equal(await readFile(join(root, backup), 'utf8'), 'sk-live-SECRET');
    assert.equal(JSON.stringify(dialogs).includes('sk-live-SECRET'), false);
    assert.equal(logs.join('').includes('sk-live-SECRET'), false);
    assert.equal(banners, nativeFailure === 'failed' ? 1 : 0);
    window.emit('show');
    window.emit('restore');
    await turn();
    assert.equal(dialogs.length, 1);
  });
}

test('clicking a recovery notification reopens a closed main window and presents its pending notice', {
  timeout: 5_000,
}, async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'maka-recovery-notification-'));
  t.after(() => rm(userData, { recursive: true, force: true }));
  const root = join(userData, 'workspaces', 'default');
  await mkdir(root, { recursive: true });
  const settingsPath = join(root, 'settings.json');
  await writeFile(settingsPath, '{}');

  function createWindow() {
    let visible = false;
    const window = Object.assign(new EventEmitter(), {
      isVisible: () => visible,
      isMinimized: () => false,
      isDestroyed: () => false,
      focus: () => undefined,
      restore: () => undefined,
      maximize: () => undefined,
      showInactive: () => { visible = true; window.emit('show'); },
      show: () => { visible = true; window.emit('show'); },
    });
    return window;
  }
  let window: ReturnType<typeof createWindow> | undefined;
  let creations = 0;
  let store: ReturnType<typeof createSettingsStore> | undefined;
  let windowLaunch: Promise<void> | undefined;
  const gate = createWindowRevealGate('active');
  const clicks: (() => void)[] = [];
  const dialogs: MessageBoxOptions[] = [];
  let resolveShown!: () => void;
  const shown = new Promise<void>((resolve) => { resolveShown = resolve; });
  const deps = {
    app: {
      isPackaged: true,
      getAppPath: () => '/test/Maka.app',
      getPath: () => userData,
      getPreferredSystemLanguages: () => ['en-US'],
      on: () => undefined,
    },
    ipcMain: { handle: () => undefined },
    nativeTheme: { shouldUseDarkColors: false },
    Notification: { isSupported: () => true },
    showNativeNotification: (_copy: unknown, click: () => void) => { clicks.push(click); },
    isIsolatedE2e: false,
    revealMode: 'active',
    resolveSystemUiLocale,
    resolveShellEnv: async () => undefined,
    resolveBuildInfo: () => ({ mode: 'packaged' }),
    resolveE2eFixture: () => undefined,
    resolveDesktopStorageRoot: async () => ({ canonicalPath: root }),
    startupStep: (_name: string, work: Promise<unknown>) => work,
    createSettingsRecoveryReporter,
    createSettingsStore: (...args: Parameters<typeof createSettingsStore>) => {
      store = createSettingsStore(...args);
      return store;
    },
    createDesktopLocaleAuthority: () => ({ current: () => 'en', observe: () => 'en' }),
    isDarkAppearance: () => false,
    bootContext: {},
    createMainWindowController: (options: {
      settingsStore: { get(): Promise<AppSettings> };
      onWindowConstructed(): void;
    }) => ({
      browserWindow: () => window,
      hasOpenWindows: () => window !== undefined,
      focus: () => gate.requestFocus(window ?? null),
      createWindow: async () => {
        await options.settingsStore.get();
        window = createWindow();
        creations += 1;
        gate.reset();
        options.onWindowConstructed();
        window.emit('ready-to-show');
        gate.markReady(window);
      },
    }),
    createAppQuitCoordinator: (options: AppQuitCoordinatorDeps) => {
      const coordinator = createAppQuitCoordinator(options);
      return {
        ...coordinator,
        focusOrCreateWindow: () => {
          windowLaunch = coordinator.focusOrCreateWindow();
          return windowLaunch;
        },
      };
    },
    showBrowserMessageBox: async (options: MessageBoxOptions, parent: unknown) => {
      assert.ok(window?.isVisible());
      assert.equal(parent, window);
      dialogs.push(options);
      resolveShown();
      return { response: 0, checkboxChecked: false };
    },
  };
  await runInNewContext(`${boot}\nmodule.exports.default()`, {
    module: { exports: {} }, process: { env: {}, argv: [] },
    console: { warn: () => undefined, error: () => undefined },
    require: (name: string) => name.startsWith('node:') ? require(name) : deps,
  });
  await windowLaunch;
  assert.equal(creations, 1);
  assert.ok(store);
  // The app remains in the Windows tray after the main window is closed.
  // No macOS activate event is emitted to reopen it on a notification click.
  window = undefined;
  await writeFile(settingsPath, 'sk-live-SECRET');
  await store.get();
  await turn();
  assert.equal(clicks.length, 1);
  assert.equal(dialogs.length, 0);

  clicks[0]();
  await windowLaunch;
  assert.equal(creations, 2, 'clicking the banner recreates the main window');
  await shown;
  assert.equal(dialogs.length, 1);
  assert.ok(dialogs[0].detail?.includes(settingsPath));
  const backup = (await readdir(root)).find((name) => name.includes('.corrupt-'));
  assert.ok(backup);
  assert.ok(dialogs[0].detail?.includes(join(root, backup)));

  clicks[0]();
  await windowLaunch;
  await turn();
  assert.equal(creations, 2, 'a later click focuses the existing window');
  assert.equal(dialogs.length, 1, 'the acknowledged notice is not repeated');
});
