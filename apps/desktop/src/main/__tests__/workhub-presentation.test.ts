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
import { deferred } from '@maka/core/test-only/async-primitives';
import type { createMainWindowController } from '../main-window.js';
import type { createWorkHubPresentation } from '../workhub-presentation.js';
import type { WindowRevealMode } from '../window-reveal.js';

const source = fileURLToPath(new URL('../../../src/main/workhub-presentation.ts', import.meta.url));

async function harness(animate = false, displayFrequency = 60, revealMode: WindowRevealMode = 'active') {
  let enabled = true;
  let mainRequests = 0;
  let mainAvailable = true;
  let opening: Promise<void> | undefined;
  const openingStarted = deferred<void>();
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
  const errors: unknown[] = [];
  let handler: ((event: unknown, command: string, payload?: unknown) => Promise<unknown>) | undefined;
  let unregistered = false;
  let shortcut: (() => void) | undefined;
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
    backgroundThrottling = true;
    setBackgroundThrottling(allowed: boolean) { this.backgroundThrottling = allowed; }
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
    cornerRadius = 0;
    contentView = { setBorderRadius: (radius: number) => { this.cornerRadius = radius; }, addChildView: (v: FakeView) => this.children.add(v), removeChildView: (v: FakeView) => this.children.delete(v) };
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
    setBounds(bounds: typeof this.bounds) { this.bounds = bounds; this.emit('resize'); }
    setVisibleOnAllWorkspaces() {}
    setMaximizable() {}
    shown = 0;
    shownInactive = 0;
    show() { this.shown++; this.visible = true; this.emit('show'); }
    showInactive() { this.shownInactive++; this.visible = true; }
    hide() { this.visible = false; }
    resizable = true;
    setResizable(value: boolean) { this.resizable = value; }
    focused = 0;
    focus() { this.focused++; }
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
    boundsUpdates: Electron.Rectangle[] = [];
    setBounds(bounds: Electron.Rectangle) { this.boundsUpdates.push(bounds); }
  }
  const output = await build({ entryPoints: [source], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['electron'] });
  const module = { exports: {} as { createWorkHubPresentation: typeof createWorkHubPresentation } };
  const nodeRequire = createRequire(import.meta.url);
  runInNewContext(output.outputFiles[0]!.text, {
    module, exports: module.exports, console, process, URL, Error,
    performance: { now: () => now },
    // Native timers truncate fractional delays, so callbacks can precede a
    // display deadline. Model that instead of an ideal fractional clock.
    setTimeout: (callback: () => void, delay: number) => { timers.set(++timerId, { at: now + Math.max(1, Math.floor(delay)), callback }); return timerId; },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) => name === 'electron' ? {
      BrowserWindow: FakeWindow, WebContentsView: FakeView,
      systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: !animate }) },
      globalShortcut: { register: (_accelerator: string, callback: () => void) => { shortcut = callback; return true; }, unregister: () => { unregistered = true; } },
      ipcMain: { handle: (_channel: string, callback: typeof handler) => { handler = callback; }, removeHandler: () => { handler = undefined; } },
      screen: { getCursorScreenPoint: () => ({ x: pointerDisplay.x, y: pointerDisplay.y }), getDisplayNearestPoint: () => ({ workArea: pointerDisplay }), getDisplayMatching: () => ({ displayFrequency, workArea: { x: 0, y: 0, width: 1200, height: 900 } }) },
    } : nodeRequire(name),
  });
  const main = new FakeWindow();
  const controller = module.exports.createWorkHubPresentation({
    mainWindow: () => mainAvailable ? main as unknown as Electron.BrowserWindow : undefined,
    isEnabled: () => enabled,
    revealMode,
    ensureMainWindow: async () => { mainRequests++; openingStarted.resolve(); await opening; mainAvailable = true; return main as unknown as Electron.BrowserWindow; },
    mainModuleDirectory: '/app/dist/main', preloadPath: '/app/dist/preload/preload.cjs',
    onError: (error) => errors.push(error),
    onViewCreated: () => { registeredViews++; return () => { releasedViews++; }; },
  });
  controller.attachMainWindow(main as unknown as Electron.BrowserWindow);
  controller.registerIpc();
  const command = (sender: Contents, name: string, payload?: unknown) => handler!({ sender, senderFrame: sender.mainFrame }, name, payload);
  return { setMainAvailable: (value: boolean) => { mainAvailable = value; }, shortcut: () => shortcut!(), get mainRequests() { return mainRequests; }, controller, main, windows, views, errors, command, advance, setEnabled: (value: boolean) => { enabled = value; }, deferOpening: (value: Promise<void>) => { opening = value; return openingStarted.promise; }, movePointer: (display: typeof pointerDisplay) => { pointerDisplay = display; }, registrations: () => [registeredViews, releasedViews], handler: () => handler, unregistered: () => unregistered };
}

