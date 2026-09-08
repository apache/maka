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
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';
import type { createMainWindowController } from '../main-window.js';
import type { createWorkHubPresentation } from '../workhub-presentation.js';

const source = fileURLToPath(new URL('../../../src/main/workhub-presentation.ts', import.meta.url));

async function harness(animate = false) {
  let now = 0;
  let timerId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const advance = (milliseconds: number) => {
    const end = now + milliseconds;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > end) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].callback();
    }
    now = end;
  };
  const windows: FakeWindow[] = [];
  const views: FakeView[] = [];
  let handler: ((event: unknown, command: string, payload?: unknown) => Promise<unknown>) | undefined;
  let unregistered = false;
  let registeredViews = 0;
  let releasedViews = 0;
  let pointerDisplay = { x: 0, y: 0, width: 1200, height: 900 };
  class Contents extends EventEmitter {
    mainFrame = {};
    destroyed = false;
    sent: [string, ...unknown[]][] = [];
    session = { setPermissionCheckHandler() {}, setPermissionRequestHandler() {} };
    isDestroyed() { return this.destroyed; }
    send(channel: string, ...args: unknown[]) { this.sent.push([channel, ...args]); }
    getZoomFactor() { return 1; }
    captures = 0;
    async capturePage() {
      this.captures++;
      return { toDataURL: () => 'data:image/png;base64,workhub-frame' };
    }
    setWindowOpenHandler() {}
    loadURL() { return Promise.resolve(); }
    focus() {}
    close() { this.destroyed = true; this.emit('destroyed'); }
  }
  class FakeWindow extends EventEmitter {
    private readonly contents = new Contents();
    get webContents() {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }
    children = new Set<FakeView>();
    contentView = { addChildView: (v: FakeView) => this.children.add(v), removeChildView: (v: FakeView) => this.children.delete(v) };
    visible = false;
    destroyed = false;
    bounds = { x: 0, y: 0, width: 1000, height: 800 };
    constructor(options?: { x?: number; y?: number; width?: number; height?: number }) {
      super();
      if (options) this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 1000, height: options.height ?? 800 };
      windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isFocused() { return this.visible; }
    isMinimized() { return false; }
    getContentBounds() { return this.bounds; }
    getBounds() { return this.bounds; }
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; }
    setVisibleOnAllWorkspaces() {}
    setMaximizable() {}
    show() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    restore() {}
    destroy() { this.destroyed = true; this.contents.close(); this.emit('closed'); }
  }
  class FakeView {
    webContents = new Contents();
    visible = false;
    constructor() { views.push(this); }
    setVisible(value: boolean) { this.visible = value; }
    getVisible() { return this.visible; }
    setBackgroundColor() {}
    setBounds() {}
  }
  const output = await build({ entryPoints: [source], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['electron'] });
  const module = { exports: {} as { createWorkHubPresentation: typeof createWorkHubPresentation } };
  const nodeRequire = createRequire(import.meta.url);
  runInNewContext(output.outputFiles[0]!.text, {
    module, exports: module.exports, console, process, URL,
    Date: class extends Date { static now() { return now; } },
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { at: now + delay, callback }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => name === 'electron' ? {
      BrowserWindow: FakeWindow, WebContentsView: FakeView,
      systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: !animate }) },
      globalShortcut: { register: () => true, unregister: () => { unregistered = true; } },
      ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; }, removeHandler: () => { handler = undefined; } },
      screen: { getCursorScreenPoint: () => ({ x: pointerDisplay.x, y: pointerDisplay.y }), getDisplayNearestPoint: () => ({ workArea: pointerDisplay }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    } : nodeRequire(name),
  });
  const main = new FakeWindow();
  const controller = module.exports.createWorkHubPresentation({
    mainWindow: () => main as unknown as Electron.BrowserWindow,
    ensureMainWindow: async () => main as unknown as Electron.BrowserWindow,
    mainModuleDirectory: '/app/dist/main', preloadPath: '/app/dist/preload/preload.cjs',
    onViewCreated: () => { registeredViews++; return () => { releasedViews++; }; },
  });
  controller.attachMainWindow(main as unknown as Electron.BrowserWindow);
  controller.registerIpc();
  const command = (sender: Contents, name: string, payload?: unknown) => handler!({ sender, senderFrame: sender.mainFrame }, name, payload);
  return { controller, main, windows, views, command, advance, movePointer: (display: typeof pointerDisplay) => { pointerDisplay = display; }, registrations: () => [registeredViews, releasedViews], handler: () => handler, unregistered: () => unregistered };
}

