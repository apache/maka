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

// Natural DOM geometry; scrolling/editing are real DOM actions, never mocked rects.
const fs=await import('node:fs/promises');
const p=(await taskSpace(8)).page('p1');
await p.goto('http://127.0.0.1:5200');
await p.waitForFunction(()=>typeof window.configure==='function');
await p.click('loc=css:[contenteditable=true]');
const batch=0;
let seed=4117;const rand=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};
const configs=Array.from({length:240},(_,i)=>({
 width:200+Math.floor(rand()*600)+[0,.25,.5,.75][i%4],
 fontSize:[12,13,14,15,16][i%5],lineHeight:17+Math.round(rand()*28)/4,
 zoom:[.75,.8,.9,1,1.1,1.25,1.5][i%7],rows:[2,3,10][i%3],
 font:['Arial','monospace','"PingFang SC"'][i%3],
 text:(i%2?'请检查这个边界场景。':'Check the boundary case. ').repeat(5+Math.floor(rand()*30)),
 suffix:i%2?'然后继续完成测试和改动。':' Then implement the change and run the tests.'
})).slice(batch*40,(batch+1)*40);
const results=await p.evaluate(async(configs)=>{
 const out=[];const wait=()=>new Promise(r=>setTimeout(r,35));
 for(const cfg of configs){
  window.configure(cfg);await wait();window.focusEnd();
  const e=document.querySelector('[contenteditable=true]');
  e.scrollTop=e.scrollHeight;document.execCommand('insertText',false,'x');await wait();
  document.execCommand('delete');await wait();
  out.push({cfg,...window.metrics()});if(window.errors.length)break;
 }
 return out;
},configs);
const dir='/Users/a404/.codex/worktrees/maka-prompt-suggestions/maka-agent/docs/reports/prompt-suggestion-repro';
await fs.writeFile(`${dir}/scrolled-${batch}.json`,JSON.stringify(results,null,2));
console.log({batch,cases:results.length,errors:results.filter(x=>x.errors.length),shown:results.filter(x=>x.offerText).length,maxMutations:Math.max(...results.map(x=>x.mutations))});