test('yields the docked native view to main-window overlays without replacing the conversation', async () => {
  const h = await harness();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  const view = h.views[0]!;
  h.main.show();
  await h.command(view.webContents, 'ready');
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

test('yields and restores the conversation when its compositor frame is unavailable', async () => {
  const h = await harness();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  const view = h.views[0]!;
  const occlude = () => h.command(h.main.webContents, 'host', { ...host, occluded: true });
  const restore = () => h.command(h.main.webContents, 'host', host);
  h.main.show();
  assert.equal(await occlude(), undefined);
  assert.equal(view.webContents.captures, 0);
  await restore();
  await h.command(view.webContents, 'ready');
  h.main.hide();
  assert.equal(await occlude(), undefined);
  assert.equal(view.webContents.captures, 0);
  await restore();
  h.main.show();
  view.webContents.capturePage = async () => { throw new Error('UnknownVizError'); };
  assert.equal(await occlude(), undefined);
  assert.equal(view.visible, false);
  assert.deepEqual(h.errors, []);
  await restore();
  assert.equal(view.visible, true);
  assert.equal(h.views.length, 1);
  const unexpected = new Error('Unexpected capture failure');
  view.webContents.capturePage = async () => { throw unexpected; };
  await occlude();
  assert.deepEqual(h.errors, [unexpected]);
  await restore();
  assert.equal(view.visible, true);
  h.controller.dispose();
});

test('opens an empty floating conversation at its composer height', async () => {
  const h = await harness();
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 0, y: 40, width: 1000, height: 760 } });
  const view = h.views[0]!;
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  await h.command(view.webContents, 'detach');
  assert.equal(h.windows[1]!.bounds.height, 110);
  assert.equal(h.windows[1]!.resizable, false);
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 110 });
  assert.equal(h.windows[1]!.bounds.height, 720);
  assert.equal(h.windows[1]!.resizable, true);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 160 });
  assert.equal(h.windows[1]!.resizable, false);
  assert.equal(h.windows[1]!.bounds.height, 160, 'compact input still grows programmatically');
  await h.command(view.webContents, 'dock');
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  h.movePointer({ x: 1600, y: -900, width: 1000, height: 800 });
  await h.controller.toggle(true);
  const bounds = h.windows[1]!.bounds;
  assert.equal(h.windows[1]!.resizable, false);
  assert.equal(bounds.x + bounds.width / 2, 2100);
  assert.equal(bounds.y + bounds.height, -100 - 96);
  h.controller.dispose();
});

