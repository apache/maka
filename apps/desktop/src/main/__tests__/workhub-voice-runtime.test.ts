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
import { test } from 'node:test';
import { WorkHubVoiceCallController } from '../workhub-voice-call-controller.js';
import { WorkHubVoiceOutlet } from '../workhub-voice-outlet.js';
import { WorkHubVoiceFacts } from '../workhub-voice-facts.js';
import type { WorkHubVoiceTranscriptInput, VoiceInterruption, VoiceDeliveryInput, WorkHubVoiceState } from '@maka/runtime-host/protocol';
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const wire = (c: WorkHubVoiceCallController, type: string, turn: Record<string, unknown>) => c.add({kind:'transport',event:{type,turn}});

test('one fact record per turn; repeated final and late assistant completion preserve both interruptions', () => {
  const facts: WorkHubVoiceTranscriptInput[] = [], interruptions: VoiceInterruption[] = [];
  const c = new WorkHubVoiceCallController({callId:'call',recordTranscript:item=>facts.push(item),interruption:item=>interruptions.push(item)});
  wire(c,'turn.created',{id:'a',role:'assistant'});
  // Playback continues across both user fragments even though the current turn changes role.
  c.add({kind:'transport',event:{type:'maka.audio_activity',active:true}});
  c.add({kind:'transport',event:{type:'turn.delta',turn_id:'a',delta:'实际断点',start_ms:10,end_ms:20}});
  wire(c,'turn.created',{id:'u1',role:'user'});
  wire(c,'turn.done',{id:'u1',role:'user',transcript:'先讲笑话'});
  wire(c,'turn.created',{id:'u2',role:'user'});
  wire(c,'turn.done',{id:'u2',role:'user',transcript:'慢一点'});
  wire(c,'turn.done',{id:'a',role:'assistant',transcript:'实际断点结束',start_ms:10,end_ms:21});
  wire(c,'turn.done',{id:'a',role:'assistant',transcript:'实际断点结束',start_ms:10,end_ms:21});
  assert.equal(facts.length,3);
  assert.equal(facts.find(x=>x.nativeTurnId==='a')?.end_ms,21);
  assert.deepEqual(interruptions.slice(-2).map(i=>[i.userTurnId,i.assistant.text]),[['u1','实际断点结束'],['u2','实际断点结束']]);
  c.close();
});





test('controller owns pacing across outlet and context: no new inference is required for next speech', async () => {
  const c=new WorkHubVoiceCallController({callId:'call',recordTranscript:()=>{},interruption:()=>{}});
  const state:WorkHubVoiceState={queue:[{id:'A',text:'第一项',context:'PRIVATE'},{id:'B',text:'第二项',context:'PRIVATE'}],deliveries:[]};
  const speech:string[]=[];
  const record=async(input:VoiceDeliveryInput)=>{
    if(input.status==='reserved'){assert.equal(state.queue[0]?.id,input.id);state.queue.shift();state.deliveries.push({...input,status:'reserved'});}
    else if(input.status!=='release')state.deliveries.find(x=>x.id===input.id)!.status=input.status;
    return structuredClone(state);
  };
  const o=new WorkHubVoiceOutlet({callId:'call',interval:1,read:async()=>structuredClone(state),record,canSend:()=>c.canInject,intentRevision:()=>c.injectionRevision,send:(text,current,reserve)=>c.send(text,current,reserve,async t=>{speech.push(t)}),onError:assert.fail});
  try {
    o.start();await tick();assert.deepEqual(speech,['第一项']);
    wire(c,'turn.created',{id:'a',role:'assistant'});wire(c,'turn.done',{id:'a',role:'assistant',transcript:'第一项'});
    await tick();assert.deepEqual(speech,['第一项','第二项']);
    assert.equal(state.deliveries[0]!.status,'sent');assert.ok(!speech.join('').includes('PRIVATE'));
  }finally{o.close();c.close()}
});

test('new input during reservation cancels only the unsent attempt', async () => {
  const c=new WorkHubVoiceCallController({callId:'call',recordTranscript:()=>{},interruption:()=>{}});const revision=c.injectionRevision;let sent=0;
  assert.equal(await c.send('old',()=>c.injectionRevision===revision,async()=>{wire(c,'turn.created',{id:'u',role:'user'});return true},async()=>{sent++}),false);
  assert.equal(sent,0);c.close();
});

test('no-output delivery is reported once and is never guessed completed; closing wakes queued writes', async () => {
  const errors:string[]=[];const c=new WorkHubVoiceCallController({callId:'call',outputTimeoutMs:5,recordTranscript:()=>{},interruption:()=>{},onError:x=>errors.push(x)});
  assert.equal(await c.send('prepared',()=>true,async()=>true,async()=>{}),true);
  await tick();assert.equal(errors.length,1);assert.equal(c.canInject,false);
  let sent=false;const queued=c.send('next',()=>true,async()=>true,async()=>{sent=true});c.close();await queued;assert.equal(sent,false);
});

