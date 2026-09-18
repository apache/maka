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
import {test, type TestContext} from 'node:test';
function credential(t: TestContext) { const previous=process.env.TYPESAFE_API_KEY; process.env.TYPESAFE_API_KEY='test-only'; t.after(()=>{if(previous===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=previous;}); }
import {evaluateVoice} from '../workhub-voice-jev.js';
const input={facts:[{role:'user',text:'说结果'}],queue:[{id:'one',text:'四十二',context:''}],responses:[],deliveries:[]};
test('official Jev receives structured state, choice schema and abort signal',async t=>{
  credential(t);
  const signal=new AbortController().signal;
  t.mock.method(globalThis,'fetch',async(url:unknown,init:RequestInit)=>{
    assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.signal,signal);
    const body=JSON.parse(String(init.body));assert.equal(body.model,'jev-latest');assert.deepEqual(body.state,input);
    assert.equal(body.questions.need0.type,'choice');
    return Response.json({answers:{gap:{type:'choice',choice:'none'},need0:{type:'choice',choice:'yes'},repeat0:{type:'choice',choice:'no'},fit0:{type:'choice',choice:'yes'}}});
  });
  assert.deepEqual(await evaluateVoice(input,signal),{gap:false,items:{one:'inject'}});
});
test('official auth failure exposes status without provider response text',async t=>{
  credential(t);
  t.mock.method(globalThis,'fetch',async()=>new Response('private upstream body',{status:401}));
  await assert.rejects(evaluateVoice(input,new AbortController().signal),{message:'TypeSafe Jev HTTP 401'});
});
test('missing official answer cannot approve a partially classified list',async t=>{
  credential(t);
  t.mock.method(globalThis,'fetch',async()=>Response.json({answers:{gap:{type:'choice',choice:'none'}}}));
  await assert.rejects(evaluateVoice(input,new AbortController().signal),/Missing Jev decision/);
});