test('reopening or docking a crashed conversation creates a ready-gated renderer', async () => {
  const h = await harness();
  const host = { visible: true, rect: { x: 0, y: 40, width: 1000, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  for (const recover of [
    () => h.controller.show(),
    () => h.command(h.main.webContents, 'dock'),
  ]) {
    const previous = h.views.at(-1)!;
    await h.command(previous.webContents, 'ready');
    const staleReady = h.command(previous.webContents, 'ready');
    previous.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    await assert.rejects(staleReady, /owned main frame/);
    await h.command(h.main.webContents, 'host', host);
    assert.equal(h.controller.getSnapshot().rendererCrashed, true);
    assert.equal(h.views.at(-1), previous, 'recovery waits for an explicit user action');
    await recover();
    assert.equal(h.controller.getSnapshot().rendererCrashed, false);
    const recovered = h.views.at(-1)!;
    assert.notEqual(recovered, previous);
    assert.equal(previous.webContents.isDestroyed(), true);
    assert.equal(h.windows.some((window) => window.children.has(previous)), false);
    assert.equal(h.controller.ownsWebContents(previous.webContents as unknown as Electron.WebContents), false);
    assert.equal(recovered.webContents.sent.some(([channel]) => channel === 'workhub-presentation:focus-composer'), false);
    await h.command(recovered.webContents, 'ready');
    assert.equal(recovered.webContents.sent.some(([channel]) => channel === 'workhub-presentation:focus-composer'), true);
  }
  assert.deepEqual(h.registrations(), [3, 2]);
  h.controller.dispose();
  assert.deepEqual(h.registrations(), [3, 3]);
});

test('animates from the current height, keeps the bottom anchored and survives reversal', async () => {
  const h = await harness(true);
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 0, y: 40, width: 1000, height: 760 } });
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  await h.command(view.webContents, 'detach');
  const floating = h.windows[1]!;
  const bottom = floating.bounds.y + floating.bounds.height;
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 110 });
  h.advance(80);
  assert.ok(floating.bounds.height > 110 && floating.bounds.height < 720);
  assert.equal(floating.bounds.y + floating.bounds.height, bottom);
  assert.equal(view.boundsUpdates.at(-1)!.height, 720, 'height animation keeps the renderer canvas stable');
  assert.equal(view.boundsUpdates.at(-1)!.y + 720, floating.bounds.height, 'the live editor stays at the native bottom');
  // A composer measurement during expansion must not restart or shrink it.
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 114 });
  h.advance(340);
  assert.equal(floating.bounds.height, 720);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  h.advance(18);
  assert.ok(floating.bounds.height >= 700, 'collapse starts gently while the visible conversation fades');
  h.advance(62);
  const intermediate = floating.bounds.height;
  assert.ok(intermediate > 110 && intermediate < 720);
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 110 });
  assert.equal(floating.bounds.height, intermediate);
  assert.equal(view.boundsUpdates.at(-1)!.height, 720, 'reversal reuses the existing canvas');
  h.advance(420);
  assert.equal(floating.bounds.height, 720);
  assert.equal(floating.bounds.y + floating.bounds.height, bottom);
  assert.equal(view.boundsUpdates.at(-1)!.y, 0);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 110 });
  h.advance(80);
  await h.command(view.webContents, 'hide');
  const hiddenBounds = floating.bounds;
  h.advance(500);
  assert.equal(floating.bounds, hiddenBounds);
  assert.equal(view.webContents.sent.filter(([channel]) => channel.endsWith('viewport-inset')).at(-1)![1], 0, 'hiding clears transient clipping');
  h.controller.dispose();
});

test('reparents one live conversation across docking, floating, hide and main-window close', async () => {
  const h = await harness();
  h.main.show();
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 100, y: 40, width: 900, height: 760 } });
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
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
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.ok(h.main.children.has(view));
  assert.equal(view.webContents.destroyed, false);
  await h.command(view.webContents, 'dock');
  assert.ok(h.main.children.has(view) && !floating.children.has(view));
  await h.command(h.main.webContents, 'host', { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(view.visible, false);
  h.main.emit('close');
  h.main.hide();
  const mainFocusCount = h.main.focused;
  assert.ok(floating.children.has(view));
  assert.equal(view.webContents.destroyed, false);
  await h.controller.toggle();
  assert.equal(h.controller.getSnapshot().placement, 'floating');
  assert.ok(floating.children.has(view));
  assert.equal(floating.visible, true);
  await h.controller.toggle();
  assert.equal(floating.visible, false);
  assert.equal(h.main.visible, false, 'hiding the floating window must not show Desktop');
  assert.equal(h.main.focused, mainFocusCount, 'the shortcut never focuses Desktop');
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.ok(floating.children.has(view), 'a hidden Desktop defers native reparenting');
  await h.controller.toggle();
  assert.equal(floating.visible, true);
  h.movePointer({ x: 1600, y: -900, width: 1000, height: 800 });
  await Promise.all([h.controller.toggle(), h.controller.toggle()]);
  assert.equal(h.controller.getSnapshot().placement, 'floating');
  assert.equal(floating.visible, true);
  assert.ok(floating.bounds.x >= 1600 && floating.bounds.x + floating.bounds.width <= 2600);
  assert.ok(floating.bounds.y >= -900 && floating.bounds.y + floating.bounds.height <= -100);
  assert.equal(h.main.visible, false);
  assert.equal(h.main.focused, mainFocusCount);
  await h.command(view.webContents, 'dock');
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.equal(h.main.visible, true, 'only the explicit dock action returns to Desktop');
  assert.ok(h.main.children.has(view));
  assert.equal(h.views.length, 1);
  assert.doesNotThrow(() => h.main.destroy());
  assert.doesNotThrow(() => h.controller.send('settings:changed'));
  await h.controller.refreshSettings();
  h.controller.dispose();
  assert.equal(view.webContents.destroyed, true);
  assert.equal(floating.destroyed, true);
  assert.equal(h.unregistered(), true);
  assert.equal(h.handler(), undefined);
  assert.deepEqual(h.registrations(), [1, 1]);
});

