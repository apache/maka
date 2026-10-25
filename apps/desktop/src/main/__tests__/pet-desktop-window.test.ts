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
import { test } from 'node:test';
import { build } from 'esbuild';
import type { createPetDesktop } from '../pet-desktop.js';

async function harness(selectedPetId: string | null = null) {
  const source = new URL('../../../src/main/pet-desktop.ts', import.meta.url);
  const bundled = await build({ entryPoints:[fileURLToPath(source)], bundle:true, platform:'node', format:'cjs', write:false,
    external:['electron','@maka/storage/*'], define:{'import.meta.url':JSON.stringify(source.href)}, logLevel:'silent' });
  const windows: FakeWindow[] = [];
  class Contents extends EventEmitter {
    sent: any[] = [];
    backgroundThrottling = true;
    focused = false;
    focus() { this.focused = true; }
    send(...args: any[]) { this.sent.push(args); }
    setWindowOpenHandler() {}
    setBackgroundThrottling(value: boolean) { this.backgroundThrottling = value; }
  }
  class FakeWindow extends EventEmitter {
    webContents = new Contents();
    destroyed = false;
    visible = false;
    workspaces: any[] = [];
    constructor(public options: any = {}) { super(); windows.push(this); }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    hide() { this.visible = false; }
    showInactive() { this.visible = true; }
    ignoring = true;
    setIgnoreMouseEvents(value: boolean) { this.ignoring = value; }
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces(...args: any[]) { this.workspaces = args; }
    bounds = {x:0,y:0,width:340,height:390};
    getBounds() { return {...this.bounds}; }
    setPosition(x:number,y:number) { this.bounds.x=x; this.bounds.y=y; }
    setBounds(value:any) { this.bounds={...value}; }
    focused = false;
    focus() { this.focused = true; this.emit("focus"); }
    blur() {}
    async loadFile() { this.emit('ready-to-show'); }
  }
  const main = new FakeWindow();
  windows.length = 0;
  const app = Object.assign(new EventEmitter(), { activated: false, focus() { this.activated = true; } });
  const ipc = new EventEmitter() as EventEmitter & { handle(name:string, handler:Function):void };
  const handlers = new Map<string, Function>();
  ipc.handle = (name, handler) => { handlers.set(name, handler); };
  const screen = Object.assign(new EventEmitter(), { getDisplayMatching:()=>({workArea:{x:0,y:0,width:1400,height:900}}), getPrimaryDisplay:()=>({workArea:{x:0,y:0,width:1400,height:900}}) });
  const electron = {app,ipcMain:ipc,screen,BrowserWindow:FakeWindow};
  let settings = {personalization:{selectedPetId,petMode:'session'}};
  const store = {get:async()=>settings, update:async(patch:any)=> { settings = { personalization:{...settings.personalization,...patch.personalization} }; return settings; }};
  const module = {exports:{} as {createPetDesktop: typeof createPetDesktop}};
  const require = createRequire(import.meta.url);
  runInNewContext(bundled.outputFiles[0]!.text, { module,exports:module.exports,Buffer,console,process,
    require:(name:string)=> name==='electron' ? electron : name==='@maka/storage/pet-pack-store' ?
      {createPetPackStore:()=>({ get:async(id:string)=>({id}),readSpriteSheet:async()=>({format:'png',bytes:Buffer.from('test')}) })} : require(name) });
  let focuses=0;
  const submitted: any[] = [];
  const controller = module.exports.createPetDesktop({ workspaceRoot:'/tmp/fixture',settingsStore:store as any,
    assistantChat: { cardAction: async input => { submitted.push(input); return {selectedKey: input.actionKey ?? null}; }, target: async () => 'assistant-target', send: async input => { submitted.push(input); } },
    mainWindowController:{isMainRenderer:(sender:any)=>sender===main.webContents,browserWindow:()=>main,
      send:(...args:any[])=>main.webContents.send(...args),focus:()=>{focuses++;}} as any });
  await controller.refresh();
  return {windows,main,app,ipc,store,controller,handlers,submitted,focuses:()=>focuses};
}

