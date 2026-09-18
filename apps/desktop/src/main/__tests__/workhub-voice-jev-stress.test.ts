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
import { WorkHubVoiceJev } from '../workhub-voice-jev.js';
import type { WorkHubVoiceState } from '@maka/runtime-host/protocol';
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
test('80 alternating interruptions invalidate approval and refresh without duplicate maintenance', async () => {
  let calls=0, maintenance=0, settled=true;
  let state: WorkHubVoiceState = {queue:[],deliveries:[]};
  const jev = new WorkHubVoiceJev({callId:'stress',settled:()=>settled,flush:async()=>{},onError:assert.fail,
    evaluate:async input=>{calls++;return {gap:false,items:Object.fromEntries(input.queue.map(item=>[item.id,'inject' as const]))};},
    write:async input=>{if(input.review)maintenance++;return state;}});
  for(let n=0;n<80;n++){
    settled=false;jev.invalidate();
    state={queue:[{id:`item-${n}`,text:`continuation ${n}`,context:''}],deliveries:[]};
    jev.snapshot(state);await flush();assert.equal(jev.canSend(`item-${n}`),false);
    settled=true;jev.fact(`turn-${n}`,{role:'user',text:`interruption ${n}`});
    await jev.tick();assert.equal(jev.canSend(`item-${n}`),true);
    for(let poll=0;poll<5;poll++){jev.snapshot(state);await flush();}
    assert.equal(calls,n+1);
  }
  assert.equal(maintenance,0);jev.close();
});