test('rejects unowned/subframe IPC and buffers navigation until main subscribes', async () => {
  const h = await harness();
  await assert.rejects(h.handler()!({ sender: h.main.webContents, senderFrame: {} }, 'snapshot'), /owned main frame/);
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

test('control shows a passive card only after it is painted and preserves manual conversation geometry', async () => {
  const h = await harness();
  await h.command(h.main.webContents, 'host', { visible: true, rect: { x: 0, y: 0, width: 1000, height: 800 } });
  const view = h.views[0]!;
  await h.controller.prepareControl('turn-one');
  const floating = h.windows[1]!;
  const request = h.controller.getSnapshot().progressRequest!;
  assert.equal(typeof request, 'number');
  assert.equal(floating.visible, false, 'the old chat cannot flash before the progress card is painted');
  assert.equal(view.webContents.backgroundThrottling, false, 'hidden card preparation must be able to produce animation frames');
  assert.equal(floating.bounds.width, 360);
  assert.equal(floating.bounds.height, 112);
  assert.equal(floating.resizable, false);
  assert.equal(floating.bounds.x + floating.bounds.width / 2, 600);
  assert.equal(floating.bounds.y + floating.bounds.height, 804);
  await h.command(view.webContents, 'progress-ready', request);
  assert.equal(floating.visible, true);
  assert.equal(view.webContents.backgroundThrottling, true, 'restore normal throttling after showing the card');
  assert.equal(floating.focused, 0);
  assert.equal(h.main.focused, 0, 'control does not activate the main window');
  assert.equal(h.mainRequests, 0, 'the focus-or-create fallback must not run for an existing window');
  assert.equal(h.main.visible, false, 'control does not reveal a hidden main window');
  assert.equal(view.webContents.sent.some(([channel]) => channel.endsWith('focus-composer')), false);
  await h.command(view.webContents, 'ready');
  await h.command(view.webContents, 'show-conversation');
  assert.equal(h.controller.getSnapshot().progressRequest, undefined);
  assert.equal(floating.bounds.width, 520);
  assert.equal(floating.bounds.height, 720);
  assert.equal(floating.resizable, true);
  assert.ok(view.webContents.sent.some(([channel, expand]) => channel.endsWith('focus-composer') && expand === true));
  floating.setBounds({ x: 120, y: 130, width: 520, height: 650 });
  const focused = floating.focused;
  await h.controller.prepareControl('turn-one');
  assert.deepEqual(floating.bounds, { x: 120, y: 130, width: 520, height: 650 });
  assert.equal(floating.focused, focused, 'control leaves a manually opened chat alone');
  assert.equal(h.views.length, 1);
  h.controller.dispose();
});

test('control preparation refuses disabled presentation before opening and rechecks a pending open', async () => {
  const h = await harness();
  h.setEnabled(false);
  await assert.rejects(h.controller.prepareControl(), /WorkHub is disabled/);
  assert.equal(h.mainRequests, 0);
  assert.equal(h.main.focused, 0);

  h.setEnabled(true);
  const opened = deferred<void>();
  const opening = h.deferOpening(opened.promise);
  h.setMainAvailable(false);
  const control = h.controller.prepareControl();
  await opening;
  h.setEnabled(false);
  await h.controller.refreshSettings();
  opened.resolve();
  await assert.rejects(control, /WorkHub is disabled/);
  assert.equal(h.mainRequests, 1);
  assert.equal(h.views.length, 0);
  assert.equal(h.main.focused, 0);
  h.controller.dispose();
  await assert.rejects(h.controller.prepareControl(), /disposed/);
  assert.equal(h.mainRequests, 1);
});

test('all WorkHub entries obey the client enable setting and disabling retains the renderer', async () => {
  const h = await harness();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  h.setEnabled(false);
  await h.controller.show();
  await h.controller.toggle();
  await h.command(h.main.webContents, 'host', host);
  await h.command(h.main.webContents, 'dock');
  await h.command(h.main.webContents, 'detach');
  assert.equal(h.views.length, 0, 'disabled entries must not create a conversation');
  await h.controller.refreshSettings();
  assert.equal(h.controller.getSnapshot().shortcutRegistered, false);

  h.setEnabled(true);
  await h.controller.refreshSettings();
  assert.equal(h.controller.getSnapshot().shortcutRegistered, true);
  await h.controller.show();
  const view = h.views[0]!;
  const floating = h.windows[1]!;
  await h.command(view.webContents, 'ready');
  assert.equal(floating.visible, true);
  const opened = deferred<void>();
  const opening = h.deferOpening(opened.promise);
  const docking = h.command(view.webContents, 'dock');
  await opening;
  h.setEnabled(false);
  await h.controller.refreshSettings();
  opened.resolve();
  await docking;
  await h.command(view.webContents, 'ready');
  await h.command(h.main.webContents, 'host', host);
  assert.equal(h.controller.getSnapshot().shortcutRegistered, false);
  assert.equal(floating.visible, false);
  assert.equal(view.visible, false);
  assert.equal(view.webContents.destroyed, false);
  assert.equal(h.main.webContents.sent.some(([channel]) => channel === 'workhub-presentation:open-main'), false);

  h.setEnabled(true);
  await h.controller.refreshSettings();
  await h.command(view.webContents, 'dock');
  await h.command(h.main.webContents, 'host', host);
  assert.equal(view.visible, true);
  h.setEnabled(false);
  await h.controller.refreshSettings();
  h.main.emit('resize');
  assert.equal(view.visible, false, 'layout cannot revive a disabled dock');
  h.setEnabled(true);
  await h.controller.show();
  assert.equal(h.views.length, 1, 'reenabling preserves the renderer and its draft');
  assert.equal(floating.visible, true);
  assert.deepEqual(h.registrations(), [1, 0]);
  h.controller.dispose();
});


test('creates on first shortcut, then shows and hides synchronously', async () => {
  const h = await harness();
  await h.controller.refreshSettings();
  assert.equal(h.views.length, 0, 'enabling alone must not create the renderer');
  h.shortcut();
  assert.equal(h.windows[1]!.visible, false, 'a cold summon waits for the composer to mount');
  assert.equal(h.windows[1]!.focused, 0, 'loading must not steal keyboard input');
  await h.command(h.views[0]!.webContents, 'ready');
  assert.equal(h.windows[1]!.visible, true);
  assert.equal(h.views[0]!.webContents.sent.some(([channel]) => channel === 'workhub-presentation:focus-composer'), true);
  h.shortcut();
  const floating = h.windows[1]!;
  const view = h.views[0]!;
  assert.equal(floating.visible, false);
  assert.equal(view.visible, true);
  assert.ok(floating.children.has(view));
  await h.controller.refreshSettings();
  assert.equal(h.windows.length, 2);
  assert.equal(h.views.length, 1);
  h.shortcut();
  assert.equal(floating.visible, true, 'show happens in the shortcut callback, without an async queue');
  h.shortcut();
  assert.equal(floating.visible, false);
  assert.equal(h.mainRequests, 0);
  assert.equal(h.main.focused, 0);
  h.controller.dispose();
});

test('a second shortcut or disabling cancels a cold summon before ready', async () => {
  for (const cancel of ['shortcut', 'disable'] as const) {
    const h = await harness();
    await h.controller.refreshSettings();
    h.shortcut();
    const view = h.views[0]!;
    const floating = h.windows[1]!;
    if (cancel === 'shortcut') h.shortcut();
    else {
      h.setEnabled(false);
      await h.controller.refreshSettings();
    }
    await h.command(view.webContents, 'ready');
    assert.equal(floating.visible, false, cancel);
    assert.equal(floating.focused, 0, cancel);
    assert.equal(view.webContents.sent.some(([channel]) => channel === 'workhub-presentation:focus-composer'), false, cancel);
    h.controller.dispose();
  }
});

test('a pending backdrop capture and older hide cannot delay or undo the shortcut', async () => {
  const h = await harness();
  await h.controller.refreshSettings();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  h.main.show();
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
  const started = deferred<void>();
  const capture = deferred<{ toDataURL(): string }>();
  view.webContents.capturePage = () => { started.resolve(); return capture.promise; };
  const occlude = h.command(h.main.webContents, 'host', { ...host, occluded: true });
  await started.promise;
  const olderHide = h.command(view.webContents, 'hide');
  h.shortcut();
  const floating = h.windows[1]!;
  assert.equal(floating.visible, true);
  assert.ok(floating.children.has(view));
  capture.resolve({ toDataURL: () => 'data:image/png;base64,frame' });
  await Promise.all([occlude, olderHide]);
  assert.equal(floating.visible, true, 'an older queued intent cannot hide the newer summon');
  assert.equal(view.visible, true);
  h.controller.dispose();
});

test('the shortcut supersedes a pending dock without waiting for the main window', async () => {
  const h = await harness(true);
  await h.controller.refreshSettings();
  h.shortcut();
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
  const floating = h.windows[1]!;
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 96 });
  h.advance(80);
  assert.ok(view.boundsUpdates.at(-1)!.y < 0);
  const opened = deferred<void>();
  const opening = h.deferOpening(opened.promise);
  const docking = h.command(view.webContents, 'dock');
  await opening;
  assert.deepEqual({ ...view.boundsUpdates.at(-1) }, { x: 0, y: 0, width: floating.bounds.width, height: floating.bounds.height }, 'pending docking restores normal input coordinates');
  h.shortcut();
  h.shortcut();
  assert.equal(floating.visible, true);
  assert.equal(floating.bounds.height, 720, 'cancelling must not remember the intermediate animation height');
  opened.resolve();
  await docking;
  assert.equal(h.controller.getSnapshot().placement, 'floating');
  assert.ok(floating.children.has(view));
  assert.equal(floating.visible, true);
  assert.equal(h.main.focused, 0);
  h.controller.dispose();
});


