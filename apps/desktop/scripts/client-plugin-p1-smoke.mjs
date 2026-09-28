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

// Run with: node apps/desktop/scripts/client-plugin-p1-smoke.mjs
// Uses an isolated Electron profile and a test-only package; never touches the user's app.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const repo = resolve(import.meta.dirname, '../../..');
if (!process.versions.electron) {
  const { build } = await import('esbuild');
  const root = await mkdtemp(join(tmpdir(), 'maka-plugin-p1-'));
  try {
    await build({
      stdin: {
        contents: `
      import { contextBridge, ipcRenderer } from 'electron';
      import { createClientPluginRouting } from './apps/desktop/src/preload/client-plugin-routing.ts';
      import { parseDesktopSessionKey } from './apps/desktop/src/shared/runtime-host-identity.ts';
      const scope = {hostId:'smoke-host',targetEpoch:'smoke-epoch'};
      contextBridge.exposeInMainWorld('bridge', createClientPluginRouting({
        activeScope:async()=>scope,
        sessionRef:async(id)=>({scope,sessionId:parseDesktopSessionKey(id).sessionId}),
        invoke:(channel,target,input)=>ipcRenderer.invoke(channel,target,input),
      }));
      contextBridge.exposeInMainWorld('control', {reconcile:()=>ipcRenderer.invoke('smoke:reconcile'),close:()=>ipcRenderer.invoke('smoke:close')});
    `,
        resolveDir: repo,
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron'],
      outfile: join(root, 'preload.cjs'),
    });
    await build({
      stdin: {
        contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {ClientPluginRuntime,MakaClientRoot,MakaClientRootOutlet} from './packages/ui/src/client-plugin-runtime.tsx';
      const root = new MakaClientRoot();
      const runtime = new ClientPluginRuntime({root,staticModules:{react:React},remote:{
        call:window.bridge.remoteCall,open:window.bridge.remoteStreamOpen,next:window.bridge.remoteStreamNext,close:window.bridge.remoteStreamClose
      }});
      runtime.attachLoader();
      createRoot(document.getElementById('app'),{onCaughtError(){}}).render(React.createElement(MakaClientRootOutlet,{root},React.createElement('button',{id:'builtin'},'Maka app')));
      window.runSmoke = async()=>{
        await runtime.reconcile(await window.bridge.snapshot());
        while(!window.crashRoot) await new Promise(r=>setTimeout(r,10));
        const ctx=window.pluginContext;
        let setups=0,cleanups=0;
        const stop=ctx.effect(()=>{setups++;return()=>{cleanups++;};});
        stop();stop();await Promise.resolve();
        const sessionId=JSON.stringify(['smoke-host','session-a']);
        const echoed=await ctx.remote.call('smoke.echo',{}, {sessionId});
        const stream=ctx.remote.stream('smoke.watch',{}, {sessionId})[Symbol.asyncIterator]();
        const first=await stream.next();await stream.return();
        window.crashRoot();
        await new Promise(r=>setTimeout(r,50));
        const survived=!!document.querySelector('#builtin');
        await window.control.reconcile();
        const snapshot=await window.bridge.snapshot();
        const served=await fetch(snapshot.plugins[0].url).then(r=>r.status);
        await runtime.reconcile(snapshot);
        const request=window.pluginContext.remote.call('smoke.hang',{}).then(()=>false,()=>true);
        await new Promise(r=>setTimeout(r,30));
        await window.bridge.snapshot();
        await window.control.close();
        const cancelled=await request;
        await runtime.close();
        return {setups,cleanups,echoed,first,survived,served,cancelled};
      };
    `,
        resolveDir: repo,
        loader: 'tsx',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: join(root, 'renderer.js'),
    });
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><html><body><div id="app"></div><script src="renderer.js"></script></body></html>',
    );
    const electron = (await import('electron')).default;
    const child = spawn(electron, [import.meta.filename, root], {
      stdio: 'inherit',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 45000);
    const code = await new Promise((done) => child.on('exit', done));
    clearTimeout(timeout);
    assert.equal(code, 0, 'Electron plugin P1 smoke must pass');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
} else {
  // Electron emits ready after evaluating its ESM entry; do not await it at top level.
  void (async () => {
    const root = process.argv[2];
    const { app, BrowserWindow, ipcMain, protocol } = createRequire(import.meta.url)('electron');
    app.setPath('userData', join(root, 'profile'));
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'maka-client-plugin',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
      },
    ]);
    const load = (path) => import(pathToFileURL(join(repo, path)).href);
    const { Context } = await load('packages/runtime/dist/plugin-kernel.js');
    const { PluginClientBridgeService } = await load(
      'packages/runtime/dist/plugin-client-bridge-service.js',
    );
    const { MakaCompositionLoader } = await load(
      'packages/runtime/dist/plugin-composition-loader.js',
    );
    const { HostPluginPlatform } = await load(
      'packages/runtime-host/dist/server/plugin-platform.js',
    );
    const { HostPluginPlatformCoordinator } = await load(
      'packages/runtime-host/dist/server/plugin-platform-coordinator.js',
    );
    const { ClientPluginTransport, registerClientPluginIpc } = await load(
      'apps/desktop/dist/main/client-plugin-transport.js',
    );
    await app.whenReady();
    const pluginRoot = new Context();
    const clientBridge = new PluginClientBridgeService(pluginRoot);
    const platform = new HostPluginPlatform(join(root, 'control'), {
      composition: new MakaCompositionLoader({ root: pluginRoot }),
      clientBridge,
    });
    const coordinator = new HostPluginPlatformCoordinator(platform);
    const transport = new ClientPluginTransport();
    const client = {
      async request(operation, input) {
        const result = await coordinator.handlers[operation](input, {
          connectionId: 'smoke',
          hostEpoch: 'smoke-epoch',
          principal: 'owner',
          acquireResidency: () => ({ release() {} }),
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.result;
      },
    };
    const source = join(root, 'plugin');
    await mkdir(source);
    await writeFile(
      join(source, 'maka.extension.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'smoke',
        runtime: { entry: 'host.mjs' },
        client: { entry: 'client.js' },
        composition: { patch: 'maka.composition.yml' },
      }),
    );
    await writeFile(
      join(source, 'host.mjs'),
      `export default {packageId:'smoke',host:{apply(ctx){ctx.clientBridge.rpc({name:'smoke.echo',invoke:()=>({owner:'profile'})});ctx.clientBridge.rpc({name:'smoke.hang',invoke:()=>new Promise(()=>{})});}}};`,
    );
    await writeFile(
      join(source, 'client.js'),
      `window.__MakaModuleLoader__.load({id:'smoke',factory(require){const React=require('react');return {apply(ctx){window.pluginContext=ctx;ctx.slots.register({name:'root'},({children})=>{const [failed,fail]=React.useState(false);window.crashRoot=()=>fail(true);if(failed)throw Error('intentional plugin failure');return React.createElement('section',{},children);});}};}});`,
    );
    await writeFile(
      join(source, 'maka.composition.yml'),
      JSON.stringify([
        { type: 'insert', rootId: 'profile', entry: { id: 'smoke-host', packageId: 'smoke' } },
        { type: 'insert', rootId: 'desktop-ui', entry: { id: 'smoke-ui', packageId: 'smoke' } },
      ]),
    );
    await platform.recover();
    await platform.installPackage(source);
    const session = pluginRoot.extend({
      maka: {
        rootId: 'session:session-a',
        packageId: 'smoke',
        entryId: 'session-handler',
        generation: 1,
      },
    });
    session.clientBridge.rpc({
      name: 'smoke.echo',
      invoke: (_input, ctx) => ({ owner: 'session', sessionId: ctx.sessionId }),
    });
    session.clientBridge.stream({
      name: 'smoke.watch',
      open: async function* () {
        yield 'session-stream';
      },
    });
    registerClientPluginIpc({
      ipcMain: {
        handle: (channel, handler) =>
          ipcMain.handle(channel, (event, _scope, input) => handler(event, input)),
      },
      client,
      transport,
    });
    ipcMain.handle('smoke:reconcile', () => platform.reconcile());
    ipcMain.handle('smoke:close', () => platform.close());
    protocol.handle('maka-client-plugin', (request) => transport.serve(request.url));
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(root, 'preload.cjs'),
        contextIsolation: true,
        sandbox: false,
      },
    });
    try {
      await window.loadFile(join(root, 'index.html'));
      const result = await window.webContents.executeJavaScript('window.runSmoke()');
      assert.deepEqual(result, {
        setups: 1,
        cleanups: 1,
        echoed: { owner: 'session', sessionId: 'session-a' },
        first: { done: false, value: 'session-stream' },
        survived: true,
        served: 200,
        cancelled: true,
      });
      console.log('Electron plugin P1 smoke PASS', JSON.stringify(result));
      window.destroy();
      transport.release(client);
      await platform.close();
      await pluginRoot.fiber.dispose();
      app.exit(0);
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  })().catch((error) => {
    console.error(error);
    createRequire(import.meta.url)('electron').app.exit(1);
  });
}
