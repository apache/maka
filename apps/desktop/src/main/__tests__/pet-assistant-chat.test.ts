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
import { createPetAssistantChat } from '../pet-assistant-chat.js';

function harness() {
  let enabled = true, owner = 'assistant-owner', blocked = false;
  const calls: any[] = [];
  const initial = {
    hostId: 'host-a',
    async request(_method: string, input: any) {
      return {value: input.method === 'assistant.enablement' ? {enabled} : {state: {sessionId: owner}}};
    },
    async submitMessage(input: any) { calls.push(input); return {disposition: blocked ? 'blocked' : 'inbox'}; },
  };
  let current: typeof initial | undefined = initial;
  const chat = createPetAssistantChat(() => current as any);
  return { chat, calls, disable:()=>{enabled=false;}, rebind:()=>{owner='other';},
    disconnect:()=>{current=undefined;}, block:()=>{blocked=true;}, switchHost:()=>{current={...initial,hostId:'host-b'};} };
}
test('sends to the assistant Inbox with the original identity retained for retry', async () => {
  const h=harness(); const target=await h.chat.target();
  const message={target,id:'stable-id',text:'你好'};
  await h.chat.send(message); await h.chat.send(message);
  assert.deepEqual(h.calls, Array(2).fill({sessionId:'assistant-owner',messageId:'stable-id',placement:'current_turn',content:{text:'你好'}}));
});
test('closing assistant, changing its binding or switching Hosts prevents misdelivery', async () => {
  for (const change of ['disable','rebind','disconnect','switchHost'] as const) {
    const h=harness(); const target=await h.chat.target(); h[change]();
    await assert.rejects(h.chat.send({target,id:'id',text:'你好'})); assert.equal(h.calls.length,0);
  }
});
test('blocked admission is an error, never a sent acknowledgement', async () => {
  const h=harness();const target=await h.chat.target();h.block();
  await assert.rejects(h.chat.send({target,id:'id',text:'你好'}), /消息未送达/);
});