test('native resize callbacks do not submit duplicate view bounds and follow display cadence', async () => {
  const h = await harness(true, 120);
  await h.controller.show();
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
  view.webContents.getZoomFactor = () => 2;
  await h.command(view.webContents, 'conversation-layout', { expanded: true, compactHeight: 96 });
  const before = view.boundsUpdates.length;
  h.advance(9);
  assert.ok(view.boundsUpdates.length > before, 'a 120Hz display gets its next animation frame before 16ms');
  assert.equal(view.boundsUpdates.length - before, 1, 'an early timer must not submit a second resize for the same display frame');
  const floating = h.windows[1]!;
  assert.equal(floating.cornerRadius, 40, 'native clipping follows renderer zoom');
  assert.equal(view.webContents.sent.filter(([channel]) => channel.endsWith('viewport-inset')).at(-1)![1], (720 - floating.bounds.height) / 2, 'renderer offsets use CSS pixels');
  h.advance(411);
  assert.equal(h.windows[1]!.bounds.height, 720);
  for (let index = 1; index < view.boundsUpdates.length; index++) {
    assert.notDeepEqual(view.boundsUpdates[index], view.boundsUpdates[index - 1]);
  }
  h.controller.dispose();
});


test('hiding returns the live view to Desktop and preserves floating geometry for the next summon', async () => {
  const h = await harness();
  h.main.show();
  await h.controller.refreshSettings();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  h.shortcut();
  const floating = h.windows[1]!;
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 144 });
  h.shortcut();
  assert.equal(floating.visible, false);
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.ok(h.main.children.has(view));
  assert.equal(view.visible, true);
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 96 });
  h.shortcut();
  assert.equal(floating.visible, true);
  assert.equal(floating.bounds.height, 144, 'Desktop geometry does not shrink the floating composer');
  assert.ok(floating.children.has(view));
  assert.equal(h.mainRequests, 0);
  assert.equal(h.main.focused, 0);
  assert.equal(h.views.length, 1);
  assert.equal(h.windows.length, 2);
  h.controller.dispose();
});

