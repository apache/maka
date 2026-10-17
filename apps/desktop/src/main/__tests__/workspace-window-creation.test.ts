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
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { transform } from 'esbuild';
import { createWorkspaceWindowRegistry } from '../workspace-window-registry.js';
import { createWindowRevealGate } from '../window-reveal.js';
import { SAFE_MIN_HEIGHT, SAFE_MIN_WIDTH } from '../window-state.js';
import { createSessionWindowCoordinator } from '../session-window-coordinator.js';
import type { SessionWindowCommand } from '../../shared/session-window-contract.js';
import type { MainWindowController } from '../main-window.js';

type TestDisplay = { workArea: Electron.Rectangle; scaleFactor: number };

async function harness() {
  const registry = createWorkspaceWindowRegistry();
  const windows: FakeWindow[] = [];
  let settingsReads = 0;
  let releaseSettings!: () => void;
  let settings = new Promise<void>((resolve) => { releaseSettings = resolve; });
  const closedCounts: number[] = [];
  const savedBounds: Electron.Rectangle[] = [];
  const primary: TestDisplay = { workArea: { x: 0, y: 0, width: 1500, height: 1000 }, scaleFactor: 1 };
  const displays = { primary, matching: primary };
  const matchingCalls: Electron.Rectangle[] = [];
  const dialogCalls: { kind: 'open' | 'save'; parent: unknown }[] = [];
  const auxiliaryRenderers = new Set<Contents>();
  const nativeParents = new Map<Contents, FakeWindow>();
  class Contents extends EventEmitter {
    session = {};
    destroyed = false;
    url = '';
    isDestroyed() { return this.destroyed; }
    setWindowOpenHandler() {}
    getURL() { return this.url; }
    executeJavaScript() { return Promise.resolve(); }
    send(_channel: string, command: SessionWindowCommand) { this.emit('command', command); }
  }
  class FakeWindow extends EventEmitter {
    static fromWebContents(contents: Contents) {
      return nativeParents.get(contents) ?? windows.find((window) =>
        !window.isDestroyed() && window.webContents === contents) ?? null;
    }
    readonly id = windows.length + 1;
    private readonly contents = new Contents();
    destroyed = false;
    visible = false;
    private bounds: Electron.Rectangle;
    readonly contentView = {};
    get webContents() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }
    constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
      super();
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 1240, height: options.height ?? 820 };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return false; }
    isMinimized() { return false; }
    isMaximized() { return false; }
    getBounds() { return { ...this.bounds }; }
    setBounds(bounds: Electron.Rectangle) { this.bounds = { ...bounds }; }
    getNormalBounds() { return this.getBounds(); }
    async loadURL(url: string) { this.contents.url = url; this.contents.emit('did-finish-load'); this.emit('ready-to-show'); }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', event);
      if (!event.defaultPrevented) this.destroy();
    }
    destroy() {
      this.destroyed = true; this.contents.destroyed = true;
      this.contents.emit('destroyed'); this.emit('closed');
    }
  }
  const modules: Record<string, unknown> = {
    electron: { app: {}, BrowserWindow: FakeWindow, nativeTheme: { shouldUseDarkColors: false },
      dialog: {
        showOpenDialog: async (parent: unknown) => { dialogCalls.push({ kind: 'open', parent }); return { canceled: false, filePaths: ['/selected.txt'] }; },
        showSaveDialog: async (parent: unknown) => { dialogCalls.push({ kind: 'save', parent }); return { canceled: false, filePath: '/saved.txt' }; },
      },
      screen: {
        getAllDisplays: () => [displays.primary, displays.matching],
        getPrimaryDisplay: () => displays.primary,
        getDisplayMatching: (bounds: Electron.Rectangle) => { matchingCalls.push(bounds); return displays.matching; },
      } },
    'node:fs/promises': { mkdir: async () => undefined },
    'node:path': path,
    '@maka/core/settings': { appIconForTheme: () => 'default' },
    './main-window-drop-guard.js': { MAIN_WINDOW_DROP_GUARD_SCRIPT: '' },
    './app-icon-surface.js': { applyInitialWindowAppIcon() {}, readableAppIconPath: () => '' },
    './external-link-guard.js': { isExternalUrl: () => false },
    './window-state.js': { readSavedBounds: async (_root: string, defaults: unknown) => defaults, writeSavedBounds: async (_root: string, bounds: Electron.Rectangle) => { savedBounds.push(bounds); }, SAFE_MIN_WIDTH, SAFE_MIN_HEIGHT },
    './browser/controller.js': {}, './browser/view-manager.js': {},
    './main-window-permission-policy.js': { installMainWindowPermissionPolicy() {} },
    './main-renderer-loader.js': { resolveMainRendererEntry: () => ({ url: 'http://localhost/index.html' }), loadMainRenderer: (window: FakeWindow) => window.loadURL('http://localhost/index.html') },
    './main-renderer-dev-cache.js': { clearDevRendererHttpCache: async () => undefined },
    './main-renderer-process-gone.js': { observeMainRendererProcessGone() {} },
    './theme-source.js': { isDarkAppearance: () => false, toNativeThemeSource: () => 'system' },
    './window-reveal.js': { createWindowRevealGate },
    './windows-maximize-renderer-sync.js': { createWindowsMaximizeRendererSync: () => () => undefined },
    './auxiliary-window-registry.js': { auxiliaryWindowRegistry: {
      renderers: () => auxiliaryRenderers.values(),
      rendererParent: (contents: Contents) => !contents.isDestroyed() && auxiliaryRenderers.has(contents) ? {} : undefined,
    } },
    './workspace-window-registry.js': { workspaceWindowRegistry: registry },
    '../shared/runtime-host-identity.js': {},
  };
  const source = await readFile(fileURLToPath(new URL('../../../src/main/main-window.ts', import.meta.url)), 'utf8');
  const compiled = await transform(source, { loader: 'ts', format: 'cjs', target: 'es2022', define: { 'import.meta.dirname': JSON.stringify('/virtual/main') } });
  const module = { exports: {} as { createMainWindowController: (deps: unknown) => MainWindowController } };
  runInNewContext(compiled.code, {
    module, exports: module.exports,
    require: (id: string) => { if (!(id in modules)) throw new Error(`Unexpected import ${id}`); return modules[id]; },
    process: { platform: 'linux', env: {} }, setTimeout, clearTimeout, console,
  });
  const controller = module.exports.createMainWindowController({
    workspaceRoot: '/virtual', e2eFixture: null, revealMode: 'hidden',
    settingsStore: { get: async () => { settingsReads += 1; await settings; return { appearance: { theme: 'auto' } }; } },
    onRendererProcessGone() {},
    onClosed: () => { closedCounts.push(registry.entries().length); },
  });
  return {
    controller, registry, windows, displays, matchingCalls, closedCounts, savedBounds,
    dialogCalls, auxiliaryRenderers, nativeParents,
    createRenderer: () => new Contents(),
    createAuxiliaryWindow: () => new FakeWindow({ show: false }),
    releaseSettings: () => releaseSettings(),
    pauseSettings: () => { settings = new Promise<void>((resolve) => { releaseSettings = resolve; }); },
    settingsReads: () => settingsReads,
  };
}