test('disabled pets do not create a window; enabled pets use a sandboxed fullscreen companion', async()=>{
  const h=await harness(); assert.equal(h.windows.length,0);
  await h.store.update({personalization:{selectedPetId:'test'}}); await h.controller.refresh();
  const win=h.windows[0]!; assert.equal(win.options.webPreferences.sandbox,true);
  assert.equal(win.options.webPreferences.nodeIntegration,false);
  assert.equal(win.options.alwaysOnTop,true);
  if(process.platform==='darwin') {assert.equal(win.options.type,'panel');assert.equal(win.workspaces[1].visibleOnFullScreen,true);}
  assert.equal(win.visible,true);
  assert.equal(h.main.webContents.backgroundThrottling,false);
});
test('main close hides chat while pet is enabled; cancelled quit preserves the pet; real quit destroys it',async()=>{
  const h=await harness('test'); let prevented=false;
  h.main.emit('close',{preventDefault:()=>{prevented=true}});assert.equal(prevented,true);
  h.app.emit('before-quit',{defaultPrevented:true});assert.equal(h.windows[0]!.destroyed,false);
  h.app.emit('before-quit',{defaultPrevented:false});assert.equal(h.windows[0]!.destroyed,true);
  prevented=false;h.main.emit('close',{preventDefault:()=>{prevented=true}});assert.equal(prevented,false);
});
test('only the main renderer can publish; only the pet can request navigation',async()=>{
  const h=await harness('test'); const win=h.windows[0]!;
  const publish={kind:'session',surface:{activity:'working',label:'run',sessionId:'s'}};
  h.ipc.emit('pet-desktop:publish',{sender:{}},publish);
  assert.notEqual(win.webContents.sent.at(-1)?.[1]?.surface?.label,'run');
  h.ipc.emit('pet-desktop:publish',{sender:h.main.webContents},publish);
  assert.equal(win.webContents.sent.at(-1)?.[1]?.surface.label,'run');
  h.ipc.emit('pet-desktop:action',{sender:{}},'open');assert.equal(h.focuses(),0);
  h.ipc.emit('pet-desktop:action',{sender:win.webContents},'open');assert.equal(h.focuses(),1);
  assert.equal(h.main.webContents.sent.at(-1)?.[1],'s');
  await h.store.update({personalization:{selectedPetId:null}});await h.controller.refresh();
  assert.equal(win.destroyed,true);assert.equal(h.main.webContents.backgroundThrottling,true);
});

test('pet composer submits through scoped IPC without opening the main window', async () => {
  const h = await harness('test');
  const sender = h.windows[0]!.webContents;
  await assert.rejects(h.handlers.get('pet-desktop:chat-target')!({sender:{}}), /Invalid pet client/);
  assert.equal(await h.handlers.get('pet-desktop:chat-target')!({sender}), 'assistant-target');
  assert.equal((await h.store.get()).personalization.petMode, 'assistant');
  const input = {target:'assistant-target', id:'message-1', text:'你好'};
  await h.handlers.get('pet-desktop:chat-send')!({sender}, input);
  assert.deepEqual(JSON.parse(JSON.stringify(h.submitted)), [input]);
  assert.equal(h.focuses(), 0);
  await assert.rejects(h.handlers.get('pet-desktop:chat-send')!({sender}, {...input, text:'  '}));
  await assert.rejects(h.handlers.get('pet-desktop:chat-send')!({sender:{}}, input));
});

 test('compact layout anchors the pet and flips the bubble below it at the top edge', async () => {
  const h = await harness('test'), win = h.windows[0]!;
  const sender = win.webContents;
  win.setPosition(500,400);
  h.ipc.emit('pet-desktop:layout',{sender},{height:280,petTop:96,below:false});
  assert.equal(win.getBounds().height,280);
  assert.equal(win.getBounds().y+96,590);
  win.setPosition(500,-70);
  h.ipc.emit('pet-desktop:action',{sender},'drag-end');
  assert.deepEqual(JSON.parse(JSON.stringify(win.webContents.sent.at(-1))),['pet-desktop:placement',true]);
  h.ipc.emit('pet-desktop:layout',{sender},{height:280,petTop:12,below:true});
  assert.equal(win.getBounds().y+12,26,'pet remains near the top, with no invisible upper wall');
  assert.ok(win.getBounds().y>=0);
  h.ipc.emit('pet-desktop:layout',{sender:{}},{height:400,petTop:12,below:true});
  assert.equal(win.getBounds().height,280);
  h.ipc.emit('pet-desktop:layout',{sender},{height:9999,petTop:12,below:true});
  assert.equal(win.getBounds().height,280);
 });

 test('top placement is requested before macOS clamps a dragged window origin', async () => {
  const h=await harness('test'), win=h.windows[0]!, sender=win.webContents;
  h.ipc.emit('pet-desktop:layout',{sender},{height:280,petTop:96,below:false});
  win.setPosition(500,0);
  h.ipc.emit('pet-desktop:move',{sender},{dx:0,dy:-70});
  win.setPosition(500,0); // Native macOS correction before the renderer answers.
  h.ipc.emit('pet-desktop:layout',{sender},{height:280,petTop:12,below:true});
  assert.equal(win.getBounds().y+12,26);
 });