test('yields the docked native view to main-window overlays without replacing the conversation', async () => {
  const h = await harness();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  const view = h.views[0]!;
  assert.equal(view.visible, true);
  const backdrop = await h.command(h.main.webContents, 'host', { ...host, occluded: true });
  assert.equal(backdrop, 'data:image/png;base64,workhub-frame');
  assert.equal(view.visible, false);
  await h.command(h.main.webContents, 'host', { ...host, occluded: true });
  assert.equal(view.webContents.captures, 1);
  await h.command(h.main.webContents, 'host', host);
  assert.equal(view.visible, true);
  assert.equal(h.views.length, 1);
  await h.command(view.webContents, 'detach');
  await h.command(h.main.webContents, 'host', { ...host, occluded: true });
  assert.equal(view.visible, true);
  assert.equal(view.webContents.captures, 1);
  await assert.rejects(h.command(h.main.webContents, 'host', { ...host, occluded: 'yes' }), /Invalid WorkHub host/);
  h.controller.dispose();
});

test('opens an empty floating conversation at its composer height', async () => {
  const h = await harness();
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 0, y: 40, width: 1000, height: 760 } });
  const view = h.views[0]!;
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  await h.command(view.webContents, 'detach');
  assert.equal(h.windows[1]!.bounds.height, 110);
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 110 });
  assert.equal(h.windows[1]!.bounds.height, 720);
  await h.command(view.webContents, 'dock');
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  h.movePointer({ x: 1600, y: -900, width: 1000, height: 800 });
  await h.controller.toggle(true);
  const bounds = h.windows[1]!.bounds;
  assert.equal(bounds.x + bounds.width / 2, 2100);
  assert.equal(bounds.y + bounds.height, -100 - 96);
  h.controller.dispose();
});

test('animates from the current height, keeps the bottom anchored and survives reversal', async () => {
  const h = await harness(true);
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 0, y: 40, width: 1000, height: 760 } });
  const view = h.views[0]!;
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  await h.command(view.webContents, 'detach');
  const floating = h.windows[1]!;
  const bottom = floating.bounds.y + floating.bounds.height;
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 110 });
  h.advance(80);
  assert.ok(floating.bounds.height > 110 && floating.bounds.height < 720);
  assert.equal(floating.bounds.y + floating.bounds.height, bottom);
  // A composer measurement during expansion must not restart or shrink it.
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 114 });
  h.advance(160);
  assert.equal(floating.bounds.height, 720);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  h.advance(80);
  const intermediate = floating.bounds.height;
  assert.ok(intermediate > 110 && intermediate < 720);
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 110 });
  assert.equal(floating.bounds.height, intermediate);
  h.advance(240);
  assert.equal(floating.bounds.height, 720);
  assert.equal(floating.bounds.y + floating.bounds.height, bottom);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  h.advance(80);
  await h.command(view.webContents, 'hide');
  const hiddenBounds = floating.bounds;
  h.advance(500);
  assert.equal(floating.bounds, hiddenBounds);
  h.controller.dispose();
});