test('file dialogs stay with the requesting workspace instead of the active main window', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);
  const child = h.windows[1]!;
  await h.controller.showOpenDialog({}, child.webContents as never);
  await h.controller.showSaveDialog({}, child.webContents as never);
  assert.deepEqual(h.dialogCalls, [{ kind: 'open', parent: child }, { kind: 'save', parent: child }]);
});

test('WorkHub file dialogs follow its registered renderer from docked to floating', async () => {
  const h = await harness();
  h.releaseSettings();
  await h.controller.createWindow(new AbortController().signal);
  const main = h.windows[0]!;
  const workHub = h.createRenderer();
  h.auxiliaryRenderers.add(workHub);
  h.nativeParents.set(workHub, main);
  assert.equal((await h.controller.showOpenDialog({}, workHub as never)).canceled, false);
  assert.equal((await h.controller.showSaveDialog({}, workHub as never)).canceled, false);
  const floating = h.createAuxiliaryWindow();
  h.nativeParents.set(workHub, floating);
  main.destroy();
  assert.equal((await h.controller.showOpenDialog({}, workHub as never)).canceled, false);
  assert.equal((await h.controller.showSaveDialog({}, workHub as never)).canceled, false);
  assert.deepEqual(h.dialogCalls, [
    { kind: 'open', parent: main }, { kind: 'save', parent: main },
    { kind: 'open', parent: floating }, { kind: 'save', parent: floating },
  ]);
});