test('composer focuses native panel and renderer, retains mouse input until closed, and restores focus on return', async () => {
  const h = await harness('test'), win = h.windows[0]!, sender = win.webContents;
  const open = h.handlers.get('pet-desktop:compose-open')!;
  assert.throws(() => open({sender:{}}), /Invalid pet client/);
  assert.equal(win.ignoring, true);
  await open({sender});
  assert.equal(win.focused, true);
  if (process.platform === "darwin") assert.equal(h.app.activated, true);
  assert.equal(win.webContents.focused, true);
  assert.equal(win.options.acceptFirstMouse, true);
  h.ipc.emit('pet-desktop:action', {sender}, 'passthrough');
  assert.equal(win.ignoring, false);
  win.emit('focus');
  assert.equal(win.webContents.sent.at(-1)?.[0], 'pet-desktop:compose-focus');
  assert.equal(h.focuses(), 0, 'typing must not navigate to main chat');
  h.ipc.emit('pet-desktop:action', {sender}, 'compose-close');
  assert.equal(win.ignoring, true);
  h.ipc.emit('pet-desktop:action', {sender}, 'interactive');
  assert.equal(win.ignoring, false);
});

test('pet card IPC preserves cards, validates identity and rejects malformed actions', async () => {
  const h=await harness('test'); const sender=h.windows[0]!.webContents;
  await h.handlers.get('pet-desktop:chat-target')!({sender});
  const card={type:'offer',title:'整理材料',items:[{title:'报销',actions:[{kind:'reply',label:'帮我整理',value:'整理材料'}]}]};
  h.ipc.emit('pet-desktop:publish',{sender:h.main.webContents},{kind:'assistant',surface:{activity:'idle',label:'ready',sessionId:'assistant-target'}});
  h.ipc.emit('pet-desktop:publish',{sender:h.main.webContents},{kind:'messages',sessionId:'assistant-target',messages:[{id:'m',text:'需要吗',card}]});
  assert.deepEqual(h.windows[0]!.webContents.sent.at(-1)?.[1]?.messages[0].card,card);
  const call=h.handlers.get('pet-desktop:card-action')!;
  await call({sender},{target:'assistant-target',cardId:'m',actionKey:'0:0'});
  assert.equal(h.submitted[0].actionKey,'0:0');
  await assert.rejects(call({sender:{}},{target:'assistant-target',cardId:'m',actionKey:'0:0'}));
  await assert.rejects(call({sender},{target:'assistant-target',cardId:'m',actionKey:'bad'}));
  const n=h.windows[0]!.webContents.sent.length;
  h.ipc.emit('pet-desktop:publish',{sender:h.main.webContents},{kind:'messages',sessionId:'assistant-target',messages:[{id:'m',text:'unsafe',card:{...card,type:'script'}}]});
  assert.equal(h.windows[0]!.webContents.sent.length,n);
});
