#!/usr/bin/env electron
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

/**
 * Native compositor regression: CDP can read a nested WebContentsView even when
 * the user sees a blank panel. Exercise the production presentation + browser
 * IPC and assert screen pixels, including Main/WorkHub ownership transitions.
 * Run under a visible desktop (or xvfb-run), after build:main.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app, BrowserWindow, desktopCapturer, screen } from 'electron';
import { createWorkHubPresentation } from '../dist/main/workhub-presentation.js';
import { desktopSessionResourceKey } from '../dist/shared/runtime-host-identity.js';
import { registerBrowserIpc } from '../dist/main/browser-ipc-main.js';
import { BrowserViewController } from '../dist/main/browser/controller.js';
import { BrowserViewManager } from '../dist/main/browser/view-manager.js';
import { browserViewHost, provideBrowserViewHost } from '../dist/main/browser/browser-host.js';

const temp = mkdtempSync(join(tmpdir(), 'maka-workhub-native-'));
app.setPath('userData', join(temp, 'state'));
console.log(`Test data: ${temp}`);
const deadline = setTimeout(() => { console.error('Native WorkHub browser smoke timed out'); app.exit(1); }, 30_000);
const scope = { hostId: 'smoke-host', targetEpoch: 'smoke-epoch' };
const sessionId = 'maka_workhub_coordination';
const command = (wc, name, value) => wc.executeJavaScript(`nativeSmoke.command(${JSON.stringify(name)}, ${JSON.stringify(value)})`);
const send = (wc, channel, ...args) => wc.executeJavaScript(`nativeSmoke.send(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const output = process.env.MAKA_NATIVE_SCREENSHOTS;

async function run() {
  await app.whenReady();
  const preload = join(temp, 'preload.cjs');
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('nativeSmoke',{capture:(scope,id)=>ipcRenderer.invoke('browser:capture-page',scope,id),command:(name,value)=>ipcRenderer.invoke('workhub-presentation:command',name,value),send:(channel,...args)=>ipcRenderer.send(channel,...args)});`);
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const page = req.url.startsWith('/page');
    res.end(page ? '<body style="background:rgb(250,54,171);font:24px sans-serif"><h1>Visible browser page</h1><input id="q"><button onclick="this.textContent=\'Clicked\'">Test</button></body>' : '<body style="background:#171717;color:white;font:20px sans-serif"><h1>WorkHub</h1><p>Conversation stays independent of the browser panel.</p></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let main = new BrowserWindow({ show: true, width: 1000, height: 750, x: 30, y: 30, webPreferences: { preload } });
  await main.loadURL(url);
  let owner;
  let ownerParent;
  let parentResolver;
  const views = new BrowserViewManager({ create: (id) => new BrowserViewController(parentResolver(id), id, () => {}) });
  const presentation = createWorkHubPresentation({
    mainWindow: () => main.isDestroyed() ? undefined : main,
    ensureMainWindow: async () => main,
    isEnabled: () => true, revealMode: 'active', mainModuleDirectory: temp, viteDevServerUrl: url, preloadPath: preload,
    onViewCreated: (contents, container) => { owner = contents; ownerParent = container; },
  });
  presentation.registerIpc();
  presentation.attachMainWindow(main);
  registerBrowserIpc({
    mainWindowController: {
      getBrowserViews: () => views,
      ownsRenderer: (wc) => !wc.isDestroyed() && (wc === owner || (!main.isDestroyed() && wc === main.webContents)),
      isMainRenderer: (wc) => !main.isDestroyed() && wc === main.webContents,
      browserParentForRenderer: (wc) => wc === owner ? ownerParent : main.contentView,
      setBrowserViewParentResolver: (resolve) => { parentResolver = resolve; },
    },
    isHostActive: (ref) => ref.hostId === scope.hostId && ref.targetEpoch === scope.targetEpoch,
  });
  const host = { visible: true, rect: { x: 0, y: 0, width: 470, height: 700 } };
  const rect = { x: 500, y: 80, width: 430, height: 560 };
  const viewport = (r) => send(main.webContents, 'browser:setViewport', scope, { sessionId, rect: r }, 'main', 1);
  let controller;
  try {
    await command(main.webContents, 'host', host);
    while (owner.isLoading()) await wait(10);
    await command(owner, 'ready');
    await send(owner, 'browser:document-ready', 'owner');
    await send(owner, 'browser:active-session', scope, sessionId, 'owner', 1);
    await send(main.webContents, 'browser:document-ready', 'main');
    await send(main.webContents, 'browser:active-session', scope, sessionId, 'main', 1);
    // Use the actual IPC owner resolver, not an independently constructed tree.
    controller = views.getOrCreate(desktopSessionResourceKey({ ...scope, sessionId }));
    await controller.navigate(`${url}/page`);
    await viewport(rect);

    const capture = async (label, expected, menuExpected = false) => {
      let crop;
      let colored = 0;
      let menuPixels = 0;
      const deadline = Date.now() + 3_000;
      do {
        const bounds = main.getBounds();
        const display = screen.getDisplayMatching(bounds);
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: display.size.width, height: display.size.height } });
        const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
        const image = source.thumbnail;
        const scale = image.getSize().width / display.size.width;
        crop = image.crop({ x: Math.max(0, Math.round((bounds.x - display.bounds.x) * scale)), y: Math.max(0, Math.round((bounds.y - display.bounds.y) * scale)), width: Math.min(Math.round(bounds.width * scale), image.getSize().width), height: Math.min(Math.round(bounds.height * scale), image.getSize().height) });
        const bytes = crop.toBitmap();
        colored = 0;
        menuPixels = 0;
        for (let i = 0; i < bytes.length; i += 4) if (Math.abs(bytes[i] - 171) < 5 && Math.abs(bytes[i + 1] - 54) < 5 && Math.abs(bytes[i + 2] - 250) < 5) colored++;
        for (let i = 0; i < bytes.length; i += 4) if (Math.abs(bytes[i] - 99) < 5 && Math.abs(bytes[i + 1] - 222) < 5 && Math.abs(bytes[i + 2] - 33) < 5) menuPixels++;
        if ((colored > 10_000) === expected && (!menuExpected || menuPixels > 5_000)) break;
        await wait(50);
      } while (Date.now() < deadline);
      assert.equal(colored > 10_000, expected, `${label}: screen contains ${colored} browser pixels`);
      if (menuExpected) assert.ok(menuPixels > 5_000, `${label}: DOM menu must paint above the browser backdrop (${menuPixels} pixels)`);
      if (output) writeFileSync(join(output, `${label}.png`), crop.toPNG());
      console.log(`PASS ${label}: ${colored} visible browser pixels`);
    };
    await capture('docked', true);
    const backdrop = await main.webContents.executeJavaScript(`nativeSmoke.capture(${JSON.stringify(scope)}, ${JSON.stringify(sessionId)})`);
    assert.ok(backdrop?.startsWith('data:image/png;base64,'));
    await main.webContents.executeJavaScript(`(() => {
      const image = document.createElement('img'); image.id = 'backdrop'; image.src = ${JSON.stringify(backdrop)};
      Object.assign(image.style, {position:'fixed',left:'500px',top:'80px',width:'430px',height:'560px'}); document.body.append(image);
      const menu = document.createElement('div'); menu.id = 'menu'; menu.popover = 'auto'; menu.textContent = 'Panel menu';
      Object.assign(menu.style, {position:'fixed',left:'520px',top:'100px',width:'220px',height:'200px',margin:'0',background:'rgb(33,222,99)'});
      document.body.append(menu); menu.showPopover();
      return image.decode();
    })()`);
    await viewport(null);
    await capture('menu-overlay', true, true);
    await main.webContents.executeJavaScript(`document.querySelector('#menu').remove(); document.querySelector('#backdrop').remove()`);
    await viewport(rect);
    await capture('menu-dismissed', true);
    await command(owner, 'conversation-layout', { expanded: true, compactHeight: 96 });
    await command(owner, 'detach');
    const floating = BrowserWindow.fromWebContents(owner);
    // Keep both windows visible so screen pixels prove where the page resides.
    floating.setBounds({ x: main.getBounds().x + main.getBounds().width + 10, y: 30, width: 360, height: 650 });
    assert.ok(controller.hasParent(main.contentView));
    await capture('floating-conversation', true);
    assert.equal(ownerParent.children.length, 1, 'only the conversation lives in its floating container');
    await command(main.webContents, 'host', { ...host, visible: false });
    await viewport(null);
    await capture('panel-hidden', false);
    assert.equal(await browserViewHost().canDrive(views.sessionIds()[0], 'mutate'), true);
    await controller.attachAutomation();
    const lease = controller.beginBackgroundAction();
    await lease.ready;
    await controller.navigate(`${url}/page?background`);
    await lease.release();
    await command(main.webContents, 'host', host);
    await viewport(rect);
    await capture('background-restored', true);
    await command(owner, 'dock');
    await capture('redocked', true);
    await command(owner, 'detach');
    main.close();
    await wait(100);
    assert.ok(controller.hasParent(ownerParent));
    assert.equal(controller.state().hasPage, true);
    const closedMainLease = controller.beginBackgroundAction();
    await closedMainLease.ready;
    await controller.navigate(`${url}/page?main-closed`);
    const page = ownerParent.children.find((child) => 'webContents' in child && child.webContents !== owner).webContents;
    const point = await page.executeJavaScript(`(() => { const r = document.querySelector('button').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
    await page.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    assert.equal(await page.executeJavaScript("document.querySelector('button').textContent"), 'Clicked');
    await closedMainLease.release();
    console.log('PASS closing Main preserves the background page and native clicks');
  } finally {
    await views.disposeAll();
    provideBrowserViewHost(null);
    presentation.dispose();
    if (!main.isDestroyed()) main.destroy();
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(deadline);
  }
  app.quit();
}
run().catch((error) => { console.error(error); app.exit(1); });