test('assistant transcript final does not release audible playback', async () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript: () => {}, interruption: () => {} });
  await c.send('prepared', () => true, async () => true, async () => {});
  wire(c, 'turn.created', { id: 'a', role: 'assistant' });
  c.add({ kind: 'transport', event: { type: 'maka.audio_activity', active: true } });
  wire(c, 'turn.done', { id: 'a', role: 'assistant', transcript: 'generated text' });
  assert.equal(c.canInject, false);
  c.add({ kind: 'transport', event: { type: 'maka.audio_activity', active: false } });
  assert.equal(c.canInject, true); c.close();
});

test('a delayed old assistant final cannot replace the latest interruption candidate', () => {
  const interruptions: VoiceInterruption[] = [];
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript: () => {}, interruption: item => interruptions.push(item) });
  wire(c, 'turn.created', { id: 'old', role: 'assistant' });
  wire(c, 'turn.created', { id: 'new', role: 'assistant', transcript: 'new actual output' });
  wire(c, 'turn.done', { id: 'old', role: 'assistant', transcript: 'late old output' });
  wire(c, 'turn.created', { id: 'u', role: 'user' });
  wire(c, 'turn.done', { id: 'u', role: 'user', transcript: 'interrupt' });
  assert.equal(interruptions[0]?.assistant.id, 'new'); c.close();
});



for (const start of [
  { type: 'turn.created', turn: { id: 'a', role: 'assistant' } },
  { type: 'maka.audio_activity', active: true },
]) test(`${start.type} cancels first-output timeout without releasing playback; next send rearms it`, async () => {
  const errors: string[] = [];
  const c = new WorkHubVoiceCallController({ callId: 'call', outputTimeoutMs: 5,
    recordTranscript() {}, interruption() {}, onError: message => errors.push(message) });
  try {
    await c.send('first', () => true, async () => true, async () => {});
    c.add({ kind: 'transport', event: start });
    await tick();
    assert.deepEqual(errors, []);
    assert.equal(c.outputActive, true);
    assert.equal(c.canInject, false);
    c.add({ kind: 'transport', event: { type: 'maka.audio_activity', active: true } });
    wire(c, 'turn.done', { id: 'a', role: 'assistant', transcript: 'finished generating' });
    await tick();
    assert.deepEqual(errors, []);
    assert.equal(c.canInject, false);
    c.add({ kind: 'transport', event: { type: 'maka.audio_activity', active: false } });
    assert.equal(c.canInject, true);
    await c.send('second', () => true, async () => true, async () => {});
    await tick();
    assert.equal(errors.length, 1);
    assert.equal(c.canInject, false);
  } finally { c.close(); }
});

for (const completion of ['turn.done']) {
  test(`native ${completion} releases the user-input fence; handoff and local audio cannot`,()=>{
    const c=new WorkHubVoiceCallController({callId:'call',recordTranscript:()=>{},interruption:()=>{}});
    try {
      wire(c,'turn.created',{id:'user',role:'user'});
      c.add({kind:'delegation_pending',userTurnId:'user'});
      c.add({kind:'transport',event:{type:'maka.input_audio_activity',active:false}});
      assert.equal(c.canInject,false);
      wire(c,'turn.done',{id:'user',role:'user'});
      assert.equal(c.canInject,true);
      wire(c,'turn.created',{id:'next',role:'user'});
      wire(c,'turn.done',{id:'user',role:'user'});
      c.add({kind:'delegation_pending',userTurnId:'user'});
      assert.equal(c.canInject,false,'old completion and handoff cannot release the new user turn');
    } finally {c.close();}
  });
}


test('only the current assistant turn controls native output availability', () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript() {}, interruption() {} });
  assert.equal(c.currentTurn, undefined);
  wire(c, 'turn.created', { id: 'old', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'old', role: 'assistant', status: 'created' });
  assert.equal(c.canInject, false);
  wire(c, 'turn.created', { id: 'new', role: 'assistant' });
  wire(c, 'turn.done', { id: 'old', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'new', role: 'assistant', status: 'created' });
  assert.equal(c.canInject, false);
  wire(c, 'turn.done', { id: 'new', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'new', role: 'assistant', status: 'done' });
  assert.equal(c.canInject, true);
  wire(c, 'turn.created', { id: 'new', role: 'assistant' });
  wire(c, 'turn.created', { id: 'old', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'new', role: 'assistant', status: 'done' });
  wire(c, 'turn.created', { id: 'user', role: 'user' });
  assert.deepEqual(c.currentTurn, { id: 'user', role: 'user', status: 'created' });
  assert.equal(c.canInject, false);
  c.close();
});

test('a newer completed assistant turn does not wait for a missing older done', () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript() {}, interruption() {} });
  wire(c, 'turn.created', { id: 'old', role: 'assistant' });
  wire(c, 'turn.created', { id: 'new', role: 'assistant' });
  wire(c, 'turn.done', { id: 'new', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'new', role: 'assistant', status: 'done' });
  assert.equal(c.canInject, true);
  wire(c, 'turn.done', { id: 'old', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'new', role: 'assistant', status: 'done' });
  c.close();
});

