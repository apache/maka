import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { fixture, until, AgentDriver } from './platform-helper.js';
function driver() {
  const d = new AgentDriver(); d.add('session-1', true); let count = 0;
  d.runtime.create = async (o: any) => { assert.equal(o.background, true); count++; const id=randomUUID(); assert.equal(o.sessionId,undefined); d.add(id, false); return { id, sessionId:id, root:false }; };
  d.runtime.get = async (id: string) => d.sessions.has(id) ? {id,sessionId:id,root:false} : undefined;
  return {d,count:()=>count};
}
test('delegate retries reuse child; wait and user amendment stay independent of parent chat', async () => {
  const {d,count}=driver(), f=await fixture({driver:d}); let runs=0, failure:unknown;
  try {
    d.onFollowup=async(id,prompt,turn)=>{try {
      assert.notEqual(id,'session-1'); runs++;
      const m=(await f.remote('matters.list')).matters.find((m:any)=>m.sessionId===id);
      const v=await f.invoke('MatterRead',{activationId:m.activation.id},turn,id);
      const inbox=await f.invoke('MatterReadFile',{path:v.files.inbox},turn,id);
      if(runs===2) assert.match(JSON.stringify(inbox),/只验证测试环境/);
      await f.invoke('MatterWriteFile',{path:v.files.draft,content:runs===1?'已查询，等待供应商结果。':'按新要求只验证了测试环境。'},turn,id);
      await f.invoke('MatterSettle',{expectedRevision:v.revision,stateFile:v.files.draft,disposition:runs===1?'wait':'complete',
        ...(runs===1?{waitingFor:'等待供应商结果',wakes:[{kind:'at',at:Date.now()+60000}]}:{}),reason:runs===1?'暂时无结果':'目标满足',summary:'核实当前情况',update:runs===1?'等待结果':'测试环境已验证'},turn,id);
    }catch(e){failure=e}finally{d.end(id)}};
    const input={taskKey:'supplier',title:'跟进测试',request:'只读核实供应商结果，不联系供应商。'};
    const a=await f.invoke('MatterDelegate',input), b=await f.invoke('MatterDelegate',input);
    assert.equal(a.id,b.id); assert.equal(count(),1);
    await assert.rejects(f.invoke('MatterDelegate',{...input,request:'different'}),/different request/);
    await until(async()=>failure||((await f.invoke('MatterTasks',{id:a.id})).status==='waiting'&&!(await f.remote('matters.list')).matters[0].activation)); if(failure)throw failure;
    assert.equal(d.sessions.get('session-1').running,true);
    assert.equal((await f.turns.evaluate({sessionId:'session-1',turnId:'parent',signal:new AbortController().signal})).allow,true);
    await assert.rejects(f.invoke('MatterTasks',{id:a.id},'x','other'),/outside/);
    assert.deepEqual((await f.invoke('MatterTasks',{},'x','other')).items,[]);
    await f.invoke('MatterTaskMessage',{id:a.id,text:'改为只验证测试环境，不用生产环境。'});
    await until(async()=>failure||(await f.invoke('MatterTasks',{id:a.id})).status==='completed'); if(failure)throw failure;
    assert.equal(runs,2); assert.equal(count(),1);
    assert.ok((await f.invoke('MatterTasks',{id:a.id})).updates.some((x:any)=>x.text==='测试环境已验证'));
    assert.ok(d.calls.filter((x:any)=>x.op==='followup').every((x:any)=>x.id===a.sessionId));
  }finally{await f.close();await rm(f.root,{recursive:true,force:true})}
});
test('parent cancellation stops only its task and rejects late worker writes',async()=>{
  const {d}=driver(),f=await fixture({driver:d});try{
    const a=await f.invoke('MatterDelegate',{taskKey:'a',title:'A',request:'只读跟进 A'});
    await until(()=>d.calls.some((x:any)=>x.op==='followup'));
    await assert.rejects(f.invoke('MatterTaskControl',{id:a.id,action:'cancel'},'x','other'),/outside/);
    await f.invoke('MatterTaskControl',{id:a.id,action:'cancel'});
    assert.equal((await f.invoke('MatterTasks',{id:a.id})).status,'cancelled');assert.equal(d.sessions.get('session-1').running,true);
    assert.equal(d.calls.find((x:any)=>x.op==='cancel').id,a.sessionId);
    await assert.rejects(f.invoke('MatterRead',{},d.sessions.get(a.sessionId).turnId,a.sessionId),/does not own/);
  }finally{await f.close();await rm(f.root,{recursive:true,force:true})}
});