test('file dialogs reject unknown or destroyed auxiliary senders and missing or destroyed parents', async () => {
  const h = await harness();
  const sender = h.createRenderer();
  const parent = h.createAuxiliaryWindow();
  h.nativeParents.set(sender, parent);
  const assertCancelled = async () => {
    assert.equal((await h.controller.showOpenDialog({}, sender as never)).canceled, true);
    assert.equal((await h.controller.showSaveDialog({}, sender as never)).canceled, true);
    assert.equal(h.dialogCalls.length, 0);
  };
  await assertCancelled();
  h.auxiliaryRenderers.add(sender);
  h.nativeParents.delete(sender);
  await assertCancelled();
  h.nativeParents.set(sender, parent);
  parent.destroy();
  await assertCancelled();
  h.nativeParents.set(sender, h.createAuxiliaryWindow());
  sender.destroyed = true;
  await assertCancelled();
});

test('concurrent main creation shares the asynchronous construction and one registered native window', async () => {
  const h = await harness();
  const signal = new AbortController().signal;
  const first = h.controller.createWindow(signal);
  const second = h.controller.createWindow(signal);
  assert.equal(first, second);
  assert.equal(h.settingsReads(), 1);
  assert.equal(h.windows.length, 0);
  h.releaseSettings();
  await Promise.all([first, second]);
  assert.equal(h.windows.length, 1);
  assert.equal(h.registry.main()?.window, h.windows[0]);
  assert.equal(h.controller.browserWindow(), h.windows[0]);
  assert.equal(h.registry.main()?.controller.browserWindow(), h.windows[0]);
  await h.controller.createWindow(signal);
  assert.equal(h.windows.length, 1);
  h.windows[0]!.destroy();
  await Promise.all([h.controller.createWindow(signal), h.controller.createWindow(signal)]);
  assert.equal(h.windows.length, 2);
  assert.equal(h.registry.main()?.window, h.windows[1]);
});

test('closing the last session window invokes the shared workspace lifecycle callback', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);
  h.windows[0]!.destroy();
  assert.deepEqual(h.closedCounts, [1]);
  assert.equal(h.controller.hasOpenWindows(), true);
  h.windows[1]!.destroy();
  assert.deepEqual(h.closedCounts, [1, 0]);
  assert.equal(h.controller.hasOpenWindows(), false);
});

test('session windows follow the main window on a negative-coordinate HiDPI display in DIP', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  h.displays.matching = { workArea: { x: -2560, y: -1440, width: 2560, height: 1400 }, scaleFactor: 2 };
  const mainBounds = { x: -2400, y: -1300, width: 1240, height: 820 };
  h.windows[0]!.setBounds(mainBounds);

  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);

  assert.deepEqual(h.matchingCalls, [mainBounds]);
  assert.deepEqual(h.windows[1]!.getBounds(), { x: -2368, y: -1268, width: 1240, height: 820 });
});

test('session window placement clamps every edge to the main display work area', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  h.displays.matching = { workArea: { x: 1500, y: 40, width: 1600, height: 900 }, scaleFactor: 1 };
  h.windows[0]!.setBounds({ x: 2600, y: 700, width: 1240, height: 820 });

  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);
  assert.deepEqual(h.windows[1]!.getBounds(), { x: 1860, y: 120, width: 1240, height: 820 });

  h.windows[0]!.setBounds({ x: 1400, y: -40, width: 1240, height: 820 });
  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'B', group: { hostId: 'local', groupId: 'B', sessionIds: ['B'] } }, signal);
  assert.deepEqual(h.windows[2]!.getBounds(), { x: 1500, y: 40, width: 1240, height: 820 });
});

