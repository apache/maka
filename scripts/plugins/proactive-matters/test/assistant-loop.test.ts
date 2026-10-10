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

import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../../index-initiative/test/fixture.js';

test('unified entry + background index + timed task + parent feedback run together without heartbeat', async () => {
  const cwd=process.cwd();process.chdir('../index-initiative');
  let f:any;
  try {f=await fixture({matters:true})} finally {process.chdir(cwd)}
  let turns=0; const feedback:string[]=[]; let failure:unknown;
  try {
    await f.remote('assistant.bind',{sessionId:'owner'});
    f.setRunner(async({id,prompt,invoke}:any)=>{
      if(id==='owner') {
        feedback.push(prompt);
        // Controlled model reply. This test validates admission/wiring, not recommendation quality.
        f.workers.get(id).transcript.push({type:'assistant',text:'已核对，验收通过。',ts:Date.now()});
        return;
      }
      try {
        const context=JSON.parse(prompt.split('Matter workspace (paths and host metadata):\n')[1]);
        const v=await invoke('MatterRead',{activationId:context.activationId}); turns++;
        await invoke('MatterWriteFile',{path:v.files.draft,content:turns===1?'等待测试结果':'验收结果通过'});
        await invoke('MatterSettle',{expectedRevision:v.revision,stateFile:v.files.draft,
          disposition:turns===1?'wait':'complete',reason:turns===1?'测试尚未结束':'读取了通过记录',
          summary:'只读核对验收状态',update:turns===1?'测试仍在运行':'验收通过',
          ...(turns===1?{waitingFor:'测试结果产生',wakes:[{kind:'at',at:Date.now()+100}]}:{})});
      }catch(error){failure=error;throw error}
    });
    const range=await f.invoke('MemoryRange',{});
    const index=await f.invoke('MemoryIndexCreate',{name:'Project context',instructions:'按事件整理',cursor:range.to,background:true});
    const task=await f.invoke('MatterDelegate',{taskKey:'acceptance',title:'验收核对',request:'只读核对验收，尚未结束则等待结果，不修改项目。'});
    await until(async()=>failure||(await f.invoke('MatterTasks',{id:task.id})).status==='completed');if(failure)throw failure;
    await until(()=>feedback.some(x=>x.includes('验收通过')));
    await until(async()=>(await f.invoke('MemoryIndexRead',{indexId:index.index.id})).range.completed);
    const status=await f.remote('assistant.status');
    assert.equal(turns,2);assert.equal(status.state.enabled,false);
    assert.equal(status.tasks.items.length,1);assert.equal(status.tasks.items[0].status,'completed');
    assert.equal(status.memory.indexes.length,1);
    assert.ok(status.memory.indexes[0].freshness.coveredCursor);
    assert.ok(f.workers.get('owner').transcript.some((m:any)=>m.type==='assistant'&&m.text==='已核对，验收通过。'));
    assert.equal(f.workers.size,3,'one native assistant, one index worker, one independent task');
  }finally{await f.close()}
});