test('hiding with Desktop closed keeps the conversation alive without reopening Desktop', async () => {
  const h = await harness();
  await h.controller.show();
  const view = h.views[0]!;
  await h.command(view.webContents, 'ready');
  h.main.destroy();
  await h.controller.toggle();
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.equal(h.windows[1]!.visible, false);
  assert.ok(h.windows[1]!.children.has(view));
  assert.equal(view.webContents.destroyed, false);
  await h.controller.toggle();
  assert.equal(h.windows[1]!.visible, true);
  assert.equal(h.mainRequests, 0);
  assert.equal(h.views.length, 1);
  h.controller.dispose();
});


test('a hidden Desktop defers native docking until it shows', async () => {
  const h = await harness();
  await h.controller.refreshSettings();
  const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
  await h.command(h.main.webContents, 'host', host);
  h.shortcut();
  const view = h.views[0]!;
  const floating = h.windows[1]!;
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 144 });
  const before = view.boundsUpdates.length;
  h.shortcut();
  await h.command(h.main.webContents, 'host', host);
  assert.equal(h.controller.getSnapshot().placement, 'docked');
  assert.equal(floating.visible, false);
  assert.ok(floating.children.has(view));
  assert.equal(view.boundsUpdates.length, before, 'hiding does not resize an invisible conversation');
  await h.command(view.webContents, 'conversation-layout', { expanded: false, compactHeight: 96 });
  h.shortcut();
  assert.equal(floating.bounds.height, 144);
  h.shortcut();
  h.main.show();
  assert.ok(h.main.children.has(view), 'Desktop receives the conversation in its show callback');
  assert.equal(view.visible, true);
  assert.equal(h.main.focused, 0);
  assert.equal(h.mainRequests, 0);
  assert.equal(h.views.length, 1);
  h.controller.dispose();
});


