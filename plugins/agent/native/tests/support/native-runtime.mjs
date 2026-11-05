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

// Native wire fixtures. The TCP control channel belongs only to the behavioral tests.
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { mkdirSync, appendFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const port = Number(process.argv[2]);
const args = process.argv.slice(3);
const agy = args.includes('acp');
if (agy && !args.includes('--dangerously-skip-permissions')) throw Error('agy must launch with native full permissions');
const claude = !agy && args.includes('--dangerously-skip-permissions');
let control, gates, gate, request, server, thread = 'native-fixture-session', turn = 'fixture-turn', promptId, interrupted = false;
let opened, activePlan;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const reply = (id, result) => send({jsonrpc:'2.0',id,result});
const event = (method, params) => send({jsonrpc:'2.0',method,params});
const trace = (phase, extra = {}) => control.write(JSON.stringify({phase,request,pid:process.pid,...extra})+'\n');
async function connectControl() {
 if (control) return;
 control = connect(port,'127.0.0.1'); await new Promise((ok,bad)=>{control.once('connect',ok);control.once('error',bad)});
 gates=createInterface({input:control}); gate=gates[Symbol.asyncIterator]();
}
async function mcp(method, params = {}, id = 1, signal) {
 const response = await fetch(server.url, {method:'POST',headers:{'authorization':server.authorization,'content-type':'application/json','accept':'application/json, text/event-stream','mcp-protocol-version':'2025-03-26'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal});
 if (!response.ok) return {isError:true,content:[{type:'text',text:JSON.stringify({message:`HTTP ${response.status}`})}]};
 let text=await response.text();
 const value = text.startsWith('event:') || text.startsWith('data:') ? JSON.parse(text.split('\n').find(line=>line.startsWith('data:')).slice(5)) : JSON.parse(text);
 return value.result ?? {isError:true,content:[{type:'text',text:JSON.stringify(value.error)}]};
}
function output(text) {
 if (claude) append({type:'assistant',uuid:crypto.randomUUID(),message:{id:crypto.randomUUID(),content:[{type:'text',text}]}});
 else if (agy) event('session/update',{sessionId:thread,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});
 else event('item/agentMessage/delta',{threadId:thread,turnId:turn,itemId:'answer',delta:text});
}
function terminal(cancelled=false) {
 if (claude) { if (!cancelled) append({type:'system',subtype:'turn_duration',durationMs:1}); }
 else if(agy) reply(promptId,{stopReason:cancelled?'cancelled':'end_turn'});
 else event('turn/completed',{threadId:thread,turn:{id:turn,status:cancelled?'interrupted':'completed'}});
}
async function cancel() {
 if (interrupted) return; interrupted=true;
 if (control && !activePlan?.expectCancel) { if(activePlan?.earlyTerminal) trace('cancelled_tools'); trace('terminal'); }
 terminal(true);
}
async function prompt() {
 await connectControl();
 await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'native-fixture',version:'1'}});
 request.tools=(await mcp('tools/list')).tools ?? [];
 trace('opened');
 let first=(await gate.next()).value, plan;
 try{plan=JSON.parse(first)}catch{}
 activePlan=plan;
 if(plan?.calls) {
  const calls=plan.calls.map(async call=>{
   const signal=new AbortController();
   const work=mcp('tools/call',{name:call.name,arguments:call.input},call.callId+10,signal.signal);
   if(plan.cancelCalls) setTimeout(()=>signal.abort(),25);
   const result=await work.catch(()=>({isError:true,content:[{type:'text',text:'client cancelled'}]}));
   trace('tool_result',{reply:{callId:call.callId,result}});
  });
  trace('responsive');
  if (plan.earlyTerminal) { await new Promise(resolve=>{const poll=setInterval(()=>{if(interrupted){clearInterval(poll);resolve()}},5)}); await gate.next(); process.exit(0); }
  await Promise.all(calls);
  if(plan.expectCancel) { await new Promise(resolve=>{const poll=setInterval(()=>{if(interrupted){clearInterval(poll);resolve()}},5)}); trace('cancelled_tools');trace('terminal'); await gate.next(); return; }
 }
 output('committed output');
 trace('output');
 if(request.message==='wait') return;
 await gate.next();
 if(request.message==='crash' || request.message==='exit0') process.exit(request.message==='exit0'?0:3);
 if(request.message==='malformed') {process.stdout.write('{bad json}\n');return;}
 if(request.message==='pipe-holder-crash') {
  const escaped=spawn(process.execPath,['-e',`process.stdout.on('error',()=>{});setTimeout(()=>process.exit(0),120000); setInterval(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'item/agentMessage/delta',params:{threadId:'native-fixture-session',turnId:'fixture-turn',itemId:'x',delta:'escaped'}})+'\\n'),10)`],{detached:true,stdio:['ignore','inherit','ignore']});
  await new Promise(ok=>escaped.once('spawn',ok));escaped.unref();trace('escaped',{pid:escaped.pid});process.exit(3);
 }
 trace('terminal');
 await gate.next();
 if(request.message==='wrong-turn') {event('turn/completed',{threadId:thread,turn:{id:'historical-turn',status:'completed'}});process.exit(0);}
 if (claude && request.message==='blocked-stop') { append({type:'system',subtype:'stop_hook_summary'}); output('after blocked Stop'); }
 terminal();
}
let transcript;
function append(row){appendFileSync(transcript,JSON.stringify({sessionId:thread,...row})+'\n')}
if (claude) {
 if(args.some(a=>a==='-p'||a==='--print')) throw Error('interactive PTY required');
 thread=args[args.indexOf(args.includes('--resume')?'--resume':'--session-id')+1];
 const cwd=realpathSync(process.cwd()), project=cwd.replace(/[^a-zA-Z0-9]/g,'-');
 const directory=join(process.env.CLAUDE_CONFIG_DIR,'projects',project);mkdirSync(directory,{recursive:true});
 transcript=join(directory,thread+'.jsonl');
 server=JSON.parse((await import('node:fs')).readFileSync(args[args.indexOf('--mcp-config')+1],'utf8')).mcpServers.maka;server.authorization=server.headers.Authorization;
 request={message:args.at(-1),images:[],...(args.includes('--resume')?{resume:thread}:{})};
 append({type:'user',uuid:crypto.randomUUID(),message:{content:request.message}});
 process.stdin.setRawMode(true);process.stdin.on('data',bytes=>{if(bytes.includes(27))void cancel()});
 void prompt();
} else {
 const lines=createInterface({input:process.stdin});
 lines.on('line',async line=>{
  const value=JSON.parse(line),p=value.params??{},id=value.id,m=value.method;
  if(m==='initialize'){reply(id,agy?{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},_meta:{antigravity:{systemPrompt:{append:true}}}},agentInfo:{name:'fixture',version:'1.5.0'}}:{userAgent:'fixture'});}
  else if(m==='initialized'){}
  else if(m==='model/list'){reply(id,{data:Array.from({length:20},(_,i)=>({id:`external-${i}`,displayName:`External ${i}`,supportedReasoningEfforts:[{reasoningEffort:'vendor-deep'}],defaultReasoningEffort:'vendor-deep'}))});}
  else if(m==='account/read'){reply(id,{account:{type:'apiKey'}});}
  else if(['thread/start','thread/resume','session/new','session/load'].includes(m)){
   opened=p;
   thread=p.threadId??p.sessionId??thread;
   const s=agy?p.mcpServers?.[0]:p.config?.mcp_servers?.maka;
   if(s)server={url:s.url,authorization:agy?s.headers.find(h=>h.name==='Authorization').value:`Bearer ${process.env[s.bearer_token_env_var]}`};
   if(server && process.env.MAKA_NATIVE_PREOPEN_PROBE) {
    await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'native-fixture',version:'1'}});
    const premature=await mcp('tools/call',{name:'__before_identity__',arguments:{}});
    if(JSON.parse(premature.content[0].text).code!==-32600) throw Error('Host call admitted before native identity persistence');
   }
   if(args.includes('--hold-open')){await connectControl();trace('before_opened');await gate.next();}
   reply(id,agy?{sessionId:thread,modes:{currentModeId:'default',availableModes:[{id:'yolo',name:'YOLO'}]},configOptions:[{id:'mode',currentValue:'default',options:[{value:'yolo',name:'YOLO'}]},{id:'model',category:'model',currentValue:'fixture-model',options:[{value:'fixture-model',name:'Fixture'}]},{id:'thought_level',category:'thought_level',currentValue:'vendor-deep',options:[{value:'vendor-deep',name:'Deep'}]}]}:{thread:{id:thread},approvalPolicy:p.approvalPolicy,sandbox:{type:p.sandbox==='danger-full-access'?'dangerFullAccess':p.sandbox},model:p.model??'fixture-model'});
  }
  else if(m==='session/set_mode'){if(p.modeId!=='yolo')throw Error('missing yolo');reply(id,{});}
  else if(m==='session/set_config_option'){reply(id,{configOptions:[{id:p.configId,currentValue:p.value},{id:'model',category:'model',currentValue:'fixture-model',options:[{value:'fixture-model'}]},{id:'thought_level',category:'thought_level',currentValue:'vendor-deep',options:[{value:'vendor-deep'}]}]});}
  else if(m==='turn/start'||m==='session/prompt') {
   if(!agy && (p.approvalPolicy!=='never'||p.sandboxPolicy.type!=='dangerFullAccess'))throw Error('missing maximum turn permission');
   promptId=id;
   request={message:agy?p.prompt[0].text:p.input[0].text,effort:p.effort??'vendor-deep',images:agy?[]:p.input.filter(v=>v.type==='localImage').map(v=>({path:v.path,mediaType:'image/png'})),...(opened.threadId||opened.sessionId?{resume:thread}:{})};
   if(!agy)reply(id,{turn:{id:turn,status:'inProgress'}});
   void prompt();
  }
  else if(m==='turn/interrupt'||m==='session/cancel'){if(id)reply(id,{});void cancel();}
  else reply(id,{});
 });
 lines.on('close',()=>process.exit(0));
}
