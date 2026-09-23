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

// Synthetic visibility stress control ONLY. Geometry is mocked; this is not natural reproduction.
const fs=await import('node:fs/promises');
const p=(await taskSpace(8)).page('p1');
await p.goto('http://127.0.0.1:5200');
await p.waitForFunction(()=>typeof window.configure==='function');
await p.click('loc=css:[contenteditable=true]');
await p.evaluate(()=>{
 const original=Element.prototype.getBoundingClientRect;
 window.forcedCalls=0;window.forcedTrace=[];
 Element.prototype.getBoundingClientRect=function(){
   const rect=original.call(this);
   if(!this.hasAttribute('data-astryx-inline-completion'))return rect;
   const n=window.forcedCalls++;
   if(n>=300)return rect; // Hard bound: never leave an intentional infinite loop.
   const field=original.call(this.parentElement);
   const visible=n%3===0;
   const result=new DOMRect(rect.x,visible?field.top+1:field.bottom+20,rect.width,visible?1:rect.height);
   window.forcedTrace.push({n,visible,realBottom:rect.bottom,forcedBottom:result.bottom,fieldBottom:field.bottom});
   return result;
 };
 window.restoreGeometry=()=>{Element.prototype.getBoundingClientRect=original};
 window.configure({width:640,fontSize:14,lineHeight:20,zoom:1,rows:10,font:'Arial',text:'Implement ',suffix:'the next step.'});
});
await p.evaluate(()=>window.focusEnd());
await p.waitForFunction(()=>window.forcedCalls>=300||window.errors.length>0,undefined,{timeout:5000}).catch(()=>{});
const result=await p.evaluate(()=>({synthetic:true,calls:window.forcedCalls,trace:window.forcedTrace,...window.metrics()}));
await p.evaluate(()=>window.restoreGeometry());
const dir='/Users/a404/.codex/worktrees/maka-prompt-suggestions/maka-agent/docs/reports/prompt-suggestion-repro';
await fs.writeFile(`${dir}/forced-control.json`,JSON.stringify(result,null,2));
try {
 await p.screenshot({path:`${dir}/forced-control.png`});
} catch(error) {
 await fs.writeFile(`${dir}/screenshot-error.md`,String(error));
}
console.log({synthetic:true,calls:result.calls,errors:result.errors,mutations:result.mutations});