test('control keeps a visible Desktop conversation docked and floats it when the host is hidden or occluded', async () => {
  for (const hidden of [{ visible: false }, { occluded: true }]) {
    const h = await harness();
    h.main.show();
    const host = { visible: true, rect: { x: 200, y: 40, width: 800, height: 760 } };
    await h.command(h.main.webContents, 'host', host);
    const view = h.views[0]!;
    await h.controller.prepareControl('turn');
    assert.equal(h.controller.getSnapshot().placement, 'docked');
    assert.equal(h.windows.length, 1, 'control does not create an unnecessary floating window');
    assert.ok(h.main.children.has(view));
    assert.equal(view.visible, true);
    await h.command(h.main.webContents, 'host', { ...host, ...hidden });
    await h.controller.prepareControl('turn');
    assert.equal(h.controller.getSnapshot().placement, 'floating');
    assert.equal(typeof h.controller.getSnapshot().progressRequest, 'number');
    await h.command(view.webContents, 'progress-ready', h.controller.getSnapshot().progressRequest);
    assert.ok(h.windows[1]!.visible && h.windows[1]!.children.has(view));
    assert.equal(h.views.length, 1);
    h.controller.dispose();
  }
});


test('closing progress suppresses the current turn and old paint acknowledgements cannot reopen it', async () => {
  const h = await harness();
  await h.controller.prepareControl('turn-one');
  const view = h.views[0]!;
  const first = h.controller.getSnapshot().progressRequest!;
  assert.equal(view.webContents.backgroundThrottling, false);
  await h.command(view.webContents, 'hide');
  assert.equal(view.webContents.backgroundThrottling, true, 'cancelling preparation restores normal background behavior');
  await h.command(view.webContents, 'progress-ready', first);
  await h.controller.prepareControl('turn-one');
  assert.equal(h.controller.getSnapshot().progressRequest, undefined);
  assert.equal(h.windows[1]!.visible, false);
  await h.controller.prepareControl('turn-two');
  assert.notEqual(h.controller.getSnapshot().progressRequest, undefined);
  h.controller.finishControl();
  await h.command(view.webContents, 'hide');
  await h.command(h.main.webContents, 'host', { visible: false, rect: { x: 0, y: 0, width: 0, height: 0 } });
  assert.equal(h.windows[1]!.visible, false);
  h.controller.dispose();
});

test('the shortcut opens the normal composer from progress without waiting for its paint', async () => {
  const h = await harness();
  await h.controller.prepareControl('turn');
  await h.command(h.views[0]!.webContents, 'ready');
  const request = h.controller.getSnapshot().progressRequest!;
  await h.controller.toggle(true);
  const floating = h.windows[1]!;
  assert.equal(h.controller.getSnapshot().progressRequest, undefined);
  assert.equal(floating.visible, true);
  assert.equal(floating.bounds.width, 520);
  assert.equal(h.views[0]!.webContents.backgroundThrottling, true);
  await h.command(h.views[0]!.webContents, 'progress-ready', request);
  assert.equal(floating.bounds.width, 520);
  h.controller.dispose();
});