test('session windows shrink only dimensions larger than the available work area', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  h.displays.matching = { workArea: { x: -1000, y: 40, width: 1000, height: 1000 }, scaleFactor: 1 };
  h.windows[0]!.setBounds({ x: -900, y: 100, width: 1240, height: 820 });

  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);

  assert.deepEqual(h.windows[1]!.getBounds(), { x: -1000, y: 132, width: 1000, height: 820 });
  assert.equal(h.windows[1]!.options.minWidth, SAFE_MIN_WIDTH);
  assert.equal(h.windows[1]!.options.minHeight, SAFE_MIN_HEIGHT);
});

test('session window minimum sizes cannot expand it beyond a small display work area', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  h.displays.matching = { workArea: { x: 1500, y: 40, width: 480, height: 240 }, scaleFactor: 1 };
  h.windows[0]!.setBounds({ x: 1500, y: 40, width: 1240, height: 820 });

  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);

  assert.deepEqual(h.windows[1]!.getBounds(), { x: 1500, y: 40, width: 480, height: 240 });
  assert.equal(h.windows[1]!.options.minWidth, 480);
  assert.equal(h.windows[1]!.options.minHeight, 240);
});

test('session placement uses the current main window position after asynchronous preparation', async () => {
  const h = await harness();
  h.releaseSettings();
  const signal = new AbortController().signal;
  await h.controller.createWindow(signal);
  h.windows[0]!.setBounds({ x: 50, y: 50, width: 1240, height: 820 });
  h.pauseSettings();
  const child = h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, signal);
  assert.equal(h.settingsReads(), 2);
  assert.equal(h.windows.length, 1);
  h.displays.matching = { workArea: { x: 1500, y: 40, width: 2000, height: 1200 }, scaleFactor: 1 };
  const movedBounds = { x: 1700, y: 140, width: 1240, height: 820 };
  h.windows[0]!.setBounds(movedBounds);
  h.releaseSettings();
  await child;

  assert.deepEqual(h.matchingCalls, [movedBounds]);
  assert.deepEqual(h.windows[1]!.getBounds(), { x: 1732, y: 172, width: 1240, height: 820 });
});

test('session windows center within the primary display work area when no main window exists', async () => {
  const h = await harness();
  h.releaseSettings();
  h.displays.primary = { workArea: { x: 0, y: 40, width: 1600, height: 1000 }, scaleFactor: 2 };

  await h.controller.createSessionWindow({ kind: 'session', initialSessionId: 'A', group: { hostId: 'local', groupId: 'A', sessionIds: ['A'] } }, new AbortController().signal);

  assert.equal(h.matchingCalls.length, 0);
  assert.deepEqual(h.windows[0]!.getBounds(), { x: 180, y: 130, width: 1240, height: 820 });
});


test('coordinated immediate close saves final Main bounds through native close finalization', async () => {
  const h = await harness();
  const coordinator = createSessionWindowCoordinator({
    windows: h.controller, signal: new AbortController().signal, ensureMainWindow: async () => {},
    resolveGroup: async (id) => ({ hostId: 'host', groupId: id, sessionIds: [id] }),
    knownGroups: () => [], confirmClose: async () => false,
    transferResources: async () => {}, releaseResources: () => {},
    isQuitting: () => false, onError: (error) => { throw error; },
  });
  h.releaseSettings();
  await h.controller.createWindow(new AbortController().signal);
  const main = h.windows[0]!;
  const sender = main.webContents;
  sender.on('command', (command: SessionWindowCommand) => queueMicrotask(() => coordinator.reply(sender as never,
    { requestId: command.requestId, ok: true, result: {} })));
  coordinator.sessionWindowReady(sender as never);
  const bounds = { x: 230, y: 140, width: 1100, height: 760 };
  main.setBounds(bounds);
  main.emit('move');
  main.close();
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(main.destroyed, true);
  assert.deepEqual(h.savedBounds.map(({ x, y, width, height }) => ({ x, y, width, height })), [bounds]);
  coordinator.dispose();
});
