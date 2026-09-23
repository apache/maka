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

// Execute via: ego-browser nodejs < run-matrix.mjs
// Resume the single experiment TaskSpace; set TASK_SPACE_ID for a later run.
const fs = await import('node:fs/promises');
const task=await taskSpace(Number(process.env.TASK_SPACE_ID??8));
const p=task.page('p1');
await p.goto('http://127.0.0.1:5200');
await p.cdp('Page.bringToFront');
await p.waitForFunction(()=>typeof window.configure==='function');
await p.click('loc=css:[contenteditable=true]');
const batch=Number(process.env.BATCH??0);
const configs=[];
for (const font of ['Arial','monospace','"PingFang SC"'])
for (const width of [240,320,479.5,640,799.5])
for (const lineHeight of [18,19.5,20,21.5,22,22.5])
for (const zoom of [0.8,1,1.1,1.25,1.5])
for (const variant of [0,1,2,3]) {
 const text=variant===0?'Implement ':variant===1?'这是一个中文输入框边界复现实验。'.repeat(12):variant===2?('Line number test content\n'.repeat(9)+'And next '):'Code '.repeat(70);
 const suffix=variant===0?'the next step.':variant===1?'接着验证补全是否会导致界面反复更新。':variant===2?'continue with more implementation and tests.':' more words to wrap across the bottom edge of this capped field.';
 configs.push({font,width,lineHeight,zoom,rows:10,fontSize:14,text,suffix,variant});
}
const selected=configs.slice(batch*40,(batch+1)*40);
const results=await p.evaluate(async (configs)=>{
 const out=[];
 const frames=async(n)=>{await new Promise(r=>setTimeout(r,n*15))};
 for(const cfg of configs){
   window.configure(cfg);await frames(2);window.focusEnd();await frames(4);
   out.push({cfg,...window.metrics()});
   if(window.errors.length)break;
 }
 return out;
},selected);
const dir='/Users/a404/.codex/worktrees/maka-prompt-suggestions/maka-agent/docs/reports/prompt-suggestion-repro';
await fs.writeFile(`${dir}/matrix-${batch}.json`,JSON.stringify(results,null,2));
console.log({batch,cases:results.length,errors:results.filter(x=>x.errors.length),shown:results.filter(x=>x.offerText).length,maxMutations:Math.max(...results.map(x=>x.mutations))});