test('editing progress grows at its existing bottom and opening interpolates both dimensions without stealing focus', async () => {
  const h = await harness(true);
  await h.controller.prepareControl('turn');
  const view = h.views[0]!;
  const floating = h.windows[1]!;
  const request = h.controller.getSnapshot().progressRequest!;
  await h.command(view.webContents, 'ready');
  await h.command(view.webContents, 'progress-ready', request);
  floating.isFocused = () => false;
  const bottom = floating.bounds.y + floating.bounds.height;
  const center = floating.bounds.x + floating.bounds.width / 2;
  await assert.rejects(h.command(h.main.webContents, 'progress-layout', { request, height: 180 }), /Only the WorkHub view/);
  await assert.rejects(h.command(view.webContents, 'progress-layout', { request, height: NaN }), /Invalid WorkHub progress layout/);
  await h.command(view.webContents, 'progress-layout', { request, height: 180 });
  h.advance(80);
  assert.ok(floating.bounds.height > 112 && floating.bounds.height < 180);
  assert.equal(floating.bounds.width, 360);
  assert.equal(floating.cornerRadius, 18, 'the native card clips the moving canvas at its visible edge');
  assert.equal(floating.bounds.y + floating.bounds.height, bottom);
  assert.equal(h.controller.getSnapshot().progressRequest, request, 'editing does not open the conversation');
  assert.equal(view.boundsUpdates.at(-1)!.height, 180);
  assert.equal(view.boundsUpdates.at(-1)!.y + 180, floating.bounds.height);
  h.advance(340);
  assert.equal(floating.bounds.height, 180);
  await h.command(view.webContents, 'show-conversation', request);
  h.advance(80);
  assert.ok(floating.bounds.width > 360 && floating.bounds.width < 520);
  assert.ok(floating.bounds.height > 180 && floating.bounds.height < 720);
  assert.ok(Math.abs(floating.bounds.x + floating.bounds.width / 2 - center) <= 0.5);
  assert.equal(floating.bounds.y + floating.bounds.height, bottom);
  assert.equal(view.boundsUpdates.at(-1)!.height, 720, 'opening the card changes width without relaying height through layout');
  h.advance(340);
  assert.equal(floating.bounds.height, 720);
  assert.equal(floating.bounds.width, 520);
  assert.equal(floating.cornerRadius, 20);
  assert.deepEqual({ ...view.boundsUpdates.at(-1) }, { x: 0, y: 0, width: 520, height: 720 });
  assert.equal(floating.focused, 0);
  assert.equal(h.main.focused, 0);
  assert.equal(view.webContents.sent.some(([channel]) => channel.endsWith('focus-composer')), false);
  h.controller.dispose();
});

test('late progress measurements and send acknowledgements cannot revive a dismissed card or invalidate the next card paint', async () => {
  const h = await harness();
  await h.controller.prepareControl('first');
  const view = h.views[0]!;
  const first = h.controller.getSnapshot().progressRequest!;
  await h.command(view.webContents, 'hide');
  await h.command(view.webContents, 'show-conversation', first);
  assert.equal(h.controller.getSnapshot().floatingVisible, false);
  await h.controller.prepareControl('second');
  const second = h.controller.getSnapshot().progressRequest!;
  await h.command(view.webContents, 'show-conversation', first);
  await h.command(view.webContents, 'progress-layout', { request: first, height: 600 });
  await h.command(view.webContents, 'progress-ready', second);
  assert.equal(h.controller.getSnapshot().floatingVisible, true);
  assert.equal(h.windows[1]!.bounds.height, 112);
  await h.command(view.webContents, 'progress-layout', { request: second, height: 180 });
  assert.equal(h.windows[1]!.bounds.height, 180, 'reduced motion applies the final layout immediately');
  assert.equal(h.controller.getSnapshot().progressRequest, second);
  h.controller.dispose();
});

const REVEALS = {
  hidden: { shown: 0, shownInactive: 0, focused: 0 },
  inactive: { shown: 0, shownInactive: 1, focused: 0 },
  active: { shown: 1, shownInactive: 0, focused: 1 },
} as const;
const reveals = (win: { shown: number; shownInactive: number; focused: number }) =>
  ({ shown: win.shown, shownInactive: win.shownInactive, focused: win.focused });

test('summoning and docking honor the run reveal mode', async () => {
  for (const mode of ['hidden', 'inactive', 'active'] as const) {
    const h = await harness(false, 60, mode);
    await h.controller.show();
    assert.deepEqual(reveals(h.windows[1]!), REVEALS.hidden, `a cold summon reveals nothing in ${mode}`);
    await h.command(h.views[0]!.webContents, 'ready');
    assert.deepEqual(reveals(h.windows[1]!), REVEALS[mode], `detach in ${mode}`);
    await h.command(h.views[0]!.webContents, 'dock');
    assert.deepEqual(reveals(h.main), REVEALS[mode], `dock in ${mode}`);
    h.controller.dispose();
  }
});

test('the progress card stays hidden in a hidden run and inactive everywhere else', async () => {
  for (const mode of ['hidden', 'inactive', 'active'] as const) {
    const h = await harness(false, 60, mode);
    await h.controller.prepareControl('turn');
    await h.command(h.views[0]!.webContents, 'progress-ready', h.controller.getSnapshot().progressRequest);
    assert.deepEqual(reveals(h.windows[1]!), mode === 'hidden' ? REVEALS.hidden : REVEALS.inactive, mode);
    h.controller.dispose();
  }
});