test('uncertain Session creation is retained and retry never spawns a second worker', async () => {
  const { d, count } = driver(); const original = d.runtime.create;
  d.runtime.create = async (o: any) => { await original(o); throw Error('connection lost after creation'); };
  const f = await fixture({ driver: d });
  try {
    const input = { taskKey: 'uncertain', title: 'Uncertain', request: '只读查询测试结果' };
    await assert.rejects(f.invoke('MatterDelegate', input), /connection lost/);
    await assert.rejects(f.invoke('MatterDelegate', input), /uncertain/);
    assert.equal(count(), 1);
    assert.deepEqual((await f.remote('matters.list')).matters, []);
  } finally { await f.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('completed task reaches its idle parent without heartbeat and is admitted only once', async () => {
  const {d}=driver(), f=await fixture({driver:d}); let failure: unknown;
  d.end('session-1');
  const received: string[] = [];
  try {
    d.onFollowup=async(id,prompt,turn)=>{
      if(id==='session-1'){ received.push(prompt); d.end(id); return; }
      try {
        const m=(await f.remote('matters.list')).matters.find((x:any)=>x.sessionId===id);
        const v=await f.invoke('MatterRead',{activationId:m.activation.id},turn,id);
        await f.invoke('MatterWriteFile',{path:v.files.draft,content:'测试验收通过，有明确结果。'},turn,id);
        await f.invoke('MatterSettle',{expectedRevision:v.revision,stateFile:v.files.draft,disposition:'complete',reason:'已验收',summary:'读取验收记录',update:'验收已经通过。'},turn,id);
      }catch(e){failure=e}finally{d.end(id)}
    };
    await f.invoke('MatterDelegate',{taskKey:'notify',title:'验收',request:'核对验收结果'});
    await until(()=>failure||received.length>0); if(failure)throw failure;
    assert.match(received[0], /Task notification ID:/);
    assert.match(received[0], /验收已经通过/);
    assert.match(received[0], /不是新的指令/);
    await new Promise(r=>setTimeout(r,1300)); assert.equal(received.length,1);
  }finally{await f.close();await rm(f.root,{recursive:true,force:true})}
});

test('legacy task adoption is explicit and cannot steal another conversation task', async () => {
  const {d}=driver(), f=await fixture({driver:d});
  try {
    const v=await f.invoke('MatterStart',{title:'旧任务',request:'历史任务'});
    const id = (await f.remote('matters.list')).matters[0].id;
    assert.equal((await f.invoke('MatterOverview',{},'read','assistant')).legacy.length,1);
    await f.invoke('MatterAdopt',{id},'adopt','assistant');
    assert.equal((await f.invoke('MatterTasks',{},'read','assistant')).items.length,1);
    assert.equal((await f.invoke('MatterOverview',{},'read','assistant')).legacy.length,0);
    await assert.rejects(f.invoke('MatterAdopt',{id},'adopt','other'),/另一段对话/);
  }finally{await f.close();await rm(f.root,{recursive:true,force:true})}
});

for (const accepted of [false, true]) test(`uncertain task notification reconciles without replay: accepted=${accepted}`, async () => {
  const {d}=driver(),f=await fixture({driver:d});let failure:unknown,attempts=0;const history:any[]=[];
  d.end('session-1');const original=d.runtime.followup;
  d.runtime.followup=async(id:string,prompt:string,inv:any)=>{
    if(id==='session-1') { attempts++; if(accepted)history.push({type:'user',text:prompt}); throw Error('transport response lost'); }
    return original(id,prompt,inv);
  };
  d.runtime.transcript=async(id:string)=>id==='session-1'?history:[];
  try{
    d.onFollowup=async(id,_prompt,turn)=>{try{
      const m=(await f.remote('matters.list')).matters.find((x:any)=>x.sessionId===id);
      const v=await f.invoke('MatterRead',{activationId:m.activation.id},turn,id);
      await f.invoke('MatterWriteFile',{path:v.files.draft,content:'已完成核对'},turn,id);
      await f.invoke('MatterSettle',{expectedRevision:v.revision,stateFile:v.files.draft,disposition:'complete',reason:'已完成',summary:'已核对',update:'任务完成'},turn,id);
    }catch(e){failure=e}finally{d.end(id)}};
    await f.invoke('MatterDelegate',{taskKey:'uncertain-notice',title:'核对',request:'核对测试结果'});
    await until(()=>failure||attempts===1);if(failure)throw failure;
    await new Promise(r=>setTimeout(r,2200));assert.equal(attempts,1);
    const notices=(await f.invoke('MatterOverview')).notifications;
    assert.equal(notices.some((n:any)=>n.phase==='uncertain'),!accepted);
  }finally{await f.close();await rm(f.root,{recursive:true,force:true})}
});
