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
import { parseHTML } from 'linkedom';
import { PetCardView } from '../../overlay/pet-card.js';
import { PetMessageQueue, petMessageDuration } from '../../shared/pet-desktop.js';
import type { AssistantCard } from '@maka/core/assistant-card';
const card: AssistantCard = { type:'offer', title:'报销材料', items:[{title:'整理材料', facts:[{label:'已找到',value:'3 份'}],actions:[{kind:'reply',label:'帮我整理',value:'帮我整理报销材料'},{kind:'reply',label:'先不用',value:'先不用'}]}] };
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(call: (v:any)=>Promise<{selectedKey:string|null}>) {
  const {document}=parseHTML('<div id="card"></div>');
  const element=document.getElementById('card')!;
  const view=new PetCardView(element, {cardAction:call,openLink:async()=>{}});
  view.show('host-owner','card-id',card);
  return {element,view};
}
test('pet shows card outside prose, locks every option and ignores repeat clicks', async () => {
  let selected:string|null=null, calls=0;
  const h=setup(async v=> { if(v.actionKey) {calls++;selected=v.actionKey;} return {selectedKey:selected}; });
  try {
    assert.ok([...h.element.querySelectorAll('button')].every(b=>b.disabled));
    await settle();
    assert.match(h.element.textContent!, /3 份/);
    const b=h.element.querySelector('button')!; b.click();b.click();
    await settle();
    assert.equal(calls,1);assert.equal(selected,'0:0');
    assert.ok([...h.element.querySelectorAll('button')].every(b=>b.disabled));
    assert.match(h.element.textContent!,/已发送/);
    h.view.show();h.view.show('host-owner','card-id',card);await settle();
    assert.ok([...h.element.querySelectorAll('button')].every(b=>b.disabled));
  } finally {h.view.show();}
});
test('failed submission is retryable; changing card ignores late results', async () => {
  let fail=true;
  const h=setup(async v=> {if(v.actionKey&&fail) throw Error('offline');return {selectedKey:v.actionKey??null};});
  try {
    await settle();h.element.querySelector('button')!.click();await settle();
    assert.match(h.element.textContent!,/可以重试/);assert.equal(h.element.querySelector('button')!.disabled,false);
    fail=false;h.element.querySelector('button')!.click();h.view.show();await settle();
    assert.equal(h.element.hidden,true);assert.equal(h.element.textContent,'');
  } finally {h.view.show();}
});
test('unsafe cards are refused; card content survives queue and adds reading time', () => {
  const h=setup(async()=>({selectedKey:null}));
  try {
    h.view.show('owner','bad',{...card,items:[{title:'bad',actions:[{kind:'link',label:'run',value:'javascript:alert(1)'}]}]});
    assert.equal(h.element.hidden,true);
    const q=new PetMessageQueue();const m={id:'1',text:'你好',card};q.push('owner',[m]);
    assert.deepEqual(q.current()?.card,card);
    assert.ok(petMessageDuration(m)>petMessageDuration({id:'1',text:'你好'}));
  } finally {h.view.show();}
});