test('an observed assistant done is retained even without its created event', () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript() {}, interruption() {} });
  wire(c, 'turn.created', { role: 'assistant' });
  assert.equal(c.currentTurn, undefined);
  wire(c, 'turn.done', { id: 'finished', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'finished', role: 'assistant', status: 'done' });
  c.close();
});


test('the latest role and status determine whether the current native turn has ended', () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript() {}, interruption() {} });
  wire(c, 'turn.created', { id: 'u', role: 'user' });
  assert.deepEqual(c.currentTurn, { id: 'u', role: 'user', status: 'created' });
  assert.equal(c.canInject, false);
  wire(c, 'turn.done', { id: 'u', role: 'user' });
  assert.deepEqual(c.currentTurn, { id: 'u', role: 'user', status: 'done' });
  assert.equal(c.canInject, false, 'user completion still leaves a reply pending');
  wire(c, 'turn.created', { id: 'a', role: 'assistant' });
  wire(c, 'turn.done', { id: 'u', role: 'user' });
  assert.deepEqual(c.currentTurn, { id: 'a', role: 'assistant', status: 'created' });
  wire(c, 'turn.done', { id: 'a', role: 'user' });
  assert.deepEqual(c.currentTurn, { id: 'a', role: 'assistant', status: 'created' });
  wire(c, 'turn.done', { id: 'a', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'a', role: 'assistant', status: 'done' });
  assert.equal(c.canInject, true);
  c.close();
});

test('assistant output replaces an open user turn without requiring its missing done', () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript() {}, interruption() {} });
  wire(c, 'turn.created', { id: 'u', role: 'user' });
  wire(c, 'turn.created', { id: 'a', role: 'assistant' });
  wire(c, 'turn.done', { id: 'a', role: 'assistant' });
  assert.deepEqual(c.currentTurn, { id: 'a', role: 'assistant', status: 'done' });
  assert.equal(c.canInject, true);
  c.close();
});

test('native replies bypass busy voice and list fences; uncertain replies never replay or block supplements', async () => {
  const state: WorkHubVoiceState = {
    queue: [{ id: 'supplement', text: '遗漏回答', context: '' }],
    responses: [
      { id: 'normal', text: '正常回包', context: '', reply: { id: 'request', callId: 'call', userTurnId: 'user', kind: 'answer' } },
      { id: 'old', text: '旧通话结果', context: '', reply: { id: 'old-request', callId: 'old-call', userTurnId: 'old-user', kind: 'answer' } },
    ], deliveries: [],
  };
  const native: string[] = [], supplements: string[] = [], errors: string[] = [];
  let idle = false;
  const outlet = new WorkHubVoiceOutlet({ callId: 'call', interval: 5, read: async () => structuredClone(state),
    record: async input => {
      if (input.status === 'reserved') {
        const source = input.reply ? state.responses! : state.queue;
        source.splice(source.findIndex(item => item.id === input.id), 1);
        state.deliveries.push({ ...input, status: 'reserved' });
      } else if (input.status !== 'release') state.deliveries.find(item => item.id === input.id)!.status = input.status;
      return structuredClone(state);
    },
    canSend: () => idle, intentRevision: () => 0,
    sendReply: async (text, requestId) => { native.push(requestId + ':' + text); throw Error('uncertain network append'); },
    send: async (text, current, reserve) => { if (!current() || !await reserve()) return false; supplements.push(text); return true; },
    onError: text => errors.push(text),
  });
  try {
    outlet.start(); await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(native, ['request:正常回包']); assert.deepEqual(supplements, []);
    assert.equal(state.deliveries[0]?.status, 'uncertain');
    idle = true; await new Promise(resolve => setTimeout(resolve, 40));
    assert.deepEqual(supplements, ['遗漏回答']); assert.equal(native.length, 1);
    assert.equal(state.responses?.[0]?.id, 'old'); assert.equal(errors.length, 1);
  } finally { outlet.close(); }
});

test('provider-specific lifecycle events cannot start or finish normalized turns', () => {
  const c = new WorkHubVoiceCallController({ callId: 'call', recordTranscript() {}, interruption() {} });
  try {
    c.add({kind:'transport',event:{type:'response.created',response:{id:'old'}}});
    assert.equal(c.currentTurn, undefined);
    assert.equal(c.canInject, true);
    wire(c, 'turn.created', {id:'u',role:'user'});
    c.add({kind:'delegation_pending',userTurnId:'u'});
    c.add({kind:'transport',event:{type:'input_audio_buffer.speech_stopped'}});
    c.add({kind:'transport',event:{type:'response.done',response:{id:'old'}}});
    assert.equal(c.canInject, false);
    wire(c, 'turn.done', {id:'u',role:'user'});
    assert.equal(c.canInject, true);
  } finally {c.close();}
});
