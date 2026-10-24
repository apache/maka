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

import assert from "node:assert/strict";
import { test } from "node:test";
import { PetMessageQueue, PetBubbleView, PetAnimationBehavior, petMessageText, petMessageDuration, PetBackgroundNotice, shouldClosePetComposer } from "../../shared/pet-desktop.js";
import { createSettingsStore } from "@maka/storage/settings-store";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("messages keep batch order and do not duplicate on reconnect", () => {
  const q = new PetMessageQueue();
  const messages = [
    { id: "1", text: "one" },
    { id: "2", text: "two" },
  ];
  q.push("host-a/session", messages);
  q.push("host-a/session", messages);
  assert.equal(q.messages.length, 2);
  assert.equal(q.current()?.text, "one");
  q.next();
  assert.equal(q.current()?.text, "two");
  q.next();
  assert.equal(q.current(), undefined);
  q.push("host-a/session", messages);
  assert.equal(q.current(), undefined);
});
test("arrivals append without interrupting the message being read", () => {
  const q = new PetMessageQueue();
  q.push("s", [
    { id: "1", text: "first" },
    { id: "2", text: "second" },
  ]);
  q.next();
  q.push("s", [{ id: "3", text: "third" }]);
  assert.equal(q.current()?.id, "2");
  q.next();
  assert.equal(q.current()?.id, "3");
  q.previous();
  assert.equal(q.current()?.id, "2");
});
test("different host/assistant discards the old queue even for matching message IDs", () => {
  const q = new PetMessageQueue();
  q.push("host-a/s", [{ id: "1", text: "private A" }]);
  q.push("host-b/s", [{ id: "1", text: "private B" }]);
  assert.deepEqual(
    q.messages.map((m) => m.text),
    ["private B"],
  );
});
test("summary is preferred, plain text remains readable without exposing asset links", () => {
  assert.equal(
    petMessageText({ id: "a", text: "long body", summary: "short summary" }),
    "short summary",
  );
  assert.equal(
    petMessageText({
      id: "a",
      text: "**hello**\n[details](https://example.com) ![sticker](private-uri)",
    }),
    "hello\ndetails 〔图片〕",
  );
});
test("clearing the visible queue does not replay already delivered notifications", () => {
  const q = new PetMessageQueue();
  const m = { id: "1", text: "first" };
  q.push("s", [m]);
  q.clear();
  q.push("s", [m]);
  assert.equal(q.current(), undefined);
});
test("pet mode survives restart without selecting a pet or enabling agents", async () => {
  const dir = await mkdtemp(join(tmpdir(), "maka-pet-mode-"));
  try {
    const store = createSettingsStore(dir);
    const before = await store.get();
    await store.update({ personalization: { petMode: "assistant" } });
    const after = await createSettingsStore(dir).get();
    assert.equal(after.personalization.petMode, "assistant");
    assert.equal(after.personalization.selectedPetId, null);
    assert.deepEqual(
      JSON.parse(
        JSON.stringify({ ...after, personalization: before.personalization }),
      ),
      JSON.parse(JSON.stringify(before)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('a sleeping Bot does not hide running/waiting tasks; archived tasks do not count', async () => {
  const { projectAssistantPet } = await import('../../renderer/features/personal-assistant/testing.js');
  const result = projectAssistantPet({ bot: { sleeping: true }, tasks: { items: [
    { id:'a', status:'active', runtimeStatus:'running' },
    { id:'b', status:'waiting' },
    { id:'c', status:'completed' },
    { id:'d', status:'cancelled' },
    { id:'e', status:'paused' },
  ] } }, 'owner');
  assert.equal(result.activity, 'working');
  assert.deepEqual(result.tasks, { running: 1, waiting: 1, attention: 0 });
});
test('discovery and failures have distinct visible states', async () => {
  const { projectAssistantPet } = await import('../../renderer/features/personal-assistant/testing.js');
  assert.equal(projectAssistantPet({ state: { active: { id:'work' } }, tasks: { items:[] } }).activity, 'swarm');
  const failed = projectAssistantPet({ tasks: { error:'offline' } });
  assert.equal(failed.activity, 'blocked');
  assert.notEqual(failed.label, '暂时没有待处理的事');
  assert.equal(projectAssistantPet({ tasks: { items:[{id:'a', runtimeStatus:'waiting_for_user'}] } }).activity, 'needs-input');
});

test('carousel duration includes notice time and visible reading time within bounds', () => {
  assert.equal(petMessageDuration({ id:'1', text:'短句' }), 4000);
  assert.equal(petMessageDuration({ id:'20', text:'字'.repeat(20) }), 6400);
  assert.equal(petMessageDuration({ id:'50', text:'字'.repeat(50) }), 13000);
  assert.equal(petMessageDuration({ id:'80', text:'字'.repeat(80) }), 19600);
  assert.equal(petMessageDuration({ id:'space', text:('字 \n').repeat(20) }), 6400);
  assert.equal(petMessageDuration({ id:'2', text:'字'.repeat(100) }), 20000);
  assert.equal(petMessageDuration({ id:'3', text:'字'.repeat(1000) }), 20000);
  assert.equal(petMessageDuration({ id:'4', text:'字'.repeat(1000), summary:'摘要' }), 4000);
  assert.equal(petMessageDuration({ id:'5', text:'🐈'.repeat(50) }), 13000);
});
test('assistant overview retains zero counts, but does not claim zero when unavailable', async () => {
  const { projectAssistantPet } = await import('../../renderer/features/personal-assistant/testing.js');
  assert.deepEqual(projectAssistantPet({ tasks: { items:[] } }, 'owner').tasks, { running:0, waiting:0, attention:0 });
  assert.equal(projectAssistantPet({ tasks:{error:'offline'} }, 'owner').tasks, undefined);
});

test('discovery shows active, standby, off and failure independently of task counts', async () => {
  const { projectAssistantPet } = await import('../../renderer/features/personal-assistant/testing.js');
  assert.equal(projectAssistantPet({state:{active:{id:'a'},enabled:true}}).discovery, '主动发现进行中');
  assert.equal(projectAssistantPet({state:{enabled:true}}).discovery, '主动发现等待下一轮');
  assert.equal(projectAssistantPet({state:{enabled:false}}).discovery, '主动发现未开启');
  assert.equal(projectAssistantPet({state:{enabled:true,lastError:'offline'}}).discovery, '主动发现异常，请检查');
});

test('composer closes only when empty and idle for five seconds, never during composition or sending', () => {
  assert.equal(shouldClosePetComposer('',4999,false,false),false);
  assert.equal(shouldClosePetComposer('',5000,false,false),true);
  assert.equal(shouldClosePetComposer('保留草稿',999999,false,false),false);
  assert.equal(shouldClosePetComposer('',999999,true,false),false);
  assert.equal(shouldClosePetComposer('',999999,false,true),false);
});
test('background notices distinguish no findings from a report and silently clear on error', () => {
  const n = new PetBackgroundNotice();
  const base = {activity:'idle' as const,label:'',sessionId:'owner'};
  n.update(base,0);
  const active = {...base,discoveryRun:{id:'a',running:true}};
  n.update(active,1); assert.match(n.read(active,1)!.text,/后台探索/);
  const quiet = {...base,discoveryRun:{id:'a',running:false,outcome:'quiet' as const}};
  n.update(quiet,2); assert.match(n.read(quiet,2)!.text,/没发现/);
  n.update(quiet,1000); assert.equal(n.read(quiet,6003),undefined);
  const report = {...base,discoveryRun:{id:'b',running:false,outcome:'reported' as const}};
  n.update(report,7000); assert.match(n.read(report,7000)!.text,/新线索/);
  const error = {...base,discoveryRun:{id:'c',running:false,outcome:'error' as const}};
  n.update(error,14000); assert.equal(n.read(error,14000),undefined);
  n.reset();n.update(quiet,0);assert.equal(n.read(quiet,1),undefined,'old completions are not replayed after restart');
});
test('index maintenance uses the same transient status, without model or message invocation', () => {
  const n=new PetBackgroundNotice();const base={activity:'idle' as const,label:'',sessionId:'owner'};
  const busy={...base,maintenance:[{id:'index:1',running:true}]};n.update(busy,0);
  assert.match(n.read(busy,0)!.text,/整理/);
  const done={...base,maintenance:[{id:'index:1',running:false}]};n.update(done,100);
  assert.match(n.read(done,100)!.text,/完成/);assert.equal(n.read(done,6101),undefined);
  n.update(busy,7000);
  const failed={...base,maintenance:[{id:'index:1',running:false,error:'offline'}]};
  n.update(failed,7100);assert.equal(n.read(failed,7100),undefined);
});
test('task ticker contains only running tasks and preserves their titles', async () => {
  const { projectAssistantPet } = await import('../../renderer/features/personal-assistant/testing.js');
  const p=projectAssistantPet({tasks:{items:[{id:'a',title:'核对发票',runtimeStatus:'running'}, {id:'b',title:'等待审批',status:'waiting'}, {id:'c',title:'已完成',status:'completed'}]}});
  assert.deepEqual(p.runningTasks,[{id:'a',title:'核对发票'}]);
});


test('double clicking the upper card alternates messages and status without hiding', () => {
  const q = new PetMessageQueue(), view = new PetBubbleView(q);
  q.push('owner', [{id:'a',text:'first'},{id:'b',text:'second'}]);
  q.next(); q.next();
  view.cycle(); assert.equal(view.mode, 'messages');
  assert.equal(view.message()?.id, 'b');
  view.previous(); assert.equal(view.message()?.id, 'a');
  view.next(); view.next(); assert.equal(view.message()?.id, 'b');
  view.cycle(); assert.equal(view.mode, 'auto'); assert.equal(view.message(), undefined);
  view.cycle(); assert.equal(view.mode, 'messages');
});

test('single click hides and restores; pending messages take precedence over status', () => {
  const q = new PetMessageQueue(), view = new PetBubbleView(q);
  view.toggleVisibility(); assert.equal(view.mode, 'hidden');
  view.toggleVisibility(); assert.equal(view.mode, 'auto');
  q.push('owner', [{id:'a',text:'automatic message'}]);
  view.toggleVisibility(); assert.equal(view.mode, 'hidden');
  assert.equal(view.unreadCount, 1);
  view.toggleVisibility(); assert.equal(view.mode, 'messages');
  assert.equal(view.message()?.id, 'a'); assert.equal(view.unreadCount, 0);
  view.toggleVisibility(); view.toggleVisibility();
  assert.equal(view.mode, 'auto'); assert.equal(view.message(), undefined);
});

test('automatic messages expire but manual message history remains accessible', () => {
  const q = new PetMessageQueue(), view = new PetBubbleView(q);
  view.cycle(); assert.equal(view.mode, 'messages'); assert.equal(view.message(), undefined);
  view.cycle(); assert.equal(view.mode, 'auto');
  q.push('owner', [{id:'a',text:'auto'}]);
  view.next(); assert.equal(view.message(), undefined);
  view.cycle(); assert.equal(view.message()?.id, 'a');
  view.next(); assert.equal(view.message()?.id, 'a');
  q.push('other', [{id:'b',text:'different owner'}]); view.reset();
  assert.equal(view.mode, 'auto'); assert.equal(q.history.length, 0);
});

test('hidden arrivals open from the first new message and never trap status navigation', () => {
  const q = new PetMessageQueue(), view = new PetBubbleView(q);
  q.push('owner', [{id:'old',text:'previous'}]); q.next();
  view.toggleVisibility();
  q.push('owner', [{id:'one',text:'new first'},{id:'two',text:'new second'}]); view.arrival();
  assert.equal(view.mode, 'hidden');
  view.toggleVisibility();
  assert.equal(view.message()?.id, 'one'); assert.equal(view.unread, false);
  view.next(); assert.equal(view.message()?.id, 'two');
  view.cycle(); assert.equal(view.mode, 'auto'); assert.equal(view.message(), undefined);
  view.cycle(); assert.equal(view.message()?.id, 'two');
  view.toggleVisibility();
  q.push('owner', [{id:'three',text:'new batch'}]); view.arrival();
  view.toggleVisibility(); assert.equal(view.message()?.id, 'three');
  view.toggleVisibility(); view.toggleVisibility(); assert.equal(view.mode, 'auto');
});

test('unread badge counts messages rather than deliveries, caps display at 99+, and clears on opening', () => {
  const q = new PetMessageQueue(), view = new PetBubbleView(q);
  view.toggleVisibility();
  const messages = Array.from({length: 99}, (_, i) => ({id: String(i), text: 'message'}));
  q.push('owner', messages); view.arrival();
  assert.equal(view.unreadCount, 99); assert.equal(view.unreadLabel, '99');
  q.push('owner', messages); view.arrival();
  assert.equal(view.unreadCount, 99, 'replayed deliveries do not inflate unread counts');
  q.push('owner', [{id: '100', text: 'another'}]); view.arrival();
  assert.equal(view.unreadCount, 100); assert.equal(view.unreadLabel, '99+');
  view.toggleVisibility(); assert.equal(view.unreadCount, 0);
  view.cycle(); assert.equal(view.mode, 'auto');
  view.toggleVisibility();
  q.push('owner', [{id: '101', text: 'new batch'}]); view.arrival();
  assert.equal(view.unreadCount, 1); assert.equal(view.unreadLabel, '1');
  view.reset(); assert.equal(view.unreadCount, 0);
});


test('click feedback plays once, can restart, and returns to the current task state', () => {
  const behavior = new PetAnimationBehavior();
  const idle = {activity: 'idle' as const, label: 'idle'};
  const input = {pendingMessage: false, interacting: false};
  behavior.interact(100, 2000);
  const first = behavior.resolve(idle, input, 100);
  assert.equal(first.state, 'poke');
  behavior.interact(200, 2000);
  assert.notEqual(behavior.resolve(idle, input, 200).key, first.key);
  assert.equal(behavior.resolve(idle, input, 2199).state, 'poke');
  assert.equal(behavior.resolve({...idle, activity: 'working'}, input, 2200).state, 'working');
  assert.equal(behavior.resolve(idle, input, 2300).state, 'idle');
});

test('visual sleep starts after ten idle minutes and interaction wakes immediately', () => {
  const behavior = new PetAnimationBehavior();
  const idle = {activity: 'idle' as const, label: 'idle'};
  const input = {pendingMessage: false, interacting: false};
  behavior.reset(1000);
  assert.equal(behavior.resolve(idle, input, 600999).state, 'idle');
  assert.equal(behavior.resolve(idle, input, 601000).state, 'sleep');
  behavior.interact(601001);
  assert.equal(behavior.resolve(idle, input, 601001).state, 'idle');
  assert.equal(behavior.resolve(idle, input, 1201001).state, 'sleep');
  assert.equal(behavior.resolve(idle, {...input, pendingMessage:true}, 1201002).state, 'idle');
});

test('work, discovery, maintenance, attention and composing prevent visual sleep', () => {
  const input = {pendingMessage:false, interacting:false};
  const idle = {activity:'idle' as const, label:'idle'};
  for (const surface of [
    {...idle, activity:'working' as const},
    {...idle, tasks:{running:1,waiting:0,attention:0}},
    {...idle, discoveryRun:{id:'d',running:true}},
    {...idle, maintenance:[{id:'m',running:true}]},
    {...idle, tasks:{running:0,waiting:0,attention:1}},
  ]) {
    const behavior = new PetAnimationBehavior();
    assert.notEqual(behavior.resolve(surface, input, 900000).state, 'sleep');
    assert.equal(behavior.resolve(idle, input, 900001).state, 'idle');
  }
  const behavior = new PetAnimationBehavior();
  assert.equal(behavior.resolve(idle, {...input, interacting:true}, 900000).state, 'idle');
  assert.equal(behavior.resolve({...idle, tasks:{running:0,waiting:1,attention:0}}, input, 1500000).state, 'sleep', 'waiting on an external result does not mean the pet is working');
});

test('idle motion rotates through three poses without changing assistant status', () => {
  const behavior = new PetAnimationBehavior();
  behavior.reset(0);
  const surface = {activity:'idle' as const, label:'idle'};
  const input = {pendingMessage:false, interacting:false};
  assert.deepEqual([0,18000,36000,54000].map(now => behavior.resolve(surface,input,now).idleMotion), ['breathe','sway','stretch','breathe']);
  assert.equal(surface.activity, 'idle');
});
