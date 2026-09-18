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
import { WorkHubVoiceJev, type JevDecision } from '../workhub-voice-jev.js';
import type { WorkHubVoiceState, WorkHubVoiceObservation } from '@maka/runtime-host/protocol';
const item = (id: string) => ({ id, text: id, context: '' });
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(decide: () => Promise<JevDecision>) {
  let state: WorkHubVoiceState = { queue: [item('A'), item('B'), item('C')], deliveries: [] };
  const writes: WorkHubVoiceObservation[] = [];
  let settled = true;
  const errors: string[] = [];
  const jev = new WorkHubVoiceJev({ callId: 'call', settled: () => settled, flush: async () => {}, evaluate: decide,
    write: async input => { writes.push(input); state = { ...state, queue: state.queue.filter(item => !input.discard?.some(d => d.id === item.id && d.text === item.text)) }; if (input.review) state.review = { id: input.id, callId: 'call', status: 'admitted', after: 0, through: 1 }; return state; }, onError: message => errors.push(message) });
  return { jev, writes, errors, get state() { return state; }, set state(v) { state = v; }, set settled(v: boolean) { settled = v; } };
}
test('all discarded with no gap never activates WorkHub', async () => {
  const f = fixture(async () => ({ gap: false, items: { A:'discard', B:'discard', C:'discard' } }));
  f.jev.snapshot(f.state); await flush();
  assert.equal(f.state.queue.length, 0); assert.equal(f.writes.filter(w => w.review).length, 0); f.jev.close();
});
test('rework is skipped, valid items approved, maintenance requested once', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { gap: false, items: { A:'rework', B:'discard', C:'inject' } }; });
  f.jev.snapshot(f.state); await flush();
  assert.equal(f.jev.canSend('A'), false); assert.equal(f.jev.canSend('C'), true);
  assert.deepEqual(f.state.queue.map(i=>i.id), ['A','C']);
  for(let i=0;i<30;i++) { f.jev.snapshot(f.state); await flush(); }
  assert.equal(calls,2); assert.equal(f.writes.filter(w => w.review).length,1); f.jev.close();
});
test('new user speech invalidates in-flight deletion and approval', async () => {
  let finish!: (d: JevDecision) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  f.jev.snapshot(f.state); await flush();
  f.settled = false; f.jev.invalidate();
  finish({ gap: true, items: { A:'discard', B:'inject', C:'rework' } }); await flush();
  assert.equal(f.writes.length,0); assert.equal(f.jev.canSend('B'),false); assert.equal(f.state.queue.length,3); f.jev.close();
});
test('changed list invalidates old evaluation; checks are serialized', async () => {
  let finish!: (d: JevDecision) => void; let calls=0;
  const f = fixture(() => { calls++; return new Promise(resolve => { finish=resolve; }); });
  f.jev.snapshot(f.state); await flush();
  f.state = {queue:[{...item('A'),text:'new text'}],deliveries:[]}; f.jev.snapshot(f.state);
  assert.equal(calls,1);
  finish({gap:false,items:{A:'inject',B:'inject',C:'inject'}}); await flush();
  assert.equal(f.jev.canSend('A'),false);
  f.jev.snapshot(f.state); await flush(); assert.equal(calls,2);
  finish({gap:false,items:{A:'inject'}}); await flush(); assert.equal(f.jev.canSend('A'),true); f.jev.close();
});
test('API failure pauses list but does not hot-loop or request WorkHub', async () => {
  let calls=0; const f=fixture(async()=>{calls++;throw Error('403');});
  f.jev.snapshot(f.state); await flush();
  for(let i=0;i<50;i++){f.jev.snapshot(f.state);await flush();}
  assert.equal(calls,1); assert.equal(f.writes.length,0); assert.equal(f.jev.canSend('A'),false); assert.equal(f.errors.length,1); f.jev.close();
});

test('busy WorkHub admission retries one stable request without another model call', async t => {
  t.mock.timers.enable({apis:['Date']});
  let busy=true,calls=0;
  const writes: WorkHubVoiceObservation[]=[];
  const state: WorkHubVoiceState={queue:[],deliveries:[]};
  const jev=new WorkHubVoiceJev({callId:'busy',settled:()=>true,flush:async()=>{},onError:assert.fail,
    evaluate:async()=>{calls++;return {gap:true,items:{}};},write:async input=>{writes.push(input);return busy?state:{...state,review:{id:input.id,callId:'busy',status:'admitted',after:0,through:1}};}});
  jev.snapshot(state);await flush();assert.equal(writes.length,1);
  busy=false;t.mock.timers.tick(2001);await jev.tick();
  assert.equal(writes.length,2);assert.equal(writes[0]!.id,writes[1]!.id);assert.equal(calls,1);
  t.mock.timers.tick(2001);await jev.tick();assert.equal(writes.length,2);jev.close();
});
test('fresh evidence cancels an unadmitted obsolete maintenance request', async t => {
  t.mock.timers.enable({apis:['Date']});
  let gap=true;
  const writes: WorkHubVoiceObservation[]=[];
  const state: WorkHubVoiceState={queue:[],deliveries:[]};
  const jev=new WorkHubVoiceJev({callId:'busy',settled:()=>true,flush:async()=>{},onError:assert.fail,
    evaluate:async()=>({gap,items:{}}),write:async input=>{writes.push(input);return state;}});
  jev.snapshot(state);await flush();assert.equal(writes.length,1);
  gap=false;jev.fact('answered',{role:'assistant',text:'已经完成'});t.mock.timers.tick(2001);await jev.tick();
  assert.equal(writes.length,1);jev.close();
});