test('reparents one live conversation across docking, floating, hide and main-window close', async () => {
  const h = await harness();
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 100, y: 40, width: 900, height: 760 } });
  const view = h.views[0]!;
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 96 });
  assert.ok(h.main.children.has(view));
  await h.command(view.webContents, 'detach');
  const floating = h.windows[1]!;
  assert.ok(!h.main.children.has(view) && floating.children.has(view));
  const expandedHeight = floating.bounds.height;
  const anchoredBottom = floating.bounds.y + floating.bounds.height;
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 160 });
  assert.equal(floating.bounds.height, 160);
  assert.equal(floating.bounds.y + floating.bounds.height, anchoredBottom);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 200 });
  assert.equal(floating.bounds.height, 200);
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 200 });
  assert.equal(floating.bounds.height, expandedHeight);
  assert.equal(floating.bounds.y + floating.bounds.height, anchoredBottom);
  await assert.rejects(h.command(h.main.webContents, 'conversation-layout', { expanded: false, compactHeight: 160 }), /Only the WorkHub view/);
  await assert.rejects(h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: Number.NaN }), /Invalid WorkHub conversation layout/);
  await h.command(view.webContents, 'hide');
  assert.equal(floating.visible, false);
  assert.equal(view.webContents.destroyed, false);
  await h.command(view.webContents, 'dock');
  assert.ok(h.main.children.has(view) && !floating.children.has(view));
  await h.command(h.main.webContents, 'host', { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(view.visible, false);
  h.main.emit('close');
  assert.ok(floating.children.has(view));
  assert.equal(view.webContents.destroyed, false);
  await h.controller.toggle();
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.ok(h.main.children.has(view));
  await h.controller.toggle();
  assert.equal(floating.visible, true);
  h.movePointer({ x: 1600, y: -900, width: 1000, height: 800 });
  await Promise.all([h.controller.toggle(), h.controller.toggle()]);
  assert.equal(h.controller.getSnapshot().placement, 'floating');
  assert.equal(floating.visible, true);
  assert.ok(floating.bounds.x >= 1600 && floating.bounds.x + floating.bounds.width <= 2600);
  assert.ok(floating.bounds.y >= -900 && floating.bounds.y + floating.bounds.height <= -100);
  assert.equal(h.views.length, 1);
  assert.doesNotThrow(() => h.main.destroy());
  assert.doesNotThrow(() => h.controller.send('settings:changed'));
  h.controller.registerShortcut();
  h.controller.dispose();
  assert.equal(view.webContents.destroyed, true);
  assert.equal(floating.destroyed, true);
  assert.equal(h.unregistered(), true);
  assert.equal(h.handler(), undefined);
  assert.deepEqual(h.registrations(), [1, 1]);
});

test('rejects unowned/subframe IPC and buffers navigation until main subscribes', async () => {
  const h = await harness();
  assert.throws(() => h.handler()!({ sender: h.main.webContents, senderFrame: {} }, 'snapshot'), /owned main frame/);
  await h.controller.toggle();
  const view = h.views[0]!;
  await assert.rejects(h.command(view.webContents, 'host', {}), /Only the main window/);
  await h.command(view.webContents, 'session', JSON.stringify(['host-a', 'session-a']));
  assert.equal(h.main.webContents.sent.some(([channel]) => channel.endsWith('open-main')), false);
  await h.command(h.main.webContents, 'ready');
  const navigation = h.main.webContents.sent.find(([channel]) => channel.endsWith('open-main'));
  assert.equal(JSON.stringify(navigation?.[1]), JSON.stringify({ kind: 'session', sessionKey: '["host-a","session-a"]' }));
  h.controller.dispose();
});


test('application broadcasts reach registered auxiliaries once and stop after release or destruction', async () => {
  const entry = fileURLToPath(new URL('../../../src/main/main-window.ts', import.meta.url));
  const output = await build({ entryPoints: [entry], bundle: false, write: false, format: 'cjs', platform: 'node', define: { 'import.meta.dirname': JSON.stringify('/app/dist/main') } });
  const module = { exports: {} as { createMainWindowController: typeof createMainWindowController } };
  runInNewContext(output.outputFiles[0]!.text, {
    module, exports: module.exports, process,
    require: () => ({ createWindowRevealGate: () => ({}) }),
  });
  const controller = module.exports.createMainWindowController({
    workspaceRoot: '/workspace', e2eFixture: null, revealMode: 'hidden',
    settingsStore: { get: async () => { throw new Error('Unused'); } },
    onRendererProcessGone: () => undefined,
  });
  const messages: string[] = [];
  const renderer = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: (channel: string) => { messages.push(channel); },
  }) as unknown as Electron.WebContents;
  const release = controller.registerAuxiliaryRenderer(renderer);
  assert.equal(controller.ownsRenderer(renderer), true);
  controller.send('settings:changed');
  assert.deepEqual(messages, ['settings:changed']);
  release();
  controller.send('settings:changed');
  assert.deepEqual(messages, ['settings:changed']);
  assert.equal(controller.ownsRenderer(renderer), false);
  controller.registerAuxiliaryRenderer(renderer);
  renderer.emit('destroyed');
  assert.equal(controller.ownsRenderer(renderer), false);
  controller.send('settings:changed');
  assert.deepEqual(messages, ['settings:changed']);
});
